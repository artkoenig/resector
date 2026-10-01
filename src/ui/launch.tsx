// Startup: read the config (or run the first-start setup), open a new or resumed session, then show the Gate.
import { join, resolve } from 'node:path';
import { createSignal, onMount, Show } from 'solid-js';
import { connect } from '../adapters/backend/connect';
import { discover, LOCAL_SERVERS, type DiscoveredModel, type LocalServer } from '../adapters/backend/discover';
import { createRunner } from '../adapters/bash/runner';
import { createSearcher } from '../adapters/search/ddgr';
import { createSplit } from '../adapters/bash/split';
import { loadConfig, writeInitialConfig, type ConfigPaths } from '../adapters/fs/config';
import { ensureWorktree, isRepository, listBranches, locateCheckout, mainCheckout, topLevel, removeWorktree, status, switchBranch, watchHead, worktreeDirty } from '../adapters/git/git';
import { loadPolicies } from '../adapters/fs/policies';
import { listProjectFiles, probeEnvironment, projectFiles, projectInstructions, tilde } from '../adapters/fs/project';
import type { OpenSession, SessionStore } from '../adapters/store/sessions';
import type { Split } from '../core/approval/approval';
import type { Editor } from '../gate/ports';
import type { SessionEvent } from '../core/log/events';
import { fold } from '../core/log/fold';
import { environmentText } from '../core/notes/environment';
import { BUILT_IN, DEFAULT_POLICY } from '../core/policy/built-in';
import type { Policy } from '../core/policy/policy';
import { checkoutOf, inWorktree, newSession, summarize, type SessionRef } from '../core/session/session';
import { App } from './app';
import { errorText } from '../gate/text';
import type { AutoApprove, Clipboard, GateOptions, Git, Policies, Status } from '../gate';
import { Sessions } from './sessions';
import { Setup } from './setup';

export type LaunchOptions = {
  paths: ConfigPaths;
  servers?: LocalServer[];
  store: SessionStore;
  // The checkout started in: where new sessions run unless in their worktree; default the working directory.
  cwd?: string;
  // $EDITOR for `e`, and on a file itself (`e` on an @path reference).
  editor: Editor;
  openFile: (file: string) => Promise<void>;
  // Copy on select.
  clipboard: Clipboard;
  // -c [id]: true = the last session.
  resume?: SessionRef;
  onQuit: () => void;
  onFatal: (message: string) => void;
};

type Loaded = NonNullable<ReturnType<typeof loadConfig>>;

const DEFAULT_TIMEOUT = 120;
// A search runs into this timeout (seconds).
const SEARCH_TIMEOUT = 30;

export function Launch(props: LaunchOptions) {
  const [found, setFound] = createSignal<DiscoveredModel[] | null>(null);
  const [gate, setGate] = createSignal<GateOptions | null>(null);
  const [view, setView] = createSignal<'gate' | 'sessions'>('gate');
  let session: OpenSession | null = null;
  // tree-sitter-bash, loaded once.
  let split: Split | undefined;
  const [current, setCurrent] = createSignal('');
  // Context Policies (ADR 0001), loaded at start: the active one belongs to the app, it stays when switching sessions.
  const [active, setActive] = createSignal<Policy | null>(null);
  const policies: Policies = { all: [], active, set: setActive };
  // Auto-approve belongs to the app like the active policy: off at start, kept when switching sessions.
  const [autoOn, setAutoOn] = createSignal(false);
  const autoApprove: AutoApprove = { on: autoOn, set: setAutoOn };
  // Policies that failed to load, reported once in the first status line.
  let failed: string[] = [];
  // The checkout started in (or its subdirectory), as a real path, so that sessions logged with it are found.
  const cwd = props.cwd ?? process.cwd();
  const here = locateCheckout(cwd, null) ?? cwd;
  const repository = isRepository(here);
  const project = mainCheckout(here);
  // Session Worktrees live in the Project Home's data root (ADR 0004).
  const worktrees = join(props.paths.projectHome.data, 'worktrees');
  // The project as seen from where a session runs: its checkout or its worktree.
  const projectAt = (dir: string, checkout = here) => ({
    read: projectFiles(dir),
    list: () => listProjectFiles(dir),
    environment: () => environmentText({ ...probeEnvironment(dir), worktree: dir !== checkout }),
    open: (path: string) => props.openFile(resolve(dir, path)),
  });

  const load = () => {
    const loaded = loadConfig(props.paths);
    if (!loaded) throw new Error(`no config at ${props.paths.global}`);
    return loaded;
  };
  // The config as read when the session was opened.
  let config: Loaded;
  // Compaction runs on the profile's compactionProfile, else on the session's own backend (null). Its own slot
  // where the server has several, so the session cache stays.
  const compactor = (name: string, session: string) => async () => {
    const other = config.profile(name).compactionProfile;
    return other && other !== name ? { profile: other, backend: await connect(config.profile(other), `${session}:compaction`) } : null;
  };

  function create(loaded: Loaded) {
    const opened = props.store.create();
    const profile = loaded.profile();
    // The project instructions are read once, now.
    const events = newSession(profile.name, loaded.systemPrompt(profile), {
      environment: projectAt(here).environment(),
      // From the checkout's top level, also when started in a subdirectory.
      instructions: projectInstructions(topLevel(here), props.paths.projectHome.config),
      checkout: here,
    });
    events.forEach(opened.log.append);
    // A new session starts with the configured policy on (lean-compact unless set, none with `off`); when resumed, the app's stays.
    const name = loaded.config.defaultPolicy ?? DEFAULT_POLICY;
    const policy = name === 'off' ? null : policies.all.find(p => p.name === name);
    if (policy) setActive(policy);
    const notice = policy === undefined ? { text: `new session · defaultPolicy ${name} – no such policy`, tone: 'warn' as const } : { text: 'new session', tone: 'ok' as const };
    return { opened, events, notice };
  }

  // Resume = replay; a Model Profile missing from the config falls back to the default one.
  function resume(loaded: Loaded, which: SessionRef) {
    const opened = props.store.open(which);
    const events: SessionEvent[] = [...opened.events];
    const texts = [`resumed "${summarize(events).title}"`];
    const { profile } = fold(events);
    if (!(profile in loaded.config.profiles)) {
      const fallback: SessionEvent = { type: 'ProfileFallback', profile: loaded.profile().name };
      opened.log.append(fallback);
      events.push(fallback);
      texts.push(`profile "${profile}" not in config → ${fallback.profile}`);
    }
    return { opened, events, notice: { text: texts.join(' · '), tone: texts.length > 1 ? ('warn' as const) : ('ok' as const) } };
  }

  // which: a session to resume, else a new session; a new one is dropped again if its backend fails.
  async function open(loaded: Loaded, which: SessionRef | undefined) {
    split ??= await createSplit();
    const { opened, events, notice } = which ? resume(loaded, which) : create(loaded);
    const profile = fold(events).profile;
    const backend = await connect(loaded.profile(profile), opened.id).catch(e => {
      opened.release();
      if (!which) props.store.delete(opened.id);
      throw e;
    });
    config = loaded;
    if (session?.id !== opened.id) session?.release();
    session = opened;
    setCurrent(opened.id);
    setFound(null);
    const { dir, checkout, warning } = sessionDir(events, opened.id);
    const instruction = () => config.compactionInstruction();
    setGate({ backend, ...runningIn(dir, checkout, opened.id), editor: props.editor, clipboard: props.clipboard, log: opened.log, events, notice: withFailed(withWarning(notice, warning)), openSessions: () => setView('sessions'), instruction, compactor: compactor(profile, opened.id), policies, autoApprove });
  }
  // The checkout the session started in, from any worktree of the Project; the current one if that is gone, or for
  // older logs that name none.
  function checkoutFor(events: SessionEvent[]): { checkout: string; warning: string | null } {
    const started = checkoutOf(events);
    const now = started ? locateCheckout(started, project) : here;
    return now ? { checkout: now, warning: null } : { checkout: here, warning: `checkout ${tilde(started!)} gone – runs in ${tilde(here)}` };
  }
  // Where the session runs: its worktree, created again if it is gone; its checkout if that fails.
  function sessionDir(events: SessionEvent[], id: string): { dir: string; checkout: string; warning: string | null } {
    const { checkout, warning } = checkoutFor(events);
    if (!repository || !inWorktree(events)) return { dir: checkout, checkout, warning };
    try {
      return { dir: ensureWorktree(checkout, worktrees, id), checkout, warning };
    } catch (e) {
      return { dir: checkout, checkout, warning: `worktree: ${errorText(e)} – runs in ${checkout}` };
    }
  }
  // What depends on where the session runs: bash and search, the arguments' root, the project, git.
  function runningIn(dir: string, checkout: string, id: string): Pick<GateOptions, 'runner' | 'searcher' | 'approval' | 'project' | 'git'> {
    const git: Git = {
      branches: () => listBranches(dir),
      status: () => status(dir),
      switchBranch: name => switchBranch(dir, name),
      watch: onChange => watchHead(dir, onChange),
      worktree: on => (on ? ensureWorktree(checkout, worktrees, id) : checkout),
      // The Gate again, running in the session's directory now; its events as logged.
      reopen: notice => {
        const events = props.store.read(id);
        const at = sessionDir(events, id);
        setGate({ ...gate()!, ...runningIn(at.dir, at.checkout, id), events, notice });
      },
    };
    return {
      runner: createRunner({ cwd: dir, timeout: config.config.bash?.timeout ?? DEFAULT_TIMEOUT }),
      searcher: createSearcher({ cwd: dir, timeout: SEARCH_TIMEOUT }),
      approval: { split: split!, root: dir, permissions: () => config.permissions },
      project: projectAt(dir, checkout),
      git: repository ? git : null,
    };
  }
  const withWarning = (notice: Status, warning: string | null): Status => (warning ? { text: `${notice.text} · ${warning}`, tone: 'warn' } : notice);
  function withFailed(notice: Status): Status {
    const text = failed.map(f => `policy ${f} – not loaded`);
    failed = [];
    return text.length ? { text: [notice.text, ...text].join(' · '), tone: 'warn' } : notice;
  }

  // /sessions: switching sessions reconnects; the Gate comes back with the session's logged events.
  const switchTo = (which?: string) => open(load(), which).then(() => void setView('gate'));
  const back = () => {
    const events = props.store.read(current());
    setGate({ ...gate()!, events, notice: undefined });
    setView('gate');
  };
  // Deleting the current session first switches to the newest other one, or a new empty session. Its worktree goes
  // first, with its uncommitted changes only when the user confirmed them (force); its branch only if merged.
  async function remove(id: string, force: boolean): Promise<string> {
    const titleOf = (id: string) => summarize(props.store.read(id)).title;
    const title = titleOf(id);
    const switched = id === current();
    if (switched) await open(load(), props.store.list().find(s => !s.locked && s.id !== id)?.id);
    const kept = removeWorktreeOf(id, force);
    props.store.delete(id);
    return [`deleted "${title}"`, ...(switched ? [`switched to "${titleOf(current())}"`] : []), ...kept].join(' · ');
  }
  // The status text for an unmerged branch kept; none outside a repository.
  function removeWorktreeOf(id: string, force: boolean): string[] {
    const removed = repository ? removeWorktree(here, worktrees, id, force) : null;
    return removed?.kept ? [`branch ${removed.branch} kept – not merged`] : [];
  }
  // Where a listed session started, when that is another checkout of the Project: its branch and directory.
  function origin(events: SessionEvent[]): string | null {
    const started = checkoutOf(events);
    if (!started) return null;
    const now = locateCheckout(started, project);
    if (now === here) return null;
    if (!now) return `${tilde(started)} (gone)`;
    const { branch } = probeEnvironment(now);
    return `${branch ? `⎇ ${branch} in ` : ''}${tilde(now)}`;
  }
  const rename = (id: string, title: string) => {
    const event: SessionEvent = { type: 'SessionRenamed', title };
    if (id === current()) session!.log.append(event);
    else props.store.append(id, event);
  };
  const windowOf = (profile: string) => {
    const options = gate();
    if (options && profile === fold(options.events).profile) return options.backend.window;
    return load().config.profiles[profile]?.window;
  };

  async function firstStart() {
    const models = await discover(props.servers ?? LOCAL_SERVERS);
    if (!models.length)
      throw new Error(`no model server found on localhost:8080 (llama.cpp), :11434 (Ollama), :1234 (LM Studio, oMLX): start one or write ${props.paths.global}`);
    setFound(models);
  }

  const fail = (e: unknown) => props.onFatal(errorText(e));
  const quit = () => {
    session?.release();
    props.onQuit();
  };
  const choose = (model: DiscoveredModel) => {
    writeInitialConfig(props.paths, model);
    open(load(), undefined).catch(fail);
  };

  onMount(() => {
    const start = async () => {
      ({ policies: policies.all, failed } = await loadPolicies(props.paths.policies, BUILT_IN));
      const loaded = loadConfig(props.paths);
      return loaded ? open(loaded, props.resume) : firstStart();
    };
    start().catch(fail);
  });

  return (
    <>
      <Show when={found()}>{(models: () => DiscoveredModel[]) => <Setup found={models()} configPath={props.paths.global} onChoose={choose} onQuit={quit} />}</Show>
      <Show when={view() === 'gate' && gate()} keyed>
        {(options: GateOptions) => <App {...options} onQuit={quit} />}
      </Show>
      <Show when={view() === 'sessions'}>
        <Sessions
          store={props.store}
          current={current}
          profiles={Object.keys(load().config.profiles)}
          windowOf={windowOf}
          open={id => (id === current() ? Promise.resolve(back()) : switchTo(id))}
          create={() => switchTo()}
          remove={remove}
          worktreeDirty={id => repository && worktreeDirty(worktrees, id)}
          origin={s => origin(s.events)}
          rename={rename}
          back={back}
        />
      </Show>
    </>
  );
}

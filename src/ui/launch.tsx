// Startup: read the config (or run the first-start setup), open a new or resumed session, then show the Gate.
import { resolve } from 'node:path';
import { createSignal, onMount, Show } from 'solid-js';
import { connect } from '../adapters/backend/connect';
import { discover, LOCAL_SERVERS, type DiscoveredModel, type LocalServer } from '../adapters/backend/discover';
import { createRunner } from '../adapters/bash/runner';
import { createSearcher } from '../adapters/search/ddgr';
import { createSplit } from '../adapters/bash/split';
import type { Clipboard } from '../adapters/clipboard/clipboard';
import { loadConfig, writeInitialConfig, type ConfigPaths } from '../adapters/fs/config';
import { ensureWorktree, isRepository, listBranches, switchBranch, watchHead } from '../adapters/git/git';
import { loadPolicies, policiesDir } from '../adapters/fs/policies';
import { listProjectFiles, personalInstructionsDir, probeEnvironment, projectFiles, projectInstructions } from '../adapters/fs/project';
import type { OpenSession, SessionStore } from '../adapters/store/sessions';
import type { Split } from '../core/approval/approval';
import type { Editor } from '../core/context/operations';
import type { SessionEvent } from '../core/log/events';
import { fold } from '../core/log/fold';
import { environmentText } from '../core/notes/environment';
import { BUILT_IN } from '../core/policy/built-in';
import type { Policy } from '../core/policy/policy';
import { inWorktree, newSession, summarize, type SessionRef } from '../core/session/session';
import { App } from './app';
import { errorText } from './format';
import type { AutoApprove, GateOptions, Git, Policies, Status } from './gate';
import { Sessions } from './sessions';
import { Setup } from './setup';

export type LaunchOptions = {
  paths: ConfigPaths;
  servers?: LocalServer[];
  store: SessionStore;
  // Project root: where bash runs (FR-21) unless the session runs in its worktree; default the working directory.
  cwd?: string;
  // $EDITOR for `e` (FR-8), and on a file itself (`e` on an @path reference, FR-27).
  editor: Editor;
  openFile: (file: string) => Promise<void>;
  // Copy on select.
  clipboard: Clipboard;
  // -c [id]: true = the last session (FR-32).
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
  // tree-sitter-bash, loaded once (FR-22).
  let split: Split | undefined;
  const [current, setCurrent] = createSignal('');
  // Context Policies (ADR 0001, FR-53), loaded at start: the active one belongs to the app, it stays when switching sessions.
  const [active, setActive] = createSignal<Policy | null>(null);
  const policies: Policies = { all: [], active, set: setActive };
  // Auto-approve (FR-23) belongs to the app like the active policy: off at start, kept when switching sessions.
  const [autoOn, setAutoOn] = createSignal(false);
  const autoApprove: AutoApprove = { on: autoOn, set: setAutoOn };
  // Policies that failed to load, reported once in the first status line.
  let failed: string[] = [];
  const root = props.cwd ?? process.cwd();
  const repository = isRepository(root);
  // The project as seen from where a session runs: the project root or its worktree.
  const projectAt = (dir: string) => ({
    read: projectFiles(dir), list: () => listProjectFiles(dir), environment: () => environmentText(probeEnvironment(dir)), open: (path: string) => props.openFile(resolve(dir, path)),
  });

  const load = () => {
    const loaded = loadConfig(props.paths);
    if (!loaded) throw new Error(`no config at ${props.paths.global}`);
    return loaded;
  };
  // The config as read when the session was opened (FR-44).
  let config: Loaded;
  // Compaction runs on the profile's compactionProfile, else on the session's own backend (null, FR-17). Its own slot
  // where the server has several, so the session cache stays.
  const compactor = (name: string, session: string) => async () => {
    const other = config.profile(name).compactionProfile;
    return other && other !== name ? { profile: other, backend: await connect(config.profile(other), `${session}:compaction`) } : null;
  };

  function create(loaded: Loaded) {
    const opened = props.store.create();
    const profile = loaded.profile();
    // The project instructions are read once, now (FR-29).
    const events = newSession(profile.name, loaded.systemPrompt(profile), { environment: projectAt(root).environment(), instructions: projectInstructions(root, personalInstructionsDir(props.paths, root)) });
    events.forEach(opened.log.append);
    // A new session starts with the configured policy on; without one, and when resumed, the app's stays.
    const name = loaded.config.defaultPolicy;
    const policy = name === undefined ? null : policies.all.find(p => p.name === name);
    if (policy) setActive(policy);
    const notice = policy === undefined ? { text: `new session · defaultPolicy ${name} – no such policy`, tone: 'warn' as const } : { text: 'new session', tone: 'ok' as const };
    return { opened, events, notice };
  }

  // Resume = replay; a Model Profile missing from the config falls back to the default one (FR-35).
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
    const { dir, warning } = sessionDir(events, opened.id);
    const instruction = () => config.compactionInstruction();
    setGate({ backend, ...runningIn(dir, opened.id), editor: props.editor, clipboard: props.clipboard, log: opened.log, events, notice: withFailed(withWarning(notice, warning)), openSessions: () => setView('sessions'), instruction, compactor: compactor(profile, opened.id), policies, autoApprove });
  }
  // Where the session runs: its worktree, created again if it is gone; the project root if that fails.
  function sessionDir(events: SessionEvent[], id: string): { dir: string; warning: string | null } {
    if (!repository || !inWorktree(events)) return { dir: root, warning: null };
    try {
      return { dir: ensureWorktree(root, id), warning: null };
    } catch (e) {
      return { dir: root, warning: `worktree: ${errorText(e)} – runs in ${root}` };
    }
  }
  // What depends on where the session runs: bash and search (FR-21), the arguments' root (FR-22), the project, git.
  function runningIn(dir: string, id: string): Pick<GateOptions, 'runner' | 'searcher' | 'approval' | 'project' | 'git'> {
    const git: Git = {
      branches: () => listBranches(dir),
      switchBranch: name => switchBranch(dir, name),
      watch: onChange => watchHead(dir, onChange),
      worktree: on => (on ? ensureWorktree(root, id) : root),
      // The Gate again, running in the session's directory now; its events as logged.
      reopen: notice => setGate({ ...gate()!, ...runningIn(sessionDir(props.store.read(id), id).dir, id), events: props.store.read(id), notice }),
    };
    return {
      runner: createRunner({ cwd: dir, timeout: config.config.bash?.timeout ?? DEFAULT_TIMEOUT }),
      searcher: createSearcher({ cwd: dir, timeout: SEARCH_TIMEOUT }),
      approval: { split: split!, root: dir, permissions: () => config.permissions },
      project: projectAt(dir),
      git: repository ? git : null,
    };
  }
  const withWarning = (notice: Status, warning: string | null): Status => (warning ? { text: `${notice.text} · ${warning}`, tone: 'warn' } : notice);
  function withFailed(notice: Status): Status {
    const text = failed.map(f => `policy ${f} – not loaded`);
    failed = [];
    return text.length ? { text: [notice.text, ...text].join(' · '), tone: 'warn' } : notice;
  }

  // /sessions (FR-33): switching sessions reconnects; the Gate comes back with the session's logged events.
  const switchTo = (which?: string) => open(load(), which).then(() => void setView('gate'));
  const back = () => {
    const events = props.store.read(current());
    setGate({ ...gate()!, events, notice: undefined });
    setView('gate');
  };
  // Deleting the current session first switches to the newest other one, or a new empty session.
  async function remove(id: string): Promise<string> {
    const titleOf = (id: string) => summarize(props.store.read(id)).title;
    const title = titleOf(id);
    const switched = id === current();
    if (switched) await open(load(), props.store.list().find(s => !s.locked && s.id !== id)?.id);
    props.store.delete(id);
    return `deleted "${title}"` + (switched ? ` · switched to "${titleOf(current())}"` : '');
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
      ({ policies: policies.all, failed } = await loadPolicies(policiesDir(props.paths), BUILT_IN));
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
          rename={rename}
          back={back}
        />
      </Show>
    </>
  );
}

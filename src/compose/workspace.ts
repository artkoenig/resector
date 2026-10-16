// The app's wiring outside any view: config and Context Policies, opening a new or resumed session, where it runs
// (checkout or Session Worktree) and the ports for it. Shared by the TUI and runs without it.
import { join, resolve } from 'node:path';
import { createSignal } from 'solid-js';
import { connect } from '../adapters/backend/connect';
import { createRunner } from '../adapters/bash/runner';
import { createSplit } from '../adapters/bash/split';
import { loadConfig, type ConfigPaths } from '../adapters/fs/config';
import { loadPolicies } from '../adapters/fs/policies';
import { listProjectFiles, probeEnvironment, projectFiles, projectInstructions, tilde } from '../adapters/fs/project';
import { ensureWorktree, isRepository, listBranches, locateCheckout, mainCheckout, removeWorktree, status, switchBranch, topLevel, watchHead, worktreeDirty } from '../adapters/git/git';
import { createSearcher } from '../adapters/search/ddgr';
import type { SessionStore } from '../adapters/store/sessions';
import type { Split } from '../core/approval/approval';
import type { SessionEvent } from '../core/log/events';
import { fold } from '../core/log/fold';
import { environmentText } from '../core/notes/environment';
import { BUILT_IN, DEFAULT_POLICY } from '../core/policy/built-in';
import type { Policy } from '../core/policy/policy';
import type { Settings } from '../core/config/headless';
import { checkoutOf, inWorktree, newSession, summarize, type SessionRef } from '../core/session/session';
import type { AutoApprove, GateOptions, Git, Policies, Status } from '../gate';
import { errorText } from '../gate/text';

export type WorkspaceOptions = {
  paths: ConfigPaths;
  store: SessionStore;
  // The checkout started in: where new sessions run unless in their worktree; default the working directory.
  cwd?: string;
  // Opens a project file (`e` on an @path reference).
  openFile: (file: string) => Promise<void>;
  // The session runs elsewhere now (worktree switched): the options that changed, its events as logged.
  onReopen: (changed: Pick<GateOptions, Running | 'events' | 'notice'>) => void;
};

export type Loaded = NonNullable<ReturnType<typeof loadConfig>>;
type Running = 'runner' | 'searcher' | 'approval' | 'project' | 'git';
// What a view adds to the Gate's options.
type ViewOptions = 'editor' | 'clipboard' | 'openSessions';
// What a new session starts with instead of the config's defaults (a Headless Run's settings).
export type StartWith = Omit<Settings, 'show' | 'maxTurns'>;
export type Opened = { id: string; options: Omit<GateOptions, ViewOptions>; release: () => void };
export type Workspace = Awaited<ReturnType<typeof openWorkspace>>;

const DEFAULT_TIMEOUT = 120;
// A search runs into this timeout (seconds).
const SEARCH_TIMEOUT = 30;

// Loads the Context Policies once; the active policy and Auto-approve belong to the app, they stay when switching
// sessions.
export async function openWorkspace(options: WorkspaceOptions) {
  const { paths, store } = options;
  const [active, setActive] = createSignal<Policy | null>(null);
  const loadedPolicies = await loadPolicies(paths.policies, BUILT_IN);
  const policies: Policies = { all: loadedPolicies.policies, active, set: setActive };
  const [autoOn, setAutoOn] = createSignal(false);
  const autoApprove: AutoApprove = { on: autoOn, set: setAutoOn };
  // Policies that failed to load, reported once in the first status line.
  let failed = loadedPolicies.failed;
  // tree-sitter-bash, loaded once.
  let split: Split | undefined;
  // The checkout started in (or its subdirectory), as a real path, so that sessions logged with it are found.
  const cwd = options.cwd ?? process.cwd();
  const here = locateCheckout(cwd, null) ?? cwd;
  const repository = isRepository(here);
  const project = mainCheckout(here);
  // Session Worktrees live in the Project Home's data root (ADR 0004).
  const worktrees = join(paths.projectHome.data, 'worktrees');
  // The project as seen from where a session runs: its checkout or its worktree.
  const projectAt = (dir: string, checkout = here) => ({
    read: projectFiles(dir),
    list: () => listProjectFiles(dir),
    environment: () => environmentText({ ...probeEnvironment(dir), worktree: dir !== checkout }),
    open: (path: string) => options.openFile(resolve(dir, path)),
  });

  // Compaction runs on the profile's compactionProfile, else on the session's own backend (null). Its own slot
  // where the server has several, so the session cache stays.
  const compactor = (config: Loaded, name: string, session: string) => async () => {
    const other = config.profile(name).compactionProfile;
    return other && other !== name ? { profile: other, backend: await connect(config.profile(other), `${session}:compaction`) } : null;
  };

  function create(loaded: Loaded, start: StartWith | undefined) {
    const opened = store.create();
    const profile = loaded.profile(start?.profile);
    // The project instructions are read once, now.
    const events = newSession(profile.name, loaded.systemPrompt(profile), {
      environment: projectAt(here).environment(),
      // From the checkout's top level, also when started in a subdirectory.
      instructions: projectInstructions(topLevel(here), paths.projectHome.config),
      checkout: here,
      tools: start?.tools,
    });
    if (start?.thinking !== undefined) events.push({ type: 'ThinkingSet', thinking: start.thinking });
    if (start?.worktree) events.push({ type: 'WorktreeSet', on: true });
    events.forEach(opened.log.append);
    if (start) setAutoOn(start.autoApprove);
    // A new session starts with the configured policy on; when switched to, a resumed one keeps the app's.
    const missing = switchOnDefault(loaded, start?.policy);
    const notice = missing ? { text: `new session · ${missing}`, tone: 'warn' as const } : { text: 'new session', tone: 'ok' as const };
    return { opened, events, notice };
  }

  // The configured policy switched on (summary-reset unless set, none with `off`); why not, if no such policy.
  function switchOnDefault(loaded: Loaded, name = loaded.config.defaultPolicy ?? DEFAULT_POLICY): string | null {
    const policy = name === 'off' ? null : policies.all.find(p => p.name === name);
    if (policy) setActive(policy);
    return policy === undefined ? `defaultPolicy ${name} – no such policy` : null;
  }

  // Resume = replay; a Model Profile missing from the config falls back to the default one.
  // started: resumed at start (-c), so the app has no policy yet; it starts with the configured one, as a new session.
  function resume(loaded: Loaded, which: SessionRef, started: boolean) {
    const opened = store.open(which);
    const events: SessionEvent[] = [...opened.events];
    const texts = [`resumed "${summarize(events).title}"`];
    const missing = started && switchOnDefault(loaded);
    if (missing) texts.push(missing);
    const { profile } = fold(events);
    if (!(profile in loaded.config.profiles)) {
      const fallback: SessionEvent = { type: 'ProfileFallback', profile: loaded.profile().name };
      opened.log.append(fallback);
      events.push(fallback);
      texts.push(`profile "${profile}" not in config → ${fallback.profile}`);
    }
    return { opened, events, notice: { text: texts.join(' · '), tone: texts.length > 1 ? ('warn' as const) : ('ok' as const) } };
  }

  // which: a session to resume, else a new session (with start); a new one is dropped again if its backend fails.
  // started: at start.
  async function open(loaded: Loaded, which?: SessionRef, started = false, start?: StartWith): Promise<Opened> {
    split ??= await createSplit();
    const { opened, events, notice } = which ? resume(loaded, which, started) : create(loaded, start);
    const profile = fold(events).profile;
    const backend = await connect(loaded.profile(profile), opened.id).catch(e => {
      opened.release();
      if (!which) store.delete(opened.id);
      throw e;
    });
    const { dir, checkout, warning } = sessionDir(events, opened.id);
    const instruction = () => loaded.compactionInstruction();
    return {
      id: opened.id,
      release: opened.release,
      options: { backend, ...runningIn(loaded, dir, checkout, opened.id), log: opened.log, events, notice: withFailed(withWarning(notice, warning)), instruction, compactor: compactor(loaded, profile, opened.id), policies, autoApprove },
    };
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
  function runningIn(loaded: Loaded, dir: string, checkout: string, id: string): Pick<GateOptions, Running> {
    const git: Git = {
      branches: () => listBranches(dir),
      status: () => status(dir),
      switchBranch: name => switchBranch(dir, name),
      watch: onChange => watchHead(dir, onChange),
      worktree: on => (on ? ensureWorktree(checkout, worktrees, id) : checkout),
      // The Gate again, running in the session's directory now; its events as logged.
      reopen: notice => {
        const events = store.read(id);
        const at = sessionDir(events, id);
        options.onReopen({ ...runningIn(loaded, at.dir, at.checkout, id), events, notice });
      },
    };
    return {
      runner: createRunner({ cwd: dir, timeout: loaded.config.bash?.timeout ?? DEFAULT_TIMEOUT }),
      searcher: createSearcher({ cwd: dir, timeout: SEARCH_TIMEOUT }),
      approval: { split: split!, root: dir, permissions: () => loaded.permissions },
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

  return {
    policies,
    // The config as on disk now; null when there is none.
    config: () => loadConfig(paths),
    open,
    // The status text for an unmerged branch kept; none outside a repository.
    removeWorktree(id: string, force: boolean): string[] {
      const removed = repository ? removeWorktree(here, worktrees, id, force) : null;
      return removed?.kept ? [`branch ${removed.branch} kept – not merged`] : [];
    },
    worktreeDirty: (id: string) => repository && worktreeDirty(worktrees, id),
    // Where a listed session started, when that is another checkout of the Project: its branch and directory.
    origin(events: SessionEvent[]): string | null {
      const started = checkoutOf(events);
      if (!started) return null;
      const now = locateCheckout(started, project);
      if (now === here) return null;
      if (!now) return `${tilde(started)} (gone)`;
      const { branch } = probeEnvironment(now);
      return `${branch ? `⎇ ${branch} in ` : ''}${tilde(now)}`;
    },
  };
}

// Startup: read the config (or run the first-start setup), open a new or resumed session, then show the Gate.
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { discover, LOCAL_SERVERS, type DiscoveredModel, type LocalServer } from '../adapters/backend/discover';
import { writeInitialConfig, type ConfigPaths } from '../adapters/fs/config';
import type { SessionStore } from '../adapters/store/sessions';
import { openWorkspace, type Loaded, type Opened, type OpenWith, type Workspace } from '../compose/workspace';
import type { Editor } from '../gate/ports';
import type { SessionEvent } from '../core/log/events';
import { fold } from '../core/log/fold';
import { summarize, type SessionRef } from '../core/session/session';
import { App } from './app';
import { errorText } from '../gate/text';
import type { Clipboard, GateOptions } from '../gate';
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
  // Quitting waits for the session's Background Processes to stop.
  onQuit: () => void;
  // SIGTERM or SIGHUP: quits the same way; returns the unsubscribe. Absent: not listened for.
  onTerminate?: (quit: () => void) => () => void;
  onFatal: (message: string) => void;
};

export function Launch(props: LaunchOptions) {
  const [found, setFound] = createSignal<DiscoveredModel[] | null>(null);
  const [gate, setGate] = createSignal<GateOptions | null>(null);
  const [view, setView] = createSignal<'gate' | 'sessions'>('gate');
  let session: Opened | null = null;
  // The session left last, freed once its Background Processes have stopped.
  let released: Promise<void> = Promise.resolve();
  const [current, setCurrent] = createSignal('');
  // Set once the Context Policies are loaded, before the first session opens.
  let workspace: Workspace;

  const load = () => {
    const loaded = workspace.config();
    if (!loaded) throw new Error(`no config at ${props.paths.global}`);
    return loaded;
  };

  async function open(loaded: Loaded, how: OpenWith = {}) {
    const opened = await workspace.open(loaded, how);
    if (session && session.id !== opened.id) released = session.release();
    session = opened;
    setCurrent(opened.id);
    setFound(null);
    setGate({ ...opened.options, editor: props.editor, clipboard: props.clipboard, openSessions: () => setView('sessions') });
  }

  // /sessions: switching sessions reconnects; the Gate comes back with the session's logged events.
  const switchTo = (which?: string) => open(load(), { which }).then(() => void setView('gate'));
  const back = () => {
    const events = props.store.read(current());
    setGate({ ...gate()!, events, notice: undefined });
    setView('gate');
  };
  // Deleting the current session (or the one it is a Subagent's of) first switches to the newest other one, or a new
  // empty session. force: the user confirmed losing uncommitted changes.
  async function remove(id: string, force: boolean): Promise<string> {
    const titleOf = (id: string) => summarize(props.store.read(id)).title;
    const title = titleOf(id);
    const family = workspace.family(id);
    const switched = family.includes(current());
    if (switched) {
      await open(load(), { which: props.store.list().find(s => !s.locked && !family.includes(s.id))?.id });
      // Its Subagents still running hold their Sessions until they have stopped.
      await released;
    }
    const kept = workspace.deleteSession(id, force);
    return [`deleted "${title}"`, ...(switched ? [`switched to "${titleOf(current())}"`] : []), ...kept].join(' · ');
  }
  const rename = (id: string, title: string) => {
    const event: SessionEvent = { type: 'SessionRenamed', title };
    if (id === current()) session!.options.log.append(event);
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
  const quit = () => void (session?.release() ?? Promise.resolve()).finally(props.onQuit);
  const choose = (model: DiscoveredModel) => {
    writeInitialConfig(props.paths, model);
    open(load()).catch(fail);
  };

  onMount(() => {
    const off = props.onTerminate?.(quit);
    if (off) onCleanup(off);
    const start = async () => {
      // A switched worktree: the Gate again, running in the session's directory now.
      workspace = await openWorkspace({ paths: props.paths, store: props.store, cwd: props.cwd, openFile: props.openFile, onReopen: changed => setGate({ ...gate()!, ...changed }) });
      const loaded = workspace.config();
      return loaded ? open(loaded, { which: props.resume, started: true }) : firstStart();
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
          subagents={id => workspace.family(id).slice(1).filter(props.store.has).length}
          worktreeDirty={id => workspace.worktreeDirty(id)}
          origin={s => workspace.origin(s.events)}
          rename={rename}
          back={back}
        />
      </Show>
    </>
  );
}

// Startup: read the config (or run the first-start setup), open a new or resumed session, then show the Gate.
import { createSignal, onMount, Show } from 'solid-js';
import { discover, LOCAL_SERVERS, type DiscoveredModel, type LocalServer } from '../adapters/backend/discover';
import { writeInitialConfig, type ConfigPaths } from '../adapters/fs/config';
import type { SessionStore } from '../adapters/store/sessions';
import { openWorkspace, type Loaded, type Opened, type Workspace } from '../compose/workspace';
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
  onQuit: () => void;
  onFatal: (message: string) => void;
};

export function Launch(props: LaunchOptions) {
  const [found, setFound] = createSignal<DiscoveredModel[] | null>(null);
  const [gate, setGate] = createSignal<GateOptions | null>(null);
  const [view, setView] = createSignal<'gate' | 'sessions'>('gate');
  let session: Opened | null = null;
  const [current, setCurrent] = createSignal('');
  // Set once the Context Policies are loaded, before the first session opens.
  let workspace: Workspace;

  const load = () => {
    const loaded = workspace.config();
    if (!loaded) throw new Error(`no config at ${props.paths.global}`);
    return loaded;
  };

  // which: a session to resume, else a new session. started: at start.
  async function open(loaded: Loaded, which: SessionRef | undefined, started = false) {
    const opened = await workspace.open(loaded, which, started);
    if (session?.id !== opened.id) session?.release();
    session = opened;
    setCurrent(opened.id);
    setFound(null);
    setGate({ ...opened.options, editor: props.editor, clipboard: props.clipboard, openSessions: () => setView('sessions') });
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
    const kept = workspace.removeWorktree(id, force);
    props.store.delete(id);
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
      // A switched worktree: the Gate again, running in the session's directory now.
      workspace = await openWorkspace({ paths: props.paths, store: props.store, cwd: props.cwd, openFile: props.openFile, onReopen: changed => setGate({ ...gate()!, ...changed }) });
      const loaded = workspace.config();
      return loaded ? open(loaded, props.resume, true) : firstStart();
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
          worktreeDirty={id => workspace.worktreeDirty(id)}
          origin={s => workspace.origin(s.events)}
          rename={rename}
          back={back}
        />
      </Show>
    </>
  );
}

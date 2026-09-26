// Startup: read the config (or run the first-start setup), open a new or resumed session, then show the Gate.
import { resolve } from 'node:path';
import { createSignal, onMount, Show } from 'solid-js';
import { connect } from '../adapters/backend/connect';
import { discover, LOCAL_SERVERS, type DiscoveredModel, type LocalServer } from '../adapters/backend/discover';
import { createRunner } from '../adapters/bash/runner';
import { createSplit } from '../adapters/bash/split';
import type { Clipboard } from '../adapters/clipboard/clipboard';
import { loadConfig, writeInitialConfig, type ConfigPaths } from '../adapters/fs/config';
import { listProjectFiles, probeEnvironment, projectFiles, projectInstructions } from '../adapters/fs/project';
import type { OpenSession, SessionStore } from '../adapters/store/sessions';
import type { Split } from '../core/approval/approval';
import type { Editor } from '../core/context/operations';
import type { SessionEvent } from '../core/log/events';
import { fold } from '../core/log/fold';
import { environmentText } from '../core/notes/environment';
import { newSession, summarize, type SessionRef } from '../core/session/session';
import { App } from './app';
import { errorText } from './format';
import type { GateOptions } from './gate';
import { Sessions } from './sessions';
import { Setup } from './setup';

export type LaunchOptions = {
  paths: ConfigPaths;
  servers?: LocalServer[];
  store: SessionStore;
  // Project root: where bash runs (FR-21); default the working directory.
  cwd?: string;
  // $EDITOR for `e` (FR-8), and on a file itself (`e` on an @file reference, FR-27).
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

export function Launch(props: LaunchOptions) {
  const [found, setFound] = createSignal<DiscoveredModel[] | null>(null);
  const [gate, setGate] = createSignal<GateOptions | null>(null);
  const [view, setView] = createSignal<'gate' | 'sessions'>('gate');
  let session: OpenSession | null = null;
  // tree-sitter-bash, loaded once (FR-22).
  let split: Split | undefined;
  const [current, setCurrent] = createSignal('');
  const root = props.cwd ?? process.cwd();
  const environment = () => environmentText(probeEnvironment(root));
  const project = { read: projectFiles(root), list: () => listProjectFiles(root), environment, open: (path: string) => props.openFile(resolve(root, path)) };

  const load = () => {
    const loaded = loadConfig(props.paths);
    if (!loaded) throw new Error(`no config at ${props.paths.global}`);
    return loaded;
  };
  // The config as read at open and on /reload (FR-44).
  let config: Loaded;
  // The session keeps its Model Profile; /reload re-reads its values (FR-39, FR-44).
  const reconnect = (name: string, session: string) => async () => {
    const loaded = load();
    const backend = await connect(loaded.profile(name), session);
    config = loaded;
    return backend;
  };
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
    const events = newSession(profile.name, loaded.systemPrompt(profile), { environment: environment(), instructions: projectInstructions(root) });
    events.forEach(opened.log.append);
    return { opened, events, notice: { text: 'new session', tone: 'ok' as const } };
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
    const runner = createRunner({ cwd: root, timeout: loaded.config.bash?.timeout ?? DEFAULT_TIMEOUT });
    const approval = { split, root, permissions: () => config.permissions };
    const instruction = () => config.compactionInstruction();
    setGate({ backend, runner, approval, editor: props.editor, clipboard: props.clipboard, log: opened.log, events, project, notice, reconnect: reconnect(profile, opened.id), openSessions: () => setView('sessions'), instruction, compactor: compactor(profile, opened.id) });
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

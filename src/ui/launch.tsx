// Startup: read the config (or run the first-start setup), open a new or resumed session, then show the Gate.
import { createSignal, onMount, Show } from 'solid-js';
import { connect } from '../adapters/backend/connect';
import { discover, LOCAL_SERVERS, type DiscoveredModel, type LocalServer } from '../adapters/backend/discover';
import { loadConfig, writeInitialConfig, type ConfigPaths } from '../adapters/fs/config';
import type { OpenSession, SessionStore } from '../adapters/store/sessions';
import type { SessionEvent } from '../core/log/events';
import { fold } from '../core/log/fold';
import { newSession, summarize } from '../core/session/summary';
import { App } from './app';
import { errorText } from './format';
import type { GateOptions } from './gate';
import { Setup } from './setup';

export type LaunchOptions = {
  paths: ConfigPaths;
  servers?: LocalServer[];
  store: SessionStore;
  // -c [id]: true = the last session (FR-32).
  resume?: true | string;
  onQuit: () => void;
  onFatal: (message: string) => void;
};

type Loaded = NonNullable<ReturnType<typeof loadConfig>>;

export function Launch(props: LaunchOptions) {
  const [found, setFound] = createSignal<DiscoveredModel[] | null>(null);
  const [gate, setGate] = createSignal<GateOptions | null>(null);
  let session: OpenSession | null = null;

  const load = () => {
    const loaded = loadConfig(props.paths);
    if (!loaded) throw new Error(`no config at ${props.paths.global}`);
    return loaded;
  };
  // The session keeps its Model Profile; /reload re-reads its values (FR-39, FR-44).
  const reconnect = (name: string) => async () => connect(load().profile(name));

  function create(loaded: Loaded) {
    const opened = props.store.create();
    const profile = loaded.profile();
    const events = newSession(profile.name, loaded.systemPrompt(profile));
    events.forEach(opened.log.append);
    return { opened, events, notice: undefined };
  }

  // Resume = replay; a Model Profile missing from the config falls back to the default one (FR-35).
  function resume(loaded: Loaded, which: true | string) {
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

  async function open(loaded = load(), which = props.resume) {
    const { opened, events, notice } = which ? resume(loaded, which) : create(loaded);
    session?.release();
    session = opened;
    const profile = fold(events).profile;
    const backend = await connect(loaded.profile(profile));
    setFound(null);
    setGate({ backend, log: opened.log, events, notice, reconnect: reconnect(profile), openSessions: () => {} });
  }

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
    open().catch(fail);
  };

  onMount(() => {
    const start = async () => {
      const loaded = loadConfig(props.paths);
      return loaded ? open(loaded) : firstStart();
    };
    start().catch(fail);
  });

  return (
    <>
      <Show when={found()}>{(models: () => DiscoveredModel[]) => <Setup found={models()} configPath={props.paths.global} onChoose={choose} onQuit={quit} />}</Show>
      <Show when={gate()} keyed>
        {(options: GateOptions) => <App {...options} onQuit={quit} />}
      </Show>
    </>
  );
}

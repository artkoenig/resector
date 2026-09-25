// Startup: read the config (or run the first-start setup), open the default Model Profile, then show the Gate.
import { createSignal, onMount, Show } from 'solid-js';
import { connect } from '../adapters/backend/connect';
import { discover, LOCAL_SERVERS, type DiscoveredModel, type LocalServer } from '../adapters/backend/discover';
import { loadConfig, writeInitialConfig, type ConfigPaths } from '../adapters/fs/config';
import type { SessionLog } from '../core/log/events';
import { App } from './app';
import { errorText } from './format';
import type { GateOptions } from './gate';
import { Setup } from './setup';

export type LaunchOptions = {
  paths: ConfigPaths;
  servers?: LocalServer[];
  openLog: () => SessionLog;
  onQuit: () => void;
  onFatal: (message: string) => void;
};

export function Launch(props: LaunchOptions) {
  const [found, setFound] = createSignal<DiscoveredModel[] | null>(null);
  const [gate, setGate] = createSignal<GateOptions | null>(null);

  const load = () => {
    const loaded = loadConfig(props.paths);
    if (!loaded) throw new Error(`no config at ${props.paths.global}`);
    return loaded;
  };
  // The session keeps its Model Profile; /reload re-reads its values (FR-39, FR-44).
  const reconnect = (name: string) => async () => connect(load().profile(name));

  async function open(loaded = load()) {
    const profile = loaded.profile();
    const systemPrompt = loaded.systemPrompt(profile);
    const backend = await connect(profile);
    setFound(null);
    setGate({ backend, log: props.openLog(), profile: profile.name, systemPrompt, reconnect: reconnect(profile.name) });
  }

  async function firstStart() {
    const models = await discover(props.servers ?? LOCAL_SERVERS);
    if (!models.length)
      throw new Error(`no model server found on localhost:8080 (llama.cpp), :11434 (Ollama), :1234 (LM Studio, oMLX): start one or write ${props.paths.global}`);
    setFound(models);
  }

  const fail = (e: unknown) => props.onFatal(errorText(e));
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
      <Show when={found()}>{(models: () => DiscoveredModel[]) => <Setup found={models()} configPath={props.paths.global} onChoose={choose} onQuit={props.onQuit} />}</Show>
      <Show when={gate()}>{(options: () => GateOptions) => <App {...options()} onQuit={props.onQuit} />}</Show>
    </>
  );
}

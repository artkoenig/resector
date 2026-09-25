// First start (FR-45): look for model servers on their default local ports and list the models they offer.
import { DEFAULT_ENDPOINTS, type BackendKind } from '../../core/config/config';

export type LocalServer = { backend: BackendKind; endpoint: string };
export type DiscoveredModel = LocalServer & { model: string };

export const LOCAL_SERVERS: LocalServer[] = Object.entries(DEFAULT_ENDPOINTS).map(([backend, endpoint]) => ({
  backend: backend as BackendKind,
  endpoint,
}));

type ModelList = { data?: { id: string }[]; models?: { name: string }[] };

// Ollama lists models natively; llama.cpp and LM Studio via the OpenAI-compatible endpoint.
const OPENAI = { path: '/v1/models', names: (l: ModelList) => l.data!.map(m => m.id) };
const MODELS = {
  llamacpp: OPENAI,
  lmstudio: OPENAI,
  ollama: { path: '/api/tags', names: (l: ModelList) => l.models!.map(m => m.name) },
};

export async function discover(servers = LOCAL_SERVERS, timeoutMs = 500): Promise<DiscoveredModel[]> {
  const lists = await Promise.all(
    servers.map(async server => {
      const { path, names } = MODELS[server.backend];
      try {
        const res = await fetch(server.endpoint + path, { signal: AbortSignal.timeout(timeoutMs) });
        return names((await res.json()) as ModelList).map(model => ({ ...server, model }));
      } catch {
        return [];
      }
    }),
  );
  return lists.flat();
}

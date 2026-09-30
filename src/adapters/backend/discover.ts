// First start: look for model servers on their default local ports and list the models they offer.
import { DEFAULT_ENDPOINTS, type BackendKind } from '../../core/config/config';

export type LocalServer = { backend: BackendKind; endpoint: string };
export type DiscoveredModel = LocalServer & { model: string };

// One scan per port: the backend of a shared port (1234: LM Studio or oMLX) is told by its answer.
export const LOCAL_SERVERS: LocalServer[] = Object.entries(DEFAULT_ENDPOINTS)
  .filter(([, endpoint], i, all) => all.findIndex(([, e]) => e === endpoint) === i)
  .map(([backend, endpoint]) => ({ backend: backend as BackendKind, endpoint }));

type ModelList = { data?: { id: string; owned_by?: string }[]; models?: { name: string }[] };
type Found = { backend: BackendKind; model: string };

// Ollama lists models natively; the others via the OpenAI-compatible endpoint, where oMLX names itself as owner.
const OPENAI = {
  path: '/v1/models',
  models: (l: ModelList, backend: BackendKind): Found[] =>
    l.data!.map(m => ({ backend: m.owned_by === 'omlx' ? 'omlx' : backend, model: m.id })),
};
const MODELS = {
  llamacpp: OPENAI,
  lmstudio: OPENAI,
  omlx: OPENAI,
  ollama: { path: '/api/tags', models: (l: ModelList, backend: BackendKind): Found[] => l.models!.map(m => ({ backend, model: m.name })) },
};

export async function discover(servers = LOCAL_SERVERS, timeoutMs = 500): Promise<DiscoveredModel[]> {
  const lists = await Promise.all(
    servers.map(async server => {
      const { path, models } = MODELS[server.backend];
      try {
        const res = await fetch(server.endpoint + path, { signal: AbortSignal.timeout(timeoutMs) });
        return models((await res.json()) as ModelList, server.backend).map(found => ({ ...found, endpoint: server.endpoint }));
      } catch {
        return [];
      }
    }),
  );
  return lists.flat();
}

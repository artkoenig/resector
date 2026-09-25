import { afterEach, expect, test } from 'bun:test';
import { startFakeLlamaCpp } from '../../../test/fake-llamacpp';
import { startFakeOmlx } from '../../../test/fake-omlx';
import { discover, LOCAL_SERVERS } from './discover';

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach(stop => stop()));

function serve(routes: Record<string, unknown>) {
  const server = Bun.serve({ port: 0, fetch: req => Response.json(routes[new URL(req.url).pathname] ?? {}, { status: routes[new URL(req.url).pathname] ? 200 : 404 }) });
  stops.push(() => server.stop(true));
  return `http://localhost:${server.port}`;
}

test('running local backends are found with their models; silent ports are skipped', async () => {
  const llama = startFakeLlamaCpp({ model: 'qwen3-8b.gguf' });
  stops.push(llama.stop);
  const ollama = serve({ '/api/tags': { models: [{ name: 'gemma3:4b' }, { name: 'qwen3:8b' }] } });
  const lmstudio = serve({ '/v1/models': { data: [] } });
  const found = await discover([
    { backend: 'llamacpp', endpoint: llama.url },
    { backend: 'ollama', endpoint: ollama },
    { backend: 'lmstudio', endpoint: lmstudio },
    { backend: 'lmstudio', endpoint: 'http://localhost:1' },
  ]);
  expect(found).toEqual([
    { backend: 'llamacpp', endpoint: llama.url, model: 'qwen3-8b.gguf' },
    { backend: 'ollama', endpoint: ollama, model: 'gemma3:4b' },
    { backend: 'ollama', endpoint: ollama, model: 'qwen3:8b' },
  ]);
});

test('each default port is scanned once', () => {
  expect(LOCAL_SERVERS.map(s => s.endpoint)).toEqual(['http://localhost:8080', 'http://localhost:11434', 'http://localhost:1234']);
});

test('a server on the shared port 1234 is classified by its model list, not by the port', async () => {
  const omlx = startFakeOmlx({ models: [{ id: 'Qwen3-8B-4bit' }, { id: 'gemma-3-4b' }] });
  stops.push(omlx.stop);
  const lmstudio = serve({ '/v1/models': { data: [{ id: 'qwen3-8b', owned_by: 'organization_owner' }] } });
  const found = await discover([
    { backend: 'lmstudio', endpoint: omlx.url },
    { backend: 'lmstudio', endpoint: lmstudio },
  ]);
  expect(found).toEqual([
    { backend: 'omlx', endpoint: omlx.url, model: 'Qwen3-8B-4bit' },
    { backend: 'omlx', endpoint: omlx.url, model: 'gemma-3-4b' },
    { backend: 'lmstudio', endpoint: lmstudio, model: 'qwen3-8b' },
  ]);
});

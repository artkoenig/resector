import { afterEach, expect, test } from 'bun:test';
import { startFakeLlamaCpp } from '../../../test/fake-llamacpp';
import { discover } from './discover';

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

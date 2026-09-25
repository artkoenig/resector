import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testRender } from '@opentui/solid';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { startFakeOmlx } from '../../test/fake-omlx';
import type { LocalServer } from '../adapters/backend/discover';
import { configPaths } from '../adapters/fs/config';
import { createSessionLog } from '../adapters/store/session-log';
import { SCHEMA_URL } from '../core/config/config';
import { DEFAULT_SYSTEM_PROMPT } from '../core/config/system-prompt';
import { Launch } from './launch';

let fake: ReturnType<typeof startFakeLlamaCpp>;
let ui: Awaited<ReturnType<typeof testRender>>;
afterEach(() => {
  ui.renderer.destroy();
  fake.stop();
});

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

type Setup = { config?: (url: string) => string; systemMd?: string; servers?: (url: string) => LocalServer[] };

async function launch({ config, systemMd, servers }: Setup = {}) {
  fake = startFakeLlamaCpp({ nCtx: 4096, model: 'qwen3-8b.gguf' });
  const root = mkdtempSync(join(tmpdir(), 'resector-launch-'));
  const paths = configPaths({ home: join(root, 'home'), cwd: join(root, 'project'), env: {} });
  if (config) put(paths.global, config(fake.url));
  if (systemMd) put(join(dirname(paths.global), 'system.md'), systemMd);
  const fatal: string[] = [];
  const log = createSessionLog(join(root, 'sessions'), 'ses_test');
  ui = await testRender(
    () => (
      <Launch
        paths={paths}
        servers={servers?.(fake.url) ?? [{ backend: 'llamacpp', endpoint: fake.url }]}
        openLog={() => log}
        onQuit={() => {}}
        onFatal={m => fatal.push(m)}
      />
    ),
    { width: 80, height: 16 },
  );
  return { paths, fatal, log };
}

const profileConfig = (url: string, extra = '') => `{
  // test profile
  "profiles": { "local": { "backend": "llamacpp", "endpoint": "${url}", "window": 2048 ${extra} } },
  "defaultProfile": "local",
}`;

test('first start: a found model is offered, written to the global config and opened at the Gate', async () => {
  const { paths, log } = await launch();
  await frameMatching(f => f.includes('qwen3-8b.gguf'));
  const frame = ui.captureCharFrame();
  expect(frame).toContain('first start');
  expect(frame).toMatch(/llama\.cpp\s+qwen3-8b\.gguf\s+http:\/\/localhost:\d+/);
  ui.mockInput.pressEnter();
  const gate = await frameMatching(f => f.includes('/ 4k'));
  expect(gate).toMatch(/^ qwen3-8b +/m);
  expect(JSON.parse(readFileSync(paths.global, 'utf8'))).toEqual({
    $schema: SCHEMA_URL,
    profiles: { 'qwen3-8b': { backend: 'llamacpp', endpoint: fake.url, model: 'qwen3-8b.gguf' } },
    defaultProfile: 'qwen3-8b',
  });
  expect(JSON.parse(readFileSync(log.path, 'utf8').split('\n')[1]!).content).toBe(DEFAULT_SYSTEM_PROMPT);
});

test('first start offers models of backends not supported yet, but does not let them be chosen', async () => {
  const ollama = Bun.serve({ port: 0, fetch: () => Response.json({ models: [{ name: 'gemma3:4b' }] }) });
  try {
    const { paths } = await launch({ servers: () => [{ backend: 'ollama', endpoint: `http://localhost:${ollama.port}` }] });
    const frame = await frameMatching(f => f.includes('gemma3:4b'));
    expect(frame).toMatch(/Ollama\s+gemma3:4b\s+http:\/\/localhost:\d+\s+unsupported/);
    ui.mockInput.pressEnter();
    await Bun.sleep(50);
    expect(existsSync(paths.global)).toBe(false);
  } finally {
    ollama.stop(true);
  }
});

test('first start: an oMLX server on the LM Studio port is recognised, chosen and opened with its window', async () => {
  const omlx = startFakeOmlx({ models: [{ id: 'Qwen3-8B-4bit', maxModelLen: 8192 }] });
  try {
    const { paths } = await launch({ servers: () => [{ backend: 'lmstudio', endpoint: omlx.url }] });
    expect(await frameMatching(f => f.includes('Qwen3-8B-4bit'))).toMatch(/oMLX\s+Qwen3-8B-4bit\s+http:\/\/localhost:\d+\s*$/m);
    ui.mockInput.pressEnter();
    expect(await frameMatching(f => f.includes('/ 8k'))).toMatch(/^ Qwen3-8B-4bit +/m);
    expect(JSON.parse(readFileSync(paths.global, 'utf8')).profiles).toEqual({
      'Qwen3-8B-4bit': { backend: 'omlx', endpoint: omlx.url, model: 'Qwen3-8B-4bit' },
    });
  } finally {
    omlx.stop();
  }
});

test('first start without any local model server fails with a hint', async () => {
  const { paths, fatal } = await launch({ servers: () => [{ backend: 'llamacpp', endpoint: 'http://localhost:1' }] });
  await until(() => fatal.length > 0);
  expect(fatal).toEqual([
    `no model server found on localhost:8080 (llama.cpp), :11434 (Ollama), :1234 (LM Studio, oMLX): start one or write ${paths.global}`,
  ]);
  expect(existsSync(paths.global)).toBe(false);
});

test('the Gate opens with the default Model Profile, its window and the system.md prompt', async () => {
  await launch({ config: url => profileConfig(url), systemMd: 'You are terse.' });
  const frame = await frameMatching(f => f.includes('/ 2k'));
  expect(frame).toMatch(/^ local +/m);
  expect(frame).toContain('You are terse.');
});

test('a Model Profile whose backend cannot be opened fails before the Gate', async () => {
  const { fatal } = await launch({ config: () => '{ "profiles": { "g": { "backend": "ollama" } }, "defaultProfile": "g" }' });
  await until(() => fatal.length > 0);
  expect(fatal).toEqual(['ollama backend not supported yet']);
});

test('/reload re-reads the config and reconnects; an invalid config keeps the current one', async () => {
  const { paths } = await launch({ config: url => profileConfig(url) });
  await frameMatching(f => f.includes('/ 2k'));
  put(paths.global, profileConfig(fake.url).replace('2048', '3072'));
  await command('/reload');
  expect(await frameMatching(f => f.includes('/ 3k'))).toContain('config reloaded');
  put(paths.global, '{ "profiles": ');
  await command('/reload');
  expect(await frameMatching(f => f.includes('reload failed'))).toMatch(/\/ 3k[\s\S]*reload failed: [\s\S]*config\.jsonc:1:\d+: ValueExpected/);
});

async function command(text: string) {
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(text);
  ui.mockInput.pressEnter();
}

// Startup waits on real HTTP, so frames are polled over time rather than render passes.
async function frameMatching(predicate: (frame: string) => boolean): Promise<string> {
  for (let i = 0; i < 200; i++) {
    await ui.renderOnce();
    const current = ui.captureCharFrame();
    if (predicate(current)) return current;
    await Bun.sleep(10);
  }
  throw new Error(`no matching frame:\n${ui.captureCharFrame()}`);
}

async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(10);
}

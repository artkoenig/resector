import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testRender } from '@opentui/solid';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { frameMatching } from '../../test/frames';
import { startFakeOmlx } from '../../test/fake-omlx';
import type { LocalServer } from '../adapters/backend/discover';
import { configPaths } from '../adapters/fs/config';
import { openSessionStore } from '../adapters/store/sessions';
import type { SessionEvent } from '../core/log/events';
import { newSession } from '../core/session/summary';
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

type Setup = { config?: (url: string) => string; systemMd?: string; servers?: (url: string) => LocalServer[]; sessions?: Record<string, SessionEvent[]>; locks?: Record<string, number>; resume?: true | string };

async function launch({ config, systemMd, servers, sessions = {}, locks = {}, resume }: Setup = {}) {
  fake = startFakeLlamaCpp({ nCtx: 4096, model: 'qwen3-8b.gguf' });
  const root = mkdtempSync(join(tmpdir(), 'resector-launch-'));
  const paths = configPaths({ home: join(root, 'home'), cwd: join(root, 'project'), env: {} });
  if (config) put(paths.global, config(fake.url));
  if (systemMd) put(join(dirname(paths.global), 'system.md'), systemMd);
  const fatal: string[] = [];
  const store = openSessionStore(join(root, 'sessions'), { id: () => 'ses_test' });
  for (const [id, events] of Object.entries(sessions)) put(join(root, 'sessions', `${id}.jsonl`), events.map(e => JSON.stringify(e) + '\n').join(''));
  for (const [id, pid] of Object.entries(locks)) put(join(root, 'sessions', `${id}.lock`), String(pid));
  const quit: string[] = [];
  ui = await testRender(
    () => (
      <Launch
        paths={paths}
        servers={servers?.(fake.url) ?? [{ backend: 'llamacpp', endpoint: fake.url }]}
        store={store}
        resume={resume}
        onQuit={() => quit.push('quit')}
        onFatal={m => fatal.push(m)}
      />
    ),
    { width: 80, height: 16 },
  );
  const log = () => readFileSync(join(root, 'sessions', 'ses_test.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { paths, fatal, log, store, quit, root };
}

const profileConfig = (url: string, extra = '') => `{
  // test profile
  "profiles": { "local": { "backend": "llamacpp", "endpoint": "${url}", "window": 2048 ${extra} } },
  "defaultProfile": "local",
}`;

test('first start: a found model is offered, written to the global config and opened at the Gate', async () => {
  const { paths, log } = await launch();
  await frameMatching(ui, f => f.includes('qwen3-8b.gguf'));
  const frame = ui.captureCharFrame();
  expect(frame).toContain('first start');
  expect(frame).toMatch(/llama\.cpp\s+qwen3-8b\.gguf\s+http:\/\/localhost:\d+/);
  ui.mockInput.pressEnter();
  const gate = await frameMatching(ui, f => f.includes('/ 4k'));
  expect(gate).toMatch(/^ qwen3-8b +/m);
  expect(JSON.parse(readFileSync(paths.global, 'utf8'))).toEqual({
    $schema: SCHEMA_URL,
    profiles: { 'qwen3-8b': { backend: 'llamacpp', endpoint: fake.url, model: 'qwen3-8b.gguf' } },
    defaultProfile: 'qwen3-8b',
  });
  expect(log()[1].content).toBe(DEFAULT_SYSTEM_PROMPT);
});

test('first start offers models of backends not supported yet, but does not let them be chosen', async () => {
  const ollama = Bun.serve({ port: 0, fetch: () => Response.json({ models: [{ name: 'gemma3:4b' }] }) });
  try {
    const { paths } = await launch({ servers: () => [{ backend: 'ollama', endpoint: `http://localhost:${ollama.port}` }] });
    const frame = await frameMatching(ui, f => f.includes('gemma3:4b'));
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
    expect(await frameMatching(ui, f => f.includes('Qwen3-8B-4bit'))).toMatch(/oMLX\s+Qwen3-8B-4bit\s+http:\/\/localhost:\d+\s*$/m);
    ui.mockInput.pressEnter();
    expect(await frameMatching(ui, f => f.includes('/ 8k'))).toMatch(/^ Qwen3-8B-4bit +/m);
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
  const frame = await frameMatching(ui, f => f.includes('/ 2k'));
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
  await frameMatching(ui, f => f.includes('/ 2k'));
  put(paths.global, profileConfig(fake.url).replace('2048', '3072'));
  await command('/reload');
  expect(await frameMatching(ui, f => f.includes('/ 3k'))).toContain('config reloaded');
  put(paths.global, '{ "profiles": ');
  await command('/reload');
  // The config path is long enough to wrap the status line, so whitespace is ignored.
  const frame = (await frameMatching(ui, f => f.includes('reload failed'))).replace(/\s+/g, '');
  expect(frame).toMatch(/\/3k.*reloadfailed:.*config\.jsonc:1:\d+:ValueExpected/);
});

const chat = (profile: string): SessionEvent[] => [
  ...newSession(profile, 'You are terse.'),
  { type: 'BlockAdded', id: 2, kind: 'User', origin: 'user', content: 'hi there' },
  { type: 'RequestSent', hash: 'h', tokens: 20 },
  { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'hello' },
  { type: 'ResponseReceived', usage: null, cached: null },
];

test('-c replays the last Session Log and lands at the Gate; unchanged, nothing is sent (FR-32, FR-35)', async () => {
  const { root } = await launch({ config: url => profileConfig(url), sessions: { ses_a: chat('local') }, resume: true });
  const frame = await frameMatching(ui, f => f.includes('resumed "hi there"'));
  expect(frame).toMatch(/2\s+User\s+hi there/);
  expect(frame).toMatch(/3\s+Assistant\s+hello/);
  expect(readFileSync(join(root, 'sessions', 'ses_a.lock'), 'utf8')).toBe(String(process.pid));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  expect(fake.chatRequests).toEqual([]);
});

test('a resumed session whose Model Profile is gone continues on the default one, logged (FR-35)', async () => {
  const { store } = await launch({ config: url => profileConfig(url), sessions: { ses_a: chat('gone') }, resume: 'ses_a' });
  const frame = await frameMatching(ui, f => f.includes('not in config'));
  expect(frame).toContain('profile "gone" not in config → local');
  expect(frame).toMatch(/^ local +/m);
  expect(store.list()[0]!.events.at(-1)).toEqual({ type: 'ProfileFallback', profile: 'local' });
});

test('a session open in another instance is not resumed (FR-36)', async () => {
  const other = Bun.spawn(['sleep', '10']);
  try {
    const { fatal } = await launch({ config: url => profileConfig(url), sessions: { ses_a: chat('local') }, locks: { ses_a: other.pid }, resume: 'ses_a' });
    await until(() => fatal.length > 0);
    expect(fatal).toEqual(['session ses_a is open in another resector instance']);
  } finally {
    other.kill();
  }
});

test('quitting releases the session lock', async () => {
  const { quit, root } = await launch({ config: url => profileConfig(url) });
  await frameMatching(ui, f => f.includes('/ 2k'));
  ui.mockInput.pressKey('q');
  await until(() => quit.length > 0);
  expect(readdirSync(join(root, 'sessions'))).toEqual(['ses_test.jsonl']);
});

async function command(text: string) {
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(text);
  ui.mockInput.pressEnter();
}

async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(10);
}

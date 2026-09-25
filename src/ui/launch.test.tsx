import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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
import { newSession } from '../core/session/session';
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
  let created = 0;
  const store = openSessionStore(join(root, 'sessions'), { id: () => (created++ ? `ses_new${created - 1}` : 'ses_test') });
  // Sessions are written oldest last: the first one given is the newest.
  Object.entries(sessions).forEach(([id, events], i) => {
    const path = join(root, 'sessions', `${id}.jsonl`);
    put(path, events.map(e => JSON.stringify(e) + '\n').join(''));
    const t = new Date(Date.now() - (i + 1) * 3_600_000);
    utimesSync(path, t, t);
  });
  for (const [id, pid] of Object.entries(locks)) put(join(root, 'sessions', `${id}.lock`), String(pid));
  const quit: string[] = [];
  ui = await testRender(
    () => (
      <Launch
        paths={paths}
        servers={servers?.(fake.url) ?? [{ backend: 'llamacpp', endpoint: fake.url }]}
        store={store}
        editor={async text => text}
        clipboard={async () => {}}
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
  expect(gate).toMatch(/^ {2}resector {2}qwen3-8b +/m);
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
    expect(await frameMatching(ui, f => f.includes('/ 8k'))).toMatch(/^ {2}resector {2}Qwen3-8B-4bit +/m);
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
  expect(frame).toMatch(/^ {2}resector {2}local +/m);
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
  // The config path is long enough to wrap in the error band, so whitespace and the band's ┃ are ignored.
  const frame = (await frameMatching(ui, f => f.includes('reload failed'))).replace(/\s+/g, '');
  expect(frame).toMatch(/\/3k.*✗reloadfailed┃/);
  expect(frame.replace(/┃/g, '')).toMatch(/config\.jsonc:1:\d+:ValueExpected/);
});

const chat = (profile: string): SessionEvent[] => [
  ...newSession(profile, 'You are terse.'),
  { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'hi there' },
  { type: 'RequestSent', hash: 'h', tokens: 20 },
  { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'hello' },
  { type: 'ResponseReceived', usage: null, cached: null },
];

test('-c replays the last Session Log and lands at the Gate; unchanged, nothing is sent (FR-32, FR-35)', async () => {
  const { root } = await launch({ config: url => profileConfig(url), sessions: { ses_a: chat('local') }, resume: true });
  const frame = await frameMatching(ui, f => f.includes('resumed "hi there"'));
  expect(frame).toMatch(/3\s+User\s+hi there/);
  expect(frame).toMatch(/4\s+Assistant\s+hello/);
  expect(readFileSync(join(root, 'sessions', 'ses_a.lock'), 'utf8')).toBe(String(process.pid));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  expect(fake.chatRequests).toEqual([]);
});

test('a resumed session whose Model Profile is gone continues on the default one, logged (FR-35)', async () => {
  const { store } = await launch({ config: url => profileConfig(url), sessions: { ses_a: chat('gone') }, resume: 'ses_a' });
  const frame = await frameMatching(ui, f => f.includes('not in config'));
  expect(frame).toContain('profile "gone" not in config → local');
  expect(frame).toMatch(/^ {2}resector {2}local +/m);
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

async function sessionsView(sessions: Record<string, SessionEvent[]>, locks: Record<string, number> = {}) {
  const started = await launch({ config: url => profileConfig(url), sessions, locks });
  await frameMatching(ui, f => f.includes('/ 2k'));
  await command('/sessions');
  await frameMatching(ui, f => f.includes('Sessions ·'));
  return started;
}
const titled = (profile: string, title: string, tokens = 20) =>
  chat(profile).map(e => (e.type === 'BlockAdded' && e.kind === 'User' ? { ...e, content: title } : e.type === 'RequestSent' ? { ...e, tokens } : e));
const key = async (name: string) => {
  if (name === 'up' || name === 'down') ui.mockInput.pressArrow(name);
  else if (name === 'enter') ui.mockInput.pressEnter();
  else if (name === 'escape') {
    ui.mockInput.pressEscape();
    await Bun.sleep(50);
  } else ui.mockInput.pressKey(name);
  await ui.flush();
};

test('/sessions lists the project sessions newest first with marker, profile, Context and blocks (FR-33)', async () => {
  const other = Bun.spawn(['sleep', '10']);
  try {
    await sessionsView({ ses_a: titled('local', 'fix the build', 1900), ses_b: titled('gone', 'old question'), ses_c: titled('local', 'busy') }, { ses_c: other.pid });
    const frame = await frameMatching(ui, f => f.includes('busy'));
    expect(frame).toContain('Sessions · 4 sessions');
    expect(line(frame, /\(new session\)/)).toMatch(/^[ ┃]● +\(new session\) +now +local +– +2\b/);
    expect(line(frame, /fix the build/)).toMatch(/fix the build +1h ago +local +1\.9k\/2k +4\b/);
    expect(line(frame, /old question/)).toMatch(/old question +2h ago +⚠ gone +20 +4\b/);
    expect(line(frame, /busy/)).toMatch(/^[ ┃] ⊘ +busy/);
    expect(frame).toContain('↑↓ select  enter open  r rename  d delete  n new  / filter  esc back');
    await key('down');
    const preview = await frameMatching(ui, f => f.includes('Preview · ses_a'));
    expect(preview).toMatch(/4 +Assistant +hello/);
  } finally {
    other.kill();
  }
});

test('Enter opens the selected session; the lock moves with it; Esc goes back', async () => {
  const { root } = await sessionsView({ ses_a: titled('local', 'fix the build') });
  await key('escape');
  await frameMatching(ui, f => f.includes('/ 2k') && !f.includes('Sessions ·'));
  await command('/sessions');
  await frameMatching(ui, f => f.includes('Sessions ·'));
  await key('down');
  await key('enter');
  const frame = await frameMatching(ui, f => f.includes('resumed "fix the build"'));
  expect(frame).toMatch(/3\s+User\s+fix the build/);
  expect(readdirSync(join(root, 'sessions')).filter(f => f.endsWith('.lock'))).toEqual(['ses_a.lock']);
});

test('a session open in another instance is neither opened nor deleted (FR-36)', async () => {
  const other = Bun.spawn(['sleep', '10']);
  try {
    await sessionsView({ ses_c: titled('local', 'busy') }, { ses_c: other.pid });
    await key('down');
    await key('enter');
    await frameMatching(ui, f => f.includes('⊘ "busy" is open in another resector instance'));
    await key('d');
    await frameMatching(ui, f => f.includes('⊘ cannot delete: open in another instance'));
  } finally {
    other.kill();
  }
});

test('d asks before deleting; deleting the current session switches to the newest other one', async () => {
  const { root } = await sessionsView({ ses_a: titled('local', 'keep me'), ses_b: titled('local', 'drop me') });
  await key('down');
  await key('down');
  await key('d');
  await frameMatching(ui, f => f.includes('Delete this session? y / N'));
  await key('n');
  await frameMatching(ui, f => f.includes('delete cancelled'));
  await key('d');
  await key('y');
  const deleted = await frameMatching(ui, f => f.includes('deleted "drop me"'));
  expect(line(deleted, /1h ago|2h ago/)).toMatch(/keep me/);
  expect(existsSync(join(root, 'sessions', 'ses_b.jsonl'))).toBe(false);
  await key('up');
  await key('up');
  await key('d');
  await key('y');
  const frame = await frameMatching(ui, f => f.includes('switched to "keep me"'));
  expect(line(frame, /keep me/)).toMatch(/^[ ┃]●/);
  expect(existsSync(join(root, 'sessions', 'ses_test.jsonl'))).toBe(false);
});

test('when the next session cannot be opened, the current one is not deleted', async () => {
  const config = (url: string) =>
    `{ "profiles": { "local": { "backend": "llamacpp", "endpoint": "${url}", "window": 2048 }, "down": { "backend": "llamacpp", "endpoint": "http://localhost:1" } }, "defaultProfile": "local" }`;
  const { root } = await launch({ config, sessions: { ses_a: titled('down', 'unreachable') } });
  await frameMatching(ui, f => f.includes('/ 2k'));
  await command('/sessions');
  await frameMatching(ui, f => f.includes('Sessions ·'));
  await key('d');
  await key('y');
  await frameMatching(ui, f => f.includes('cannot reach llama.cpp at http://localhost:1'));
  expect(existsSync(join(root, 'sessions', 'ses_test.jsonl'))).toBe(true);
  expect(readdirSync(join(root, 'sessions')).filter(f => f.endsWith('.lock'))).toEqual(['ses_test.lock']);
});

test('deleting the only session starts a new empty one', async () => {
  await sessionsView({});
  await key('d');
  await key('y');
  const frame = await frameMatching(ui, f => f.includes('switched to "(new session)"'));
  expect(line(frame, /\(new session\)/)).toMatch(/^[ ┃]●/);
});

test('r renames a session, / filters by title, n starts a new session (FR-33, FR-34)', async () => {
  const { store } = await sessionsView({ ses_a: titled('local', 'fix the build'), ses_b: titled('local', 'other') });
  await key('down');
  await key('r');
  await frameMatching(ui, f => f.includes('title > fix the build'));
  await key('enter');
  await frameMatching(ui, f => !f.includes('title >'));
  expect(store.list().find(s => s.id === 'ses_a')!.renamed).toBe(false);
  await key('r');
  await frameMatching(ui, f => f.includes('title > fix the build'));
  for (let i = 0; i < 'fix the build'.length; i++) ui.mockInput.pressBackspace();
  await ui.mockInput.typeText('build fix');
  await key('enter');
  await frameMatching(ui, f => /build fix +now/.test(f));
  expect(store.list().find(s => s.id === 'ses_a')!.title).toBe('build fix');
  await key('/');
  await ui.mockInput.typeText('oth');
  let frame = await frameMatching(ui, f => !f.includes('build fix'));
  expect(frame).toContain('other');
  await key('escape');
  frame = await frameMatching(ui, f => f.includes('build fix'));
  await key('n');
  frame = await frameMatching(ui, f => f.includes('new session') && !f.includes('Sessions ·'));
  expect(store.list().map(s => s.id)).toContain('ses_new1');
});

const line = (frame: string, pattern: RegExp) => frame.split('\n').find(l => pattern.test(l));

async function command(text: string) {
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(text);
  ui.mockInput.pressEnter();
}

async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(10);
}

test('/sessions with more sessions than fit: rows never overlap, the list follows the selection', async () => {
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`ses_${i + 1}`, titled('local', `topic ${i + 1}`)]));
  await sessionsView(many);
  const titles = (f: string) => [...f.matchAll(/^[ ┃][● ][⊘ ] {2}(\(new session\)|topic \d)/gm)].map(m => m[1]);
  let frame = await frameMatching(ui, f => f.includes('topic 1'));
  expect(frame.split('\n')[0]).toMatch(/^ {2}resector {2}Sessions · 9 sessions/);
  expect(frame.split('\n')[2]).toMatch(/^ {5}Title +Updated +Profile +Context +Blocks/);
  expect(titles(frame)[0]).toBe('(new session)');
  expect(titles(frame).length).toBeLessThan(9);
  for (let i = 0; i < 8; i++) await key('down');
  frame = await frameMatching(ui, f => f.includes('Preview · ses_8'));
  expect(titles(frame).at(-1)).toBe('topic 8');
  expect(titles(frame)).not.toContain('(new session)');
  expect(frame.split('\n')[2]).toMatch(/^ {5}Title/);
});

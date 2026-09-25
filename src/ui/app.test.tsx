import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testRender } from '@opentui/solid';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { connectLlamaCpp } from '../adapters/backend/llamacpp';
import { createSessionLog } from '../adapters/store/session-log';
import { App } from './app';

let fake: ReturnType<typeof startFakeLlamaCpp>;
let ui: Awaited<ReturnType<typeof testRender>>;
afterEach(() => {
  ui.renderer.destroy();
  fake.stop();
});

async function start() {
  fake = startFakeLlamaCpp({ nCtx: 4096 });
  const backend = await connectLlamaCpp(fake.url);
  const log = createSessionLog(mkdtempSync(join(tmpdir(), 'resector-')), 'ses_test');
  ui = await testRender(
    () => <App backend={backend} log={log} profile="default" systemPrompt="You are an agent." reconnect={async () => backend} onQuit={() => {}} />,
    { width: 80, height: 16 },
  );
  await ui.waitForFrame(f => f.includes('16 / 4k'));
  const events = () => readFileSync(log.path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { events };
}

const line = (frame: string, pattern: RegExp) => frame.split('\n').find(l => pattern.test(l));

// A lone ESC byte is only recognised as the Escape key after the input parser's timeout.
async function escape() {
  ui.mockInput.pressEscape();
  await Bun.sleep(50);
}

async function write(text: string) {
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(text);
  ui.mockInput.pressEnter();
}

test('the Gate shows every Context Block with its exact tokens and the Template row', async () => {
  const { events } = await start();
  const frame = ui.captureCharFrame();
  expect(line(frame, /default/)).toMatch(/^ default +█░+ +16 \/ 4k/);
  expect(line(frame, /Kind/)).toMatch(/#\s+Kind\s+Title\s+Tokens\s+Cache\s+Flags/);
  expect(line(frame, /System prompt/)).toMatch(/1\s+System\s+System prompt\s+12\b/);
  expect(line(frame, /Template/)).toMatch(/Template\s.*\s4\b/);
  expect(line(frame, /──/)).toMatch(/── #1 System · System prompt/);
  expect(frame).toContain('You are an agent.');
  expect(events()).toEqual([
    { type: 'SessionCreated', profile: 'default', protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'You are an agent.' },
  ]);
});

test('Enter in input mode adds a User block without sending', async () => {
  const { events } = await start();
  await write('hi there');
  const frame = await ui.waitForFrame(f => f.includes('24 / 4k'));
  expect(line(frame, /hi there/)).toMatch(/2\s+User\s+hi there\s+8\b/);
  expect(fake.chatRequests).toEqual([]);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 2, kind: 'User', origin: 'user', content: 'hi there' });
});

test('Tab and Esc leave input mode without adding a block', async () => {
  await start();
  for (const leave of [async () => ui.mockInput.pressTab(), escape]) {
    ui.mockInput.pressTab();
    await ui.waitForFrame(f => f.includes('Enter adds a User block'));
    await ui.mockInput.typeText('draft');
    await leave();
    const frame = await ui.waitForFrame(f => f.includes('Enter send · Tab write'));
    expect(frame).not.toMatch(/2\s+User/);
  }
});

test('Enter sends the Context; the answer streams in as a new row and is logged when complete', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hello', ' world'], usage: { prompt_tokens: 24, completion_tokens: 2 }, cacheN: 16 });
  await write('hi there');
  await ui.waitForFrame(f => f.includes('24 / 4k'));
  ui.mockInput.pressEnter();
  const frame = await ui.waitForFrame(f => f.includes('32 / 4k'));
  expect(line(frame, /Assistant/)).toMatch(/3\s+Assistant\s+Hello world\s+8\b/);
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().slice(3)).toEqual([
    { type: 'RequestSent', hash: expect.any(String), tokens: 24 },
    { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'Hello world' },
    { type: 'ResponseReceived', usage: { prompt_tokens: 24, completion_tokens: 2 }, cached: 16 },
  ]);
});

test('Esc aborts streaming; the partial answer is kept as cut off', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hal'], hang: true });
  await write('hi there');
  await ui.waitForFrame(f => f.includes('24 / 4k'));
  ui.mockInput.pressEnter();
  const streaming = await ui.waitForFrame(f => /3\s+Assistant\s+Hal/.test(f));
  expect(line(streaming, /Assistant/)).toMatch(/Hal\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  expect(events().at(-1).type).toBe('RequestSent');
  await escape();
  const frame = await ui.waitForFrame(f => f.includes('⚠ cut off'));
  expect(line(frame, /Assistant/)).toMatch(/3\s+Assistant\s+Hal\s+\d+\s+⚠ cut off/);
  expect(events().slice(-2)).toEqual([
    { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'Hal', cutOff: true },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
});

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextAttributes } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { frameMatching } from '../../test/frames';
import { connectLlamaCpp } from '../adapters/backend/llamacpp';
import { createSessionLog } from '../adapters/store/session-log';
import { newSession } from '../core/session/summary';
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
  const initial = newSession('default', 'You are an agent.');
  initial.forEach(log.append);
  ui = await testRender(
    () => <App backend={backend} log={log} events={initial} reconnect={async () => backend} onQuit={() => {}} />,
    { width: 80, height: 20 },
  );
  await frameMatching(ui, f => f.includes('16 / 4k'));
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
  const frame = await frameMatching(ui, f => f.includes('24 / 4k'));
  expect(line(frame, /hi there/)).toMatch(/2\s+User\s+hi there\s+8\b/);
  expect(fake.chatRequests).toEqual([]);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 2, kind: 'User', origin: 'user', content: 'hi there' });
});

test('Tab and Esc leave input mode without adding a block', async () => {
  await start();
  for (const leave of [async () => ui.mockInput.pressTab(), escape]) {
    ui.mockInput.pressTab();
    await frameMatching(ui, f => f.includes('Enter adds a User block'));
    await ui.mockInput.typeText('draft');
    await leave();
    const frame = await frameMatching(ui, f => f.includes('Enter send · Tab write'));
    expect(frame).not.toMatch(/2\s+User/);
  }
});

test('Enter sends the Context; the answer streams in as a new row and is logged when complete', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hello', ' world'], usage: { prompt_tokens: 24, completion_tokens: 2 }, cacheN: 16 });
  await write('hi there');
  await frameMatching(ui, f => f.includes('24 / 4k'));
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('32 / 4k'));
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
  await frameMatching(ui, f => f.includes('24 / 4k'));
  ui.mockInput.pressEnter();
  const streaming = await frameMatching(ui, f => /3\s+Assistant\s+Hal/.test(f));
  expect(line(streaming, /Assistant/)).toMatch(/Hal\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  expect(events().at(-1).type).toBe('RequestSent');
  await escape();
  const frame = await frameMatching(ui, f => /Hal\s+\d+\s+⚠ cut off/.test(f));
  expect(line(frame, /Assistant/)).toMatch(/3\s+Assistant\s+Hal\s+\d+\s+⚠ cut off/);
  expect(events().slice(-2)).toEqual([
    { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'Hal', cutOff: true },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
});

async function withUsers(...texts: string[]) {
  const started = await start();
  for (const t of texts) {
    await write(t);
    await frameMatching(ui, f => f.includes(t) && f.includes('Enter send · Tab write'));
  }
  return started;
}
const press = async (key: string, modifiers?: { meta?: boolean }) => {
  if (key === 'up' || key === 'down') ui.mockInput.pressArrow(key, modifiers);
  else ui.mockInput.pressKey(key, modifiers);
  await ui.flush();
};
const order = (frame: string) => [...frame.matchAll(/^ {2}[ ●] +(\d+) {2}\w+ +(\S+)/gm)].map(m => `${m[1]} ${m[2]}`);

test('⌥↑⌥↓ move the selected block inside its area and flag it ⇄ until sent', async () => {
  const { events } = await withUsers('first', 'second');
  await press('up', { meta: true });
  let frame = await frameMatching(ui, f => /2\s+User\s+second/.test(f));
  expect(order(frame)).toEqual(['1 System', '2 second', '3 first']);
  expect(line(frame, /second/)).toMatch(/⇄/);
  expect(line(frame, /first/)).not.toMatch(/⇄/);
  expect(events().at(-1)).toEqual({ type: 'Move', id: 3, after: 1 });
  await press('up', { meta: true });
  frame = await frameMatching(ui, f => f.includes('boundary reached'));
  expect(order(frame)).toEqual(['1 System', '2 second', '3 first']);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => /4\s+Assistant\s+ok/.test(f) && f.includes('answer complete'));
  expect(frame).not.toContain('⇄');
});

test('p cycles pin top → bottom → off; a bottom pin is sent as a user-role message at the very end', async () => {
  const { events } = await withUsers('rules', 'question');
  await press('up');
  await press('p');
  let frame = await frameMatching(ui, f => f.includes('pinned ⤒ top'));
  expect(line(frame, /rules/)).toMatch(/2\s+User\s+rules.*⤒/);
  await press('p');
  frame = await frameMatching(ui, f => f.includes('pinned ⤓ bottom'));
  expect(order(frame)).toEqual(['1 System', '2 question', '3 rules']);
  expect(line(frame, /rules/)).toMatch(/⤓/);
  expect(events().slice(-2)).toEqual([{ type: 'Pin', id: 2, at: 'top' }, { type: 'Pin', id: 2, at: 'bottom' }]);
  fake.reply({ chunks: ['answer'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(order(frame)).toEqual(['1 System', '2 question', '3 answer', '4 rules']);
  expect(frame).not.toContain('⤓');
  expect((fake.chatRequests[0] as { messages: unknown[] }).messages.slice(1)).toEqual([
    { role: 'user', content: 'question' },
    { role: 'user', content: 'rules' },
  ]);
  await press('down');
  await press('p');
  frame = await frameMatching(ui, f => f.includes('unpinned'));
  expect(order(frame)).toEqual(['1 System', '2 question', '3 answer', '4 rules']);
  expect(events().at(-1)).toEqual({ type: 'Unpin', id: 2 });
});

test('d strikes the block through until sent; u brings it back as a counter-event', async () => {
  const { events } = await withUsers('keep', 'drop');
  await press('d');
  let frame = await frameMatching(ui, f => f.includes('removed: drop'));
  expect(line(frame, /drop/)).toMatch(/^ {8}User\s+drop\s+removed/);
  const struck = ui.captureSpans().lines.flatMap(l => l.spans).find(s => s.text.includes('drop') && !s.text.includes('removed:'))!;
  expect(struck.attributes & TextAttributes.STRIKETHROUGH).toBeTruthy();
  frame = await frameMatching(ui, f => f.includes('22 / 4k'));
  expect(line(frame, /keep/)).toMatch(/2\s+User\s+keep/);
  await press('u');
  frame = await frameMatching(ui, f => f.includes('undone: remove'));
  expect(order(frame)).toEqual(['1 System', '2 keep', '3 drop']);
  expect(events().slice(-2)).toEqual([{ type: 'Remove', id: 3 }, { type: 'Undo', eventId: 4 }]);
  await press('down');
  await press('d');
  fake.reply({ chunks: ['fine'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('drop');
  expect(order(frame)).toEqual(['1 System', '2 keep', '3 fine']);
});

test('Space marks and unmarks the selected block; the selection stays', async () => {
  await withUsers('one', 'two');
  await press(' ');
  let frame = await frameMatching(ui, f => /●\s+3\s+User\s+two/.test(f));
  expect(line(frame, /──/)).toMatch(/#3 User · two/);
  await press(' ');
  frame = await frameMatching(ui, f => !f.includes('●'));
  expect(line(frame, /two/)).toMatch(/^ {3} +3\s+User/);
});

test('r renames the block for display only; empty resets', async () => {
  const { events } = await withUsers('hello there');
  await press('r');
  await frameMatching(ui, f => f.includes('title > hello there'));
  for (let i = 0; i < 'hello there'.length; i++) ui.mockInput.pressBackspace();
  await ui.mockInput.typeText('greeting');
  ui.mockInput.pressEnter();
  let frame = await frameMatching(ui, f => f.includes('renamed (display only'));
  expect(line(frame, /greeting/)).toMatch(/2\s+User\s+greeting\s+8\b/);
  expect(line(frame, /default/)).toMatch(/24 \/ 4k/);
  expect(events().at(-1)).toEqual({ type: 'Rename', id: 2, title: 'greeting' });
  await press('r');
  await frameMatching(ui, f => f.includes('title > greeting'));
  for (let i = 0; i < 'greeting'.length; i++) ui.mockInput.pressBackspace();
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('title reset'));
  expect(line(frame, /hello there/)).toMatch(/2\s+User\s+hello there/);
});

test('the header Context bar highlights the selected block', async () => {
  await start();
  await write('x '.repeat(300));
  const bar = () => ui.captureSpans().lines[0]!.spans.filter(s => s.text.includes('█'));
  const white = () => bar().filter(s => Array.from(s.fg.buffer.slice(0, 3)).join() === '255,255,255').map(s => s.text.length);
  await frameMatching(ui, f => /\d+ \/ 4k/.test(f) && !f.includes('16 / 4k'));
  const user = white();
  await press('up');
  await ui.renderOnce();
  const system = white();
  expect(user).toHaveLength(1);
  expect(system).toHaveLength(1);
  expect(user[0]).toBeGreaterThan(system[0]!);
});

test('the key hints stay visible next to a status', async () => {
  await withUsers('hi');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).toContain('Enter send · Tab write');
});

test('a Context changed since the last request can be sent without a new User block', async () => {
  await withUsers('a', 'b');
  fake.reply({ chunks: ['x'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  await press('up');
  await press('up');
  await press('d');
  await frameMatching(ui, f => f.includes('removed: a'));
  fake.reply({ chunks: ['y'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete') && /y\s+\d+/.test(f));
  expect(fake.chatRequests).toHaveLength(2);
  expect((fake.chatRequests[1] as { messages: { content: string }[] }).messages.map(m => m.content)).toEqual(['You are an agent.', 'b', 'x']);
});

test('a rename or an undone change leaves nothing to send', async () => {
  await withUsers('a');
  fake.reply({ chunks: ['x'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  await press('r');
  await frameMatching(ui, f => f.includes('title > x'));
  await ui.mockInput.typeText('!');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('renamed (display only'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  await press('up');
  await press('d');
  await frameMatching(ui, f => f.includes('removed: a'));
  await press('u');
  await frameMatching(ui, f => f.includes('undone: remove'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  expect(fake.chatRequests).toHaveLength(1);
});

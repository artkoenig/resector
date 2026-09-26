import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextAttributes } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { frameMatching } from '../../test/frames';
import { connectLlamaCpp } from '../adapters/backend/llamacpp';
import { createRunner } from '../adapters/bash/runner';
import { createSessionLog } from '../adapters/store/session-log';
import { newSession } from '../core/session/session';
import { TOOLS } from '../core/toolcall/bash';
import { App } from './app';
import type { GateOptions } from './gate';

let fake: ReturnType<typeof startFakeLlamaCpp>;
let ui: Awaited<ReturnType<typeof testRender>>;
afterEach(() => {
  ui.renderer.destroy();
  fake.stop();
});

// Where bash runs in these tests.
const project = realpathSync(mkdtempSync(join(tmpdir(), 'resector-project-')));

// $EDITOR for `e`: the text as the user saves it; default unchanged.
let editor: (text: string) => Promise<string>;
// What copy on select put into the clipboard.
let copied: string[];

// `users`: User blocks already in the Session Log, not yet sent.
async function start({ timeout = 120, compactor, users = [] }: { timeout?: number; compactor?: GateOptions['compactor']; users?: string[] } = {}) {
  editor = async text => text;
  copied = [];
  fake = startFakeLlamaCpp({ nCtx: 4096 });
  const backend = await connectLlamaCpp(fake.url);
  const log = createSessionLog(mkdtempSync(join(tmpdir(), 'resector-')), 'ses_test');
  const runner = createRunner({ cwd: project, timeout });
  const initial = [
    ...newSession('default', 'You are an agent.'),
    ...users.map((content, i) => ({ type: 'BlockAdded' as const, id: i + 3, kind: 'User' as const, origin: 'user' as const, content })),
  ];
  initial.forEach(log.append);
  const opened: string[] = [];
  ui = await testRender(
    () => <App backend={backend} runner={runner} editor={text => editor(text)} clipboard={async text => void copied.push(text)} log={log} events={initial} instruction={() => 'keep the gist'} compactor={compactor} reconnect={async () => backend} openSessions={() => opened.push('sessions')} onQuit={() => {}} />,
    { width: 80, height: 20 },
  );
  await frameMatching(ui, f => f.includes(users.length ? ' / 4k' : '52 / 4k') && !f.includes('… / 4k'));
  const events = () => readFileSync(log.path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { events, opened };
}

const line = (frame: string, pattern: RegExp) => frame.split('\n').find(l => pattern.test(l));

// A lone ESC byte is only recognised as the Escape key after the input parser's timeout.
async function escape() {
  ui.mockInput.pressEscape();
  await Bun.sleep(50);
}

// Writes `text` in input mode; Enter adds it and sends the Context (FR-6).
async function write(text: string) {
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(text);
  ui.mockInput.pressEnter();
}

test('the Gate shows every Context Block with its exact tokens and the Template row', async () => {
  const { events } = await start();
  const frame = ui.captureCharFrame();
  expect(line(frame, /default/)).toMatch(/^ {2}resector {2}default +52 \/ 4k/);
  expect(frame.split('\n')[1]).toMatch(/^ {2}▀+/);
  expect(line(frame, /Type/)).toMatch(/#\s+Type\s+Content\s+Tokens\s+Cache\s+Flags/);
  expect(line(frame, /System prompt/)).toMatch(/1\s+System\s+System prompt\s+12\b/);
  expect(line(frame, /Template/)).toMatch(/Template\s.*\s4\b/);
  expect(line(frame, /#1 · /)).toMatch(/^┃ System {2}#1 · 12 tokens/);
  expect(previewed(frame)).toBe('You are an agent.');
  expect(frame).toContain('You are an agent.');
  expect(events()).toEqual([
    { type: 'SessionCreated', profile: 'default', protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'You are an agent.' },
    { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: TOOLS },
  ]);
});

test('Enter in input mode adds a User block and sends the Context; the answer streams in as a new row and is logged when complete', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hello', ' world'], usage: { prompt_tokens: 24, completion_tokens: 2 }, cacheN: 16 });
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('68 / 4k'));
  expect(line(frame, /hi there/)).toMatch(/3\s+User\s+hi there\s+8\b/);
  expect(line(frame, /Assistant/)).toMatch(/4\s+Assistant\s+Hello world\s+8\b/);
  expect(frame).toContain('⌥↑↓ move  e edit');
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().slice(3)).toEqual([
    { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'hi there' },
    { type: 'RequestSent', hash: expect.any(String), tokens: 60 },
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hello world' },
    { type: 'ResponseReceived', usage: { prompt_tokens: 24, completion_tokens: 2 }, cached: 16 },
  ]);
});

test('empty Enter in input mode adds nothing and sends nothing', async () => {
  await start();
  await write('   ');
  const frame = await frameMatching(ui, f => f.includes('⌥↑↓ move  e edit'));
  expect(frame).not.toMatch(/3\s+User/);
  expect(fake.chatRequests).toEqual([]);
});

test('Tab and Esc leave input mode without adding a block', async () => {
  await start();
  for (const leave of [async () => ui.mockInput.pressTab(), escape]) {
    ui.mockInput.pressTab();
    await frameMatching(ui, f => f.includes('adds a block and sends the Context'));
    await ui.mockInput.typeText('draft');
    await leave();
    const frame = await frameMatching(ui, f => f.includes('⌥↑↓ move  e edit'));
    expect(frame).not.toMatch(/3\s+User/);
  }
});

test('Enter in the Context sends it', async () => {
  const { events } = await start({ users: ['hi there'] });
  fake.reply({ chunks: ['Hello', ' world'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('68 / 4k'));
  expect(line(frame, /Assistant/)).toMatch(/4\s+Assistant\s+Hello world\s+8\b/);
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().at(-3)).toEqual({ type: 'RequestSent', hash: expect.any(String), tokens: 60 });
});

test('Esc aborts streaming; the partial answer is kept as cut off', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hal'], hang: true });
  await write('hi there');
  const streaming = await frameMatching(ui, f => /4\s+Assistant\s+Hal/.test(f));
  expect(line(streaming, /Assistant/)).toMatch(/Hal\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  expect(events().at(-1).type).toBe('RequestSent');
  await escape();
  const frame = await frameMatching(ui, f => /Hal\s+\d+\s+[●○]\s+⚠ cut off/.test(f));
  expect(line(frame, /Assistant/)).toMatch(/4\s+Assistant\s+Hal\s+\d+\s+●\s+⚠ cut off/);
  expect(events().slice(-2)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hal', cutOff: true },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
});

test('reasoning streams dimmed into its own Thinking row, the status says thinking; it is logged before the answer (FR-46, FR-50)', async () => {
  const { events } = await start();
  fake.reply({ thinking: ['plan ', 'it'], chunks: ['hello'] });
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 hi', '4 plan', '5 hello']);
  expect(line(frame, /Thinking/)).toMatch(/4\s+Thinking\s+plan it\s/);
  expect(events().slice(-3)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Thinking', origin: 'model', content: 'plan it' },
    { type: 'BlockAdded', id: 5, kind: 'Assistant', origin: 'model', content: 'hello' },
    { type: 'ResponseReceived', usage: null, cached: 0 },
  ]);
  expect(fake.chatRequests).toHaveLength(1);
});

test('cut off while thinking: the Thinking row streams with status thinking, Esc keeps it ⚠ cut off without Assistant block (FR-19, FR-50)', async () => {
  const { events } = await start();
  fake.reply({ thinking: ['Let me see'], chunks: [], hang: true });
  await write('hi there');
  const streaming = await frameMatching(ui, f => /4\s+Thinking\s+Let me see/.test(f));
  expect(streaming).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] model is thinking/);
  expect(previewed(streaming)).toBe('Let me see');
  await escape();
  const frame = await frameMatching(ui, f => f.includes('⚠ cut off ✂'));
  // Flags beyond their column are cut, not wrapped.
  expect(line(frame, /Thinking/)).toMatch(/4\s+Thinking\s+Let me see\s+0\s+[●○]\s+⚠ cut off ✂ t…$/);
  expect(frame).not.toMatch(/Assistant/);
  expect(events().slice(-2)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Thinking', origin: 'model', content: 'Let me see', cutOff: true },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
});

test('a Thinking block the chat template drops counts 0 tokens, is dimmed and flagged ✂ template; the cache is cold from there (FR-48)', async () => {
  await start();
  fake.reply({ thinking: ['plan it'], chunks: ['hello'] });
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('answer complete') && /Thinking.*✂ template/.test(f));
  expect(line(frame, /Thinking/)).toMatch(/4\s+Thinking\s+plan it\s+0\s+○\s+✂ template/);
  expect(cache(frame)).toEqual(['1●', '2●', '3●', '4○', '5○']);
  // Dimmed: the title in the muted colour.
  const title = ui.captureSpans().lines.flatMap(l => l.spans).find(s => s.text.includes('plan it'))!;
  expect(Array.from(title.fg.buffer.slice(0, 3)).join()).toBe('138,138,138');
});

test('while the answer streams, ↑↓ select and the preview scrolls; the Context stays as sent', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hal'], hang: true });
  await write('hi there');
  let frame = await frameMatching(ui, f => /4\s+Assistant\s+Hal/.test(f));
  expect(frame).toContain('esc abort  q quit');
  await press('up');
  frame = await frameMatching(ui, f => previewed(f) === 'hi there');
  await press('d');
  await press('p');
  await press('down');
  frame = await frameMatching(ui, f => previewed(f).startsWith('Hal'));
  expect(frame).not.toContain('removed');
  expect(events().at(-1).type).toBe('RequestSent');
  await escape();
  await frameMatching(ui, f => f.includes('⚠ cut off'));
  expect(events().filter(e => ['Remove', 'Pin'].includes(e.type))).toEqual([]);
});

// User blocks not yet sent, the last one selected.
async function withUsers(...texts: string[]) {
  const started = await start({ users: texts });
  for (let i = 0; i < texts.length + 1; i++) ui.mockInput.pressArrow('down');
  await frameMatching(ui, f => previewed(f) === texts.at(-1));
  return started;
}
const press = async (key: string, modifiers?: { meta?: boolean }) => {
  if (key === 'up' || key === 'down') ui.mockInput.pressArrow(key, modifiers);
  else ui.mockInput.pressKey(key, modifiers);
  await ui.flush();
};
const order = (frame: string) => [...frame.matchAll(/^[ ┃] [ ●] +(\d+) {2}\w+ +(\S+)/gm)].map(m => `${m[1]} ${m[2]}`);

test('⌥↑⌥↓ move the selected block inside its area and flag it ⇄ until sent', async () => {
  const { events } = await withUsers('first', 'second');
  await press('up', { meta: true });
  let frame = await frameMatching(ui, f => /3\s+User\s+second/.test(f));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 second', '4 first']);
  expect(line(frame, /second/)).toMatch(/⇄/);
  expect(line(frame, /first/)).not.toMatch(/⇄/);
  expect(events().at(-1)).toEqual({ type: 'Move', id: 4, after: 2 });
  await press('up', { meta: true });
  frame = await frameMatching(ui, f => f.includes('boundary reached'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 second', '4 first']);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => /5\s+Assistant\s+ok/.test(f) && f.includes('answer complete'));
  expect(frame).not.toContain('⇄');
});

test('p cycles pin top → bottom → off; a bottom pin is sent as a user-role message at the very end', async () => {
  const { events } = await withUsers('rules', 'question');
  await press('up');
  await press('p');
  let frame = await frameMatching(ui, f => f.includes('pinned ⤒ top'));
  expect(line(frame, /rules/)).toMatch(/3\s+User\s+rules.*⤒/);
  await press('p');
  frame = await frameMatching(ui, f => f.includes('pinned ⤓ bottom'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 question', '4 rules']);
  expect(line(frame, /rules/)).toMatch(/⤓/);
  expect(events().slice(-2)).toEqual([{ type: 'Pin', id: 3, at: 'top' }, { type: 'Pin', id: 3, at: 'bottom' }]);
  fake.reply({ chunks: ['answer'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 question', '4 answer', '5 rules']);
  expect(frame).not.toContain('⤓');
  expect((fake.chatRequests[0] as { messages: unknown[] }).messages.slice(1)).toEqual([
    { role: 'user', content: 'question' },
    { role: 'user', content: 'rules' },
  ]);
  await press('down');
  await press('p');
  frame = await frameMatching(ui, f => f.includes('unpinned'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 question', '4 answer', '5 rules']);
  expect(events().at(-1)).toEqual({ type: 'Unpin', id: 3 });
});

test('d strikes the block through until sent; u brings it back as a counter-event', async () => {
  const { events } = await withUsers('keep', 'drop');
  await press('d');
  let frame = await frameMatching(ui, f => f.includes('removed ·'));
  expect(line(frame, /drop/)).toMatch(/^ {8}User\s+drop\s+removed/);
  const struck = ui.captureSpans().lines.flatMap(l => l.spans).find(s => s.text.includes('drop') && !s.text.includes('removed ·'))!;
  expect(struck.attributes & TextAttributes.STRIKETHROUGH).toBeTruthy();
  frame = await frameMatching(ui, f => f.includes('58 / 4k'));
  expect(line(frame, /keep/)).toMatch(/3\s+User\s+keep/);
  await press('u');
  frame = await frameMatching(ui, f => f.includes('undone: remove'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 keep', '4 drop']);
  expect(events().slice(-2)).toEqual([{ type: 'Remove', id: 4 }, { type: 'Undo', eventId: 5 }]);
  await press('down');
  await press('d');
  fake.reply({ chunks: ['fine'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('drop');
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 keep', '4 fine']);
});

test('Space marks and unmarks the selected block; the selection stays', async () => {
  await withUsers('one', 'two');
  await press(' ');
  let frame = await frameMatching(ui, f => /●\s+4\s+User\s+two/.test(f));
  expect(previewed(frame)).toBe('two');
  await press(' ');
  frame = await frameMatching(ui, f => !f.includes('●'));
  expect(line(frame, /two/)).toMatch(/^[ ┃] {2} +4\s+User/);
});

test('r renames the block for display only; empty resets', async () => {
  const { events } = await withUsers('hello there');
  await press('r');
  await frameMatching(ui, f => f.includes('┃ hello there') && f.includes('display only'));
  for (let i = 0; i < 'hello there'.length; i++) ui.mockInput.pressBackspace();
  await ui.mockInput.typeText('greeting');
  ui.mockInput.pressEnter();
  let frame = await frameMatching(ui, f => f.includes('renamed (display only'));
  expect(line(frame, /greeting/)).toMatch(/3\s+User\s+greeting\s+8\b/);
  expect(line(frame, /default/)).toMatch(/60 \/ 4k/);
  expect(events().at(-1)).toEqual({ type: 'Rename', id: 3, title: 'greeting' });
  await press('r');
  await frameMatching(ui, f => f.includes('┃ greeting') && f.includes('display only'));
  for (let i = 0; i < 'greeting'.length; i++) ui.mockInput.pressBackspace();
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('title reset'));
  expect(line(frame, /hello there/)).toMatch(/3\s+User\s+hello there/);
});

test('the header Context bar highlights the selected block', async () => {
  await start({ users: ['x '.repeat(300)] });
  for (const k of ['down', 'down']) await press(k);
  const bar = () => ui.captureSpans().lines[1]!.spans.filter(s => s.text.includes('▀'));
  const white = () => bar().filter(s => Array.from(s.fg.buffer.slice(0, 3)).join() === '238,238,238').map(s => s.text.length);
  await frameMatching(ui, f => /\d+ \/ 4k/.test(f) && !f.includes('52 / 4k'));
  const user = white();
  await press('up');
  await ui.renderOnce();
  const system = white();
  expect(user).toHaveLength(1);
  expect(system).toHaveLength(1);
  expect(user[0]).toBeGreaterThan(system[0]!);
});

// Per numbered row: its number and Cache column.
const cache = (frame: string) => [...frame.matchAll(/^[ ┃] [ ●] +(\d+) {2}.*\d +([●○]) /gm)].map(m => m[1]! + m[2]!);

test('the Cache column shows ● for rows before the invalidation point, ○ from it on (FR-3)', async () => {
  await withUsers('hi there');
  expect(cache(await frameMatching(ui, f => cache(f).length === 3))).toEqual(['1○', '2○', '3○']);
  fake.reply({ chunks: ['hello'] });
  ui.mockInput.pressEnter();
  const answered = await frameMatching(ui, f => f.includes('answer complete') && cache(f).length === 4);
  expect(cache(answered)).toEqual(['1●', '2●', '3●', '4●']);
  expect(line(answered, /Type/)).toMatch(/Tokens\s+Cache\s+Flags/);
  await press('up', { meta: true });
  const frame = await frameMatching(ui, f => /3\s+Assistant\s+hello/.test(f) && cache(f).length === 4);
  expect(cache(frame)).toEqual(['1●', '2●', '3○', '4○']);
});

test('a server reusing fewer tokens than predicted is reported (FR-41)', async () => {
  await withUsers('hi there');
  fake.reply({ chunks: ['hello'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  fake.reply({ chunks: ['ok'], cacheN: 3 });
  await write('more');
  const frame = await frameMatching(ui, f => f.includes('server reused'));
  // BOS + System 12 + Tools 36 + User 8 + <|im_start|> assistant \n hello
  expect(frame).toContain('answer complete · ⚠ cache: predicted 61 · server reused 3');
  expect(line(frame, /Type/)).toMatch(/Tokens +Cache +Flags/);
});

test('the key hints stay visible next to a status', async () => {
  await withUsers('hi');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).toContain('⌥↑↓ move  e edit');
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
  await frameMatching(ui, f => f.includes('struck through until sent'));
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
  await frameMatching(ui, f => f.includes('┃ x') && f.includes('display only'));
  await ui.mockInput.typeText('!');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('renamed (display only'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  await press('up');
  await press('d');
  await frameMatching(ui, f => f.includes('struck through until sent'));
  await press('u');
  await frameMatching(ui, f => f.includes('undone: remove'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  expect(fake.chatRequests).toHaveLength(1);
});

test('typing / suggests the commands, filtered while typing; ↑↓ choose, Enter runs (FR-6)', async () => {
  const { opened } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/');
  let frame = await frameMatching(ui, f => f.includes('/reload'));
  expect(frame).toContain('↑↓ choose  tab complete  enter run  esc back');
  expect(line(frame, /\/sessions/)).toMatch(/\/sessions\s+list, resume, rename, delete sessions/);
  expect(line(frame, /\/rename/)).toMatch(/\/rename <title>\s+rename session/);
  await ui.mockInput.typeText('re');
  frame = await frameMatching(ui, f => !f.includes('/sessions'));
  expect(frame).toContain('/rename');
  await press('down');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('config reloaded'));
  await write('/sessions');
  await until(() => opened.length > 0);
  await write('/nope');
  await frameMatching(ui, f => f.includes('unknown command /nope – /sessions /rename /reload'));
});

test('/ in the Context starts a command in the input line', async () => {
  await start();
  await ui.mockInput.typeText('/');
  const frame = await frameMatching(ui, f => f.includes('/reload'));
  expect(frame).toContain('┃ /');
  await ui.mockInput.typeText('ren');
  await frameMatching(ui, f => f.includes('rename session') && !f.includes('/sessions'));
});

test('Tab completes a command; /rename sets the session title, empty resets it (FR-34)', async () => {
  const { events } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/ren');
  await frameMatching(ui, f => f.includes('rename session'));
  ui.mockInput.pressTab();
  await frameMatching(ui, f => f.includes('┃ /rename '));
  await ui.mockInput.typeText('my  title');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('session renamed: my  title'));
  expect(events().at(-1)).toEqual({ type: 'SessionRenamed', title: 'my  title' });
  await write('/rename');
  await frameMatching(ui, f => f.includes('session title reset to the first User message'));
  expect(events().at(-1)).toEqual({ type: 'SessionRenamed', title: '' });
});

// The first line of the Content preview: shows which block is selected.
const previewed = (frame: string) => {
  const lines = frame.split('\n');
  return (lines[lines.findIndex(l => /^┃ [A-Z][\w ]* {2}#\d+/.test(l)) + 1] ?? '').slice(2, -1).trim(); // ┃ bar, last column: scrollbar
};

async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(10);
}

test('the preview scrolls with PgUp/PgDn and ⇧↑↓; a newly selected block starts at its top', async () => {
  await start();
  const words = Array.from({ length: 90 }, (_, i) => `w${String(i + 1).padStart(2, '0')}`).join(' ');
  await write(words);
  let frame = await frameMatching(ui, f => previewed(f).startsWith('w01') && !f.includes('… / 4k'));
  expect(previewed(frame)).toMatch(/^w01 /);
  expect(frame).not.toContain('w90');
  ui.mockInput.pressKey('\u001B[6~');
  frame = await frameMatching(ui, f => f.includes('w90'));
  expect(previewed(frame)).not.toMatch(/^w01 /);
  ui.mockInput.pressArrow('up', { shift: true });
  frame = await frameMatching(ui, f => !f.includes('w90'));
  await press('\u001B[A');
  await press('\u001B[B');
  frame = await frameMatching(ui, f => /^w01 /.test(previewed(f)));
  expect(frame).not.toContain('w90');
});

const bash = (command: string) => ({ name: 'bash', arguments: JSON.stringify({ command }) });
type Sent = { messages: Record<string, unknown>[]; tools?: { function: { name: string } }[] };
// The model answers `go` with `text` and bash calls; the Gate stops at the first ? approve.
async function asked(commands: string[], { text = '', timeout = 120 } = {}) {
  const started = await start({ timeout });
  fake.reply({ chunks: text ? [text] : [], calls: commands.map(bash) });
  await write('go');
  await frameMatching(ui, f => f.includes('? approve –') && !/Tool Call .* … /.test(f));
  return started;
}

test('the Tools Block (bash) is always sent and fixed (FR-12)', async () => {
  await withUsers('hi');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect((fake.chatRequests[0] as Sent).tools!.map(t => t.function.name)).toEqual(['bash']);
  for (const k of ['up', 'up']) await press(k);
  await frameMatching(ui, f => previewed(f) === '[');
  await press('d');
  await frameMatching(ui, f => f.includes('Tools Block cannot be removed'));
  await press('down', { meta: true });
  await frameMatching(ui, f => f.includes('Tools Block is fixed'));
});

test('a Tool Call waits at ? approve; y runs it once, its result is a Tool Result block, nothing is sent (FR-23)', async () => {
  const { events } = await asked(['echo hello'], { text: 'Let me look.' });
  let frame = ui.captureCharFrame();
  expect(line(frame, /Let me look/)).toMatch(/4\s+Assistant\s+Let me look\./);
  expect(line(frame, /Tool Call/)).toMatch(/5\s+Tool Call\s+echo hello\s+\d+\s+[●○]\s+\? approve/);
  expect(frame).toMatch(/y run once.*n reject/);
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('Tool Calls await approval'));
  await press('y');
  frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  expect(line(frame, /Tool Result/)).toMatch(/6\s+Tool Result\s+→ echo hello\s+\d+/);
  expect(line(frame, /Tool Call/)).not.toContain('? approve');
  expect(frame).toMatch(/^┃ hello\s*$/m);
  expect(frame).toContain('[exit 0]');
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().slice(-4)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Let me look.' },
    { type: 'BlockAdded', id: 5, kind: 'Tool Call', origin: 'model', content: 'echo hello' },
    { type: 'ResponseReceived', usage: null, cached: expect.any(Number) },
    { type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'hello\n[exit 0]', call: 5 },
  ]);
  fake.reply({ chunks: ['done'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  // Assistant text and its Tool Call are one message; the result a tool message.
  expect((fake.chatRequests[1] as Sent).messages.slice(2)).toEqual([
    { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'call_0', type: 'function', function: bash('echo hello') }] },
    { role: 'tool', tool_call_id: 'call_0', content: 'hello\n[exit 0]' },
  ]);
});

test('Enter in input mode while a Tool Call awaits approval adds the User block but sends nothing (FR-6)', async () => {
  const { events } = await asked(['echo hi']);
  ui.mockInput.pressTab();
  await frameMatching(ui, f => f.includes('enter send'));
  await ui.mockInput.typeText('also this');
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('Tool Calls await approval') && f.includes('also this'));
  expect(line(frame, /also this/)).toMatch(/5\s+User\s+also this/);
  expect(previewed(frame)).toBe('echo hi');
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'User', origin: 'user', content: 'also this' });
});

test('n rejects: the call does not run, its result says "rejected by user"', async () => {
  const { events } = await asked(['touch rejected.txt']);
  expect(line(ui.captureCharFrame(), /Tool Call/)).toMatch(/4\s+Tool Call\s+touch rejected\.txt/);
  await press('n');
  const frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  expect(line(frame, /Tool Result/)).toMatch(/5\s+Tool Result\s+→ touch rejected\.txt/);
  expect(await Bun.file(join(project, 'rejected.txt')).exists()).toBe(false);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'rejected by user', call: 4 });
});

test('several calls are decided one by one in order; results keep call order (FR-24)', async () => {
  const { events } = await asked(['echo one', 'echo two']);
  let frame = ui.captureCharFrame();
  expect(line(frame, /echo one/)).toMatch(/\? approve/);
  expect(line(frame, /echo two/)).toMatch(/· queued/);
  await press('down');
  await press('y');
  await frameMatching(ui, f => f.includes('approve the earlier Tool Call first'));
  await press('up');
  await press('y');
  frame = await frameMatching(ui, f => f.includes('? approve –') && previewed(f) === 'echo two');
  expect(previewed(frame)).toBe('echo two');
  await press('n');
  frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  expect(frame).toMatch(/4\s+Tool Call\s+echo one[^]*5\s+Tool Call\s+echo two[^]*6\s+Tool Result\s+→ echo one[^]*7\s+Tool Result\s+→ echo two/);
  expect(events().slice(-2).map(e => [e.call, e.content])).toEqual([[4, 'one\n[exit 0]'], [5, 'rejected by user']]);
});

test('Esc kills a running command: partial output + ⚠ killed (FR-21)', async () => {
  const { events } = await asked(['echo partial; sleep 5']);
  await press('y');
  let frame = await frameMatching(ui, f => f.includes('running: echo partial') && /^┃ partial\s*$/m.test(f));
  expect(frame).toMatch(/\d+s \/ 120s/);
  expect(frame).toContain('esc kill');
  expect(line(frame, /Tool Result/)).toMatch(/5\s+Tool Result\s+→ echo partial.*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  expect(line(frame, /Tool Call/)).not.toContain('? approve');
  await escape();
  frame = await frameMatching(ui, f => f.includes('⚠ killed – review the results'));
  expect(line(frame, /Tool Result/)).toMatch(/⚠ killed/);
  expect(events().at(-1)).toMatchObject({ kind: 'Tool Result', content: 'partial\n[killed]', stopped: 'killed' });
});

test('a command running into the timeout ends with ⚠ timeout (FR-21)', async () => {
  const { events } = await asked(['sleep 5'], { timeout: 0.3 });
  await press('y');
  const frame = await frameMatching(ui, f => f.includes('⚠ timeout – review the results'));
  expect(line(frame, /Tool Result/)).toMatch(/⚠ timeout/);
  expect(events().at(-1)).toMatchObject({ content: '[timeout after 0.3 s]', stopped: 'timeout' });
});

test('an answer cut off at max_tokens runs no call; calls that are no bash command are not run (FR-19)', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hm'], calls: [bash('ls')], finish: 'length' });
  await write('go');
  let frame = await frameMatching(ui, f => f.includes('cut off at max_tokens'));
  expect(frame).not.toContain('Tool Call');
  expect(events().at(-2)).toEqual({ type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hm\nbash {"command":"ls"}', cutOff: true });
  fake.reply({ chunks: [], calls: [{ name: 'python', arguments: '{}' }, bash('pwd')] });
  await write('again');
  frame = await frameMatching(ui, f => f.includes('tool call not run: unknown tool python'));
  expect(line(frame, /python/)).toMatch(/Assistant\s+python \{\}/);
  expect(line(frame, /Tool Call/)).toMatch(/Tool Call\s+pwd\s.*\? approve/);
});

test('more rows than fit: rows never overlap, the list follows the selection, Template stays visible', async () => {
  await withUsers(...Array.from({ length: 12 }, (_, i) => `note ${i + 3}`));
  const numbers = (f: string) => [...f.matchAll(/^[ ┃] [ ●] +(\d+) {2}/gm)].map(m => Number(m[1]));
  let frame = ui.captureCharFrame();
  expect(line(frame, /Type/)).toMatch(/^ {5}# {2}Type +Content +Tokens/);
  expect(frame).toMatch(/Template +BOS/);
  let shown = numbers(frame);
  expect(shown.at(-1)).toBe(14);
  expect(shown).toEqual(Array.from({ length: shown.length }, (_, i) => shown[0]! + i));
  expect(shown.length).toBeLessThan(14);
  for (let i = 0; i < 13; i++) await press('up');
  frame = await frameMatching(ui, f => previewed(f) === 'You are an agent.');
  shown = numbers(frame);
  expect(shown[0]).toBe(1);
  expect(line(frame, /System prompt/)).toMatch(/1\s+System\s+System prompt\s+12\b/);
  expect(frame).toMatch(/Template +BOS/);
});

test('the mouse wheel over the block table selects the previous or next block', async () => {
  await withUsers('note 3', 'note 4');
  await frameMatching(ui, f => previewed(f) === 'note 4');
  const y = ui.captureCharFrame().split('\n').findIndex(l => l.includes('note 3'));
  await ui.mockMouse.scroll(10, y, 'up');
  await frameMatching(ui, f => previewed(f) === 'note 3');
  await ui.mockMouse.scroll(10, y, 'down');
  await frameMatching(ui, f => previewed(f) === 'note 4');
});

test('an Assistant block of only whitespace is titled (empty)', async () => {
  await asked(['ls'], { text: '\n\n\n' });
  expect(line(ui.captureCharFrame(), /Assistant/)).toMatch(/Assistant\s+\(empty\)/);
});

test('e edits the block in $EDITOR: a new Revision flagged ✎2 until sent, the request carries it (FR-5, FR-8)', async () => {
  const { events } = await withUsers('helo');
  const opened: string[] = [];
  editor = async text => (opened.push(text), 'hello\n');
  await press('e');
  let frame = await frameMatching(ui, f => f.includes('revision 2'));
  expect(opened).toEqual(['helo']);
  expect(line(frame, /User/)).toMatch(/3\s+User\s+hello\s+\d+\s+[●○]?\s+✎2/);
  expect(frame).toContain('edited → revision 2 · u = undo');
  expect(events().at(-1)).toEqual({ type: 'Edit', id: 3, revision: 2, content: 'hello' });
  fake.reply({ chunks: ['hi'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('✎');
  expect((fake.chatRequests[0] as { messages: unknown[] }).messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
});

test('an unchanged save creates no Revision; u undoes an edit', async () => {
  const { events } = await withUsers('keep');
  await press('e');
  await frameMatching(ui, f => f.includes('unchanged – no new Revision'));
  expect(events().some(e => e.type === 'Edit')).toBe(false);
  editor = async () => 'changed';
  await press('e');
  await frameMatching(ui, f => f.includes('revision 2'));
  await press('u');
  const frame = await frameMatching(ui, f => f.includes('undone: edit'));
  expect(line(frame, /3\s+User/)).toMatch(/User\s+keep\s/);
  expect(frame).not.toContain('✎');
});

test('the Tools Block and executed Tool Calls are not opened in $EDITOR', async () => {
  await asked(['echo hi']);
  await press('y');
  await frameMatching(ui, f => f.includes('tool loop paused'));
  const opened: string[] = [];
  editor = async text => (opened.push(text), 'x');
  await press('up');
  await press('e');
  await frameMatching(ui, f => f.includes('executed Tool Calls are immutable'));
  for (const k of ['up', 'up']) await press(k);
  await frameMatching(ui, f => previewed(f) === '[');
  await press('e');
  await frameMatching(ui, f => f.includes('Tools Block is not editable'));
  expect(opened).toEqual([]);
});

test('a Tool Call awaiting approval is edited; y runs the edited command (FR-22)', async () => {
  const { events } = await asked(['echo wrong']);
  editor = async () => 'echo right\n';
  await press('e');
  let frame = await frameMatching(ui, f => f.includes('revision 2'));
  expect(line(frame, /Tool Call/)).toMatch(/4\s+Tool Call\s+echo right\s+\d+\s+[●○]?\s+✎2 \? approve/);
  await press('y');
  frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'right\n[exit 0]', call: 4 });
});

test('an editor that fails leaves the block unchanged', async () => {
  const { events } = await withUsers('keep');
  editor = async () => {
    throw new Error('vi exited with 1');
  };
  await press('e');
  await frameMatching(ui, f => f.includes('✗ editor failed') && f.includes('┃ vi exited with 1 – unchanged'));
  expect(events().some(e => e.type === 'Edit')).toBe(false);
});

test('text selected with the mouse is copied to the clipboard on release', async () => {
  await start();
  const frame = ui.captureCharFrame();
  const y = frame.split('\n').findIndex(l => l.includes('You are an agent.'));
  const x = frame.split('\n')[y]!.indexOf('You');
  await ui.mockMouse.drag(x, y, x + 6, y);
  await frameMatching(ui, f => /copied 7 chars/.test(f));
  expect(copied).toEqual(['You are']);
  await ui.mockMouse.click(x, y);
  await ui.flush();
  expect(copied).toEqual(['You are']);
});

test('d removes a Tool Pair as a whole; Space marks it as a whole (FR-9)', async () => {
  const { events } = await asked(['echo hi']);
  await press('y');
  let frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  await press(' ');
  frame = await frameMatching(ui, f => /●\s+5\s+Tool Result/.test(f));
  expect(line(frame, /Tool Call/)).toMatch(/●\s+4\s+Tool Call/);
  await press('d');
  frame = await frameMatching(ui, f => f.includes('(whole Tool Pair)'));
  expect(line(frame, /Tool Call/)).toMatch(/^ {8}Tool Call\s+echo hi\s+removed/);
  expect(line(frame, /Tool Result/)).toMatch(/^ {8}Tool Result\s+→ echo hi\s+removed/);
  expect(events().at(-1)).toEqual({ type: 'Remove', id: 5 });
});

test('⌥↑ on a Tool Pair asks; any other key cancels; the same key again turns it into a Note and moves it (FR-9)', async () => {
  const { events } = await asked(['echo hi'], { text: 'Look.' });
  await press('y');
  await frameMatching(ui, f => f.includes('tool loop paused'));
  await press('up', { meta: true });
  await frameMatching(ui, f => f.includes('press ⌥↑ again to confirm'));
  await press('x');
  await press('up', { meta: true });
  await frameMatching(ui, f => f.includes('press ⌥↑ again to confirm'));
  expect(events().at(-1).type).toBe('BlockAdded');
  await press('up', { meta: true });
  let frame = await frameMatching(ui, f => /4\s+Note\s+⇄ echo hi.*⇄/.test(f));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 go', '4 ⇄', '5 Look.']);
  expect(frame).not.toContain('Tool Result');
  expect(events().slice(-2)).toEqual([{ type: 'PairToNote', id: 7, call: 5 }, { type: 'Move', id: 7, after: 3 }]);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect((fake.chatRequests[1] as Sent).messages.slice(1)).toEqual([
    { role: 'user', content: 'go' },
    { role: 'user', content: '[Tool bash: echo hi]\nhi\n[exit 0]' },
    { role: 'assistant', content: 'Look.' },
  ]);
});

test('p on a Tool Pair asks, p again pins its Note; u brings the pair back', async () => {
  await asked(['echo hi']);
  await press('y');
  await frameMatching(ui, f => f.includes('tool loop paused'));
  await press('up');
  await press('p');
  await frameMatching(ui, f => f.includes('press p again to confirm'));
  await press('p');
  let frame = await frameMatching(ui, f => f.includes('pinned ⤒ top'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 ⇄', '4 go']);
  expect(line(frame, /Note/)).toMatch(/⤒/);
  await press('u');
  await press('u');
  frame = await frameMatching(ui, f => f.includes('undone: Tool Pair → Note'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 go', '4 Call', '5 Result']);
});

// Compaction (FR-13–FR-17) ------------------------------------------------------------------------------------

test('c opens the instruction line with header and the default instruction as hint; Tab copies it, Esc cancels (FR-13)', async () => {
  await withUsers('one', 'two');
  await press('c');
  let frame = await frameMatching(ui, f => /◇ Compact 1 block \(6 tok\) · default · request \d+ \/ 4k/.test(f));
  expect(frame).toContain('instruction > keep the gist');
  expect(frame).toMatch(/enter compact\s+tab default\s+esc back/);
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(' and paths');
  frame = await frameMatching(ui, f => f.includes('instruction > keep the gist and paths'));
  await escape();
  frame = await frameMatching(ui, f => f.includes('compaction cancelled'));
  expect(frame).not.toContain('instruction >');
  expect(fake.chatRequests).toEqual([]);
});

test('the proposal streams at the first source; Enter accepts it as one Note, u restores the sources (FR-14–FR-16)', async () => {
  const { events } = await withUsers('one', 'two', 'three');
  await press('up');
  await press(' ');
  await press('up');
  await press(' ');
  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 2 blocks'));
  fake.reply({ chunks: ['one', ' and two'], hang: true });
  ui.mockInput.pressEnter();
  let frame = await frameMatching(ui, f => /3\s+Note\s+◇ proposal · 2 blocks/.test(f) && f.includes('one and two'));
  expect(frame).toContain('compacting with default');
  expect(line(frame, /User\s+one/)).toMatch(/◇ proposed/);
  expect(line(frame, /User\s+two/)).toMatch(/◇ proposed/);
  expect(frame).toMatch(/#3 · ◇ proposal · attempt 1 · replaces #4 #5 · "keep the gist"/);
  expect((fake.chatRequests[0] as Sent)).toMatchObject({
    messages: [{ role: 'system' }, { role: 'user', content: '### User\none\n\n### User\ntwo\n\nInstruction: keep the gist' }],
  });
  expect((fake.chatRequests[0] as Sent).tools).toBeUndefined();
  await escape();
  frame = await frameMatching(ui, f => f.includes('compaction aborted – Context unchanged'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two', '5 three']);

  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 2 blocks'));
  fake.reply({ chunks: ['both'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => /◇ 12 → 6 tok \(−50%\) · Context 70 → 64 \/ 4k\s+┃ session cache cold \(same model\/slot\) · cold from #3 after accept/.test(f));
  expect(line(frame, /Note/)).toMatch(/◇ proposal · 2 blocks · att…\s+6\b/);
  expect(frame).toMatch(/enter accept\s+x discard\s+i instruction\s+e edit/);
  await press('d');
  expect(events().at(-1).type).toBe('BlockAdded');
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('◇ accepted: 12 → 6 tok · u = undo'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 ◇', '4 three']);
  frame = await frameMatching(ui, f => /3\s+Note\s+◇ 2 blocks compacted\s+6\b/.test(f));
  expect(frame).not.toContain('●');
  expect(events().at(-1)).toEqual({ type: 'Compact', sources: [3, 4], instruction: 'keep the gist', noteId: 6, content: 'both' });
  await press('u');
  frame = await frameMatching(ui, f => f.includes('undone: compact'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two', '5 three']);
});

test('x discards the proposal; i runs again from the sources with a changed instruction; e edits the proposal (FR-15)', async () => {
  const { events } = await withUsers('one', 'two');
  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 1 block'));
  fake.reply({ chunks: ['first try'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('cold from #4 after accept'));
  await press('x');
  let frame = await frameMatching(ui, f => f.includes('proposal discarded – Context unchanged'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two']);

  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 1 block'));
  await ui.mockInput.typeText('shorter');
  fake.reply({ chunks: ['first try'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('cold from #4 after accept'));
  await press('i');
  frame = await frameMatching(ui, f => f.includes('instruction > shorter'));
  await escape();
  await frameMatching(ui, f => f.includes('attempt 1 ·') && f.includes('enter accept'));
  await press('i');
  await frameMatching(ui, f => f.includes('instruction > shorter'));
  await ui.mockInput.typeText('!');
  fake.reply({ chunks: ['2nd'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('#4 · ◇ proposal · attempt 2 · replaces #5 · "shorter!"') && f.includes('cold from #4'));
  expect((fake.chatRequests.at(-1) as Sent).messages[1]).toEqual({ role: 'user', content: '### User\ntwo\n\nInstruction: shorter!' });
  editor = async text => `${text} edited\n`;
  await press('e');
  frame = await frameMatching(ui, f => f.includes('proposal edited by hand') && f.includes('cold from #4'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('◇ accepted'));
  expect(events().at(-1)).toEqual({ type: 'Compact', sources: [4], instruction: 'shorter!', noteId: 5, content: '2nd edited' });
});

test('a request too big for the compaction window is blocked; Compaction runs on compactionProfile, leaving the session cache (FR-14, FR-17)', async () => {
  const small = startFakeLlamaCpp({ nCtx: 80 });
  try {
    const backend = await connectLlamaCpp(small.url);
    await start({ compactor: async () => ({ profile: 'small', backend }), users: ['a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(2), 'short'] });
    await press('down');
    await press('down');
    await press('c');
    await frameMatching(ui, f => /◇ Compact 1 block \(\d+ tok\) · small · request \d+ ≥ window 80 – does not fit/.test(f));
    ui.mockInput.pressEnter();
    let frame = await frameMatching(ui, f => /compaction request \d+ ≥ window 80 of small – shrink the selection/.test(f));
    expect(small.chatRequests).toEqual([]);
    await escape();
    await press('down');
    await frameMatching(ui, f => previewed(f) === 'short');
    await press('c');
    await frameMatching(ui, f => /request \d+ \/ 80/.test(f));
    small.reply({ chunks: ['s'] });
    ui.mockInput.pressEnter();
    frame = await frameMatching(ui, f => f.includes('session cache untouched'));
    expect(small.chatRequests).toHaveLength(1);
    expect(fake.chatRequests).toEqual([]);
  } finally {
    small.stop();
  }
});

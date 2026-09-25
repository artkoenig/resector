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

async function start({ timeout = 120 } = {}) {
  editor = async text => text;
  fake = startFakeLlamaCpp({ nCtx: 4096 });
  const backend = await connectLlamaCpp(fake.url);
  const log = createSessionLog(mkdtempSync(join(tmpdir(), 'resector-')), 'ses_test');
  const runner = createRunner({ cwd: project, timeout });
  const initial = newSession('default', 'You are an agent.');
  initial.forEach(log.append);
  const opened: string[] = [];
  ui = await testRender(
    () => <App backend={backend} runner={runner} editor={text => editor(text)} log={log} events={initial} reconnect={async () => backend} openSessions={() => opened.push('sessions')} onQuit={() => {}} />,
    { width: 80, height: 20 },
  );
  await frameMatching(ui, f => f.includes('52 / 4k'));
  const events = () => readFileSync(log.path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { events, opened };
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
  expect(line(frame, /default/)).toMatch(/^ default +█░+ +52 \/ 4k/);
  expect(line(frame, /Kind/)).toMatch(/#\s+Kind\s+Title\s+Tokens\s+Cache\s+Flags/);
  expect(line(frame, /System prompt/)).toMatch(/1\s+System\s+System prompt\s+12\b/);
  expect(line(frame, /Template/)).toMatch(/Template\s.*\s4\b/);
  expect(line(frame, /──/)).toMatch(/^── Content ─+$/);
  expect(previewed(frame)).toBe('You are an agent.');
  expect(frame).toContain('You are an agent.');
  expect(events()).toEqual([
    { type: 'SessionCreated', profile: 'default', protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'You are an agent.' },
    { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: TOOLS },
  ]);
});

test('Enter in input mode adds a User block without sending', async () => {
  const { events } = await start();
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('60 / 4k'));
  expect(line(frame, /hi there/)).toMatch(/3\s+User\s+hi there\s+8\b/);
  expect(fake.chatRequests).toEqual([]);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'hi there' });
});

test('Tab and Esc leave input mode without adding a block', async () => {
  await start();
  for (const leave of [async () => ui.mockInput.pressTab(), escape]) {
    ui.mockInput.pressTab();
    await frameMatching(ui, f => f.includes('Enter adds a User block'));
    await ui.mockInput.typeText('draft');
    await leave();
    const frame = await frameMatching(ui, f => f.includes('Enter send · Tab write'));
    expect(frame).not.toMatch(/3\s+User/);
  }
});

test('Enter sends the Context; the answer streams in as a new row and is logged when complete', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hello', ' world'], usage: { prompt_tokens: 24, completion_tokens: 2 }, cacheN: 16 });
  await write('hi there');
  await frameMatching(ui, f => f.includes('60 / 4k'));
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('68 / 4k'));
  expect(line(frame, /Assistant/)).toMatch(/4\s+Assistant\s+Hello world\s+8\b/);
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().slice(4)).toEqual([
    { type: 'RequestSent', hash: expect.any(String), tokens: 60 },
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hello world' },
    { type: 'ResponseReceived', usage: { prompt_tokens: 24, completion_tokens: 2 }, cached: 16 },
  ]);
});

test('Esc aborts streaming; the partial answer is kept as cut off', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hal'], hang: true });
  await write('hi there');
  await frameMatching(ui, f => f.includes('60 / 4k'));
  ui.mockInput.pressEnter();
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

test('while the answer streams, ↑↓ select and the preview scrolls; the Context stays as sent', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hal'], hang: true });
  await write('hi there');
  await frameMatching(ui, f => f.includes('60 / 4k'));
  ui.mockInput.pressEnter();
  let frame = await frameMatching(ui, f => /4\s+Assistant\s+Hal/.test(f));
  expect(frame).toContain('Esc abort · ↑↓ select · PgUp/PgDn scroll · q quit');
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
  let frame = await frameMatching(ui, f => f.includes('removed: drop'));
  expect(line(frame, /drop/)).toMatch(/^ {8}User\s+drop\s+removed/);
  const struck = ui.captureSpans().lines.flatMap(l => l.spans).find(s => s.text.includes('drop') && !s.text.includes('removed:'))!;
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
  expect(line(frame, /two/)).toMatch(/^ {3} +4\s+User/);
});

test('r renames the block for display only; empty resets', async () => {
  const { events } = await withUsers('hello there');
  await press('r');
  await frameMatching(ui, f => f.includes('title > hello there'));
  for (let i = 0; i < 'hello there'.length; i++) ui.mockInput.pressBackspace();
  await ui.mockInput.typeText('greeting');
  ui.mockInput.pressEnter();
  let frame = await frameMatching(ui, f => f.includes('renamed (display only'));
  expect(line(frame, /greeting/)).toMatch(/3\s+User\s+greeting\s+8\b/);
  expect(line(frame, /default/)).toMatch(/60 \/ 4k/);
  expect(events().at(-1)).toEqual({ type: 'Rename', id: 3, title: 'greeting' });
  await press('r');
  await frameMatching(ui, f => f.includes('title > greeting'));
  for (let i = 0; i < 'greeting'.length; i++) ui.mockInput.pressBackspace();
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('title reset'));
  expect(line(frame, /hello there/)).toMatch(/3\s+User\s+hello there/);
});

test('the header Context bar highlights the selected block', async () => {
  await start();
  await write('x '.repeat(300));
  const bar = () => ui.captureSpans().lines[0]!.spans.filter(s => s.text.includes('█'));
  const white = () => bar().filter(s => Array.from(s.fg.buffer.slice(0, 3)).join() === '255,255,255').map(s => s.text.length);
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
const cache = (frame: string) => [...frame.matchAll(/^ {2}[ ●] +(\d+) {2}.*\d +([●○]) /gm)].map(m => m[1]! + m[2]!);

test('the Cache column shows ● for rows before the invalidation point, ○ from it on (FR-3)', async () => {
  await withUsers('hi there');
  expect(cache(await frameMatching(ui, f => cache(f).length === 3))).toEqual(['1○', '2○', '3○']);
  fake.reply({ chunks: ['hello'] });
  ui.mockInput.pressEnter();
  const answered = await frameMatching(ui, f => f.includes('answer complete') && cache(f).length === 4);
  expect(cache(answered)).toEqual(['1●', '2●', '3●', '4●']);
  await write('more');
  let frame = await frameMatching(ui, f => cache(f).length === 5);
  expect(cache(frame)).toEqual(['1●', '2●', '3●', '4●', '5○']);
  expect(line(frame, /Kind/)).toMatch(/Tokens\s+Cache\s+Flags/);
  await press('up', { meta: true });
  frame = await frameMatching(ui, f => /4\s+User\s+more/.test(f) && cache(f).length === 5);
  expect(cache(frame)).toEqual(['1●', '2●', '3●', '4○', '5○']);
});

test('a server reusing fewer tokens than predicted is reported; the prediction is approximate from then on (NFR-2)', async () => {
  await withUsers('hi there');
  fake.reply({ chunks: ['hello'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  await write('more');
  fake.reply({ chunks: ['ok'], cacheN: 3 });
  await frameMatching(ui, f => cache(f).length === 5);
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('server reused'));
  // BOS + System 12 + Tools 36 + User 8 + <|im_start|> assistant \n hello
  expect(frame).toContain('answer complete · ⚠ cache: predicted 61 · server reused 3');
  expect(line(frame, /Kind/)).toMatch(/Tokens\s+Cache≈\s+Flags/);
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

test('typing / suggests the commands, filtered while typing; ↑↓ choose, Enter runs (FR-6)', async () => {
  const { opened } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/');
  let frame = await frameMatching(ui, f => f.includes('/reload'));
  expect(frame).toContain('↑↓ choose · Tab complete · Enter run · Esc back');
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
  expect(frame).toContain(' > /');
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
  await frameMatching(ui, f => f.includes('> /rename '));
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
  return (lines[lines.findIndex(l => l.startsWith('── Content')) + 1] ?? '').slice(0, -1).trim(); // last column: scrollbar
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
  await write('go');
  await frameMatching(ui, f => f.includes('go') && f.includes('Enter send · Tab write'));
  fake.reply({ chunks: text ? [text] : [], calls: commands.map(bash) });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('? approve:') && !/Tool Call .* … /.test(f));
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
  expect(frame).toContain('y run once · n reject');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('Tool Calls await approval'));
  await press('y');
  frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  expect(line(frame, /Tool Result/)).toMatch(/6\s+Tool Result\s+→ echo hello\s+\d+/);
  expect(line(frame, /Tool Call/)).not.toContain('? approve');
  expect(frame).toMatch(/^hello\s*$/m);
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
  frame = await frameMatching(ui, f => f.includes('? approve: echo two'));
  expect(previewed(frame)).toBe('echo two');
  await press('n');
  frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  expect(frame).toMatch(/4\s+Tool Call\s+echo one[^]*5\s+Tool Call\s+echo two[^]*6\s+Tool Result\s+→ echo one[^]*7\s+Tool Result\s+→ echo two/);
  expect(events().slice(-2).map(e => [e.call, e.content])).toEqual([[4, 'one\n[exit 0]'], [5, 'rejected by user']]);
});

test('Esc kills a running command: partial output + ⚠ killed (FR-21)', async () => {
  const { events } = await asked(['echo partial; sleep 5']);
  await press('y');
  let frame = await frameMatching(ui, f => f.includes('running: echo partial') && /^partial\s*$/m.test(f));
  expect(frame).toMatch(/\d+s \/ 120s/);
  expect(frame).toContain('Esc kill');
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
  await write('go');
  await frameMatching(ui, f => f.includes('go') && f.includes('Enter send · Tab write'));
  fake.reply({ chunks: ['Hm'], calls: [bash('ls')], finish: 'length' });
  ui.mockInput.pressEnter();
  let frame = await frameMatching(ui, f => f.includes('cut off at max_tokens'));
  expect(frame).not.toContain('Tool Call');
  expect(events().at(-2)).toEqual({ type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hm\nbash {"command":"ls"}', cutOff: true });
  await write('again');
  await frameMatching(ui, f => f.includes('again') && f.includes('Enter send · Tab write'));
  fake.reply({ chunks: [], calls: [{ name: 'python', arguments: '{}' }, bash('pwd')] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('tool call not run: unknown tool python'));
  expect(line(frame, /python/)).toMatch(/Assistant\s+python \{\}/);
  expect(line(frame, /Tool Call/)).toMatch(/Tool Call\s+pwd\s.*\? approve/);
});

test('more rows than fit: rows never overlap, the list follows the selection, Template stays visible', async () => {
  await withUsers(...Array.from({ length: 12 }, (_, i) => `note ${i + 3}`));
  const numbers = (f: string) => [...f.matchAll(/^ {2}[ ●] +(\d+) {2}/gm)].map(m => Number(m[1]));
  let frame = ui.captureCharFrame();
  expect(line(frame, /Kind/)).toMatch(/^ {5}# {2}Kind +Title +Tokens/);
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
  expect(frame).toContain('edited: hello → revision 2 · u = undo');
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
  await frameMatching(ui, f => f.includes('editor failed: vi exited with 1 – unchanged'));
  expect(events().some(e => e.type === 'Edit')).toBe(false);
});

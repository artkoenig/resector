// UI tests: sending the Context, its budget, streaming, thinking and the preview.
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextAttributes } from '@opentui/core';
import { frameMatching } from '../../test/frames';
import { BASH_TOOLS } from '../../test/requests';
import { TONE } from './theme';
import { cache, escape, fake, line, order, press, previewed, project, ran, start, ui, until, useHarness, withUsers, write } from './app.harness';

useHarness();

test('the Gate shows every Context Block with its exact tokens and the Template row', async () => {
  const { events } = await start();
  const frame = await frameMatching(ui, f => previewed(f) === 'You are an agent.');
  expect(line(frame, /default/)).toMatch(/^ {2}resector {2}default · thinking off +52 \/ 4k/);
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
    { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: BASH_TOOLS },
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

// The colour of the header's `tokens / window` (first line, right).
const headerTone = () => {
  const spans = ui.captureSpans().lines[0]!.spans.filter(s => /\d/.test(s.text));
  return spans.map(s => Array.from(s.fg.buffer.slice(0, 3), c => c.toString(16).padStart(2, '0')).join(''));
};

test('from 90 % of the window the tokens turn yellow', async () => {
  await start({ window: 64, users: ['short'] });
  const frame = ui.captureCharFrame();
  expect(line(frame, /default/)).toMatch(/58 \/ 64 {2}$/);
  expect(headerTone()).toEqual([TONE.warn.slice(1)]);
});

const LONG = 'a b c d e f g h i j k l m n o p q r s t';

test('a Context as big as the window blocks sending: red over by X, the bar marks the window edge', async () => {
  const { events } = await start({ window: 80, users: [LONG, 'short'] });
  let frame = ui.captureCharFrame();
  expect(line(frame, /default/)).toMatch(/102 \/ 80 over by 23 {2}$/);
  expect(headerTone()).toEqual([TONE.error.slice(1)]);
  expect(frame.split('\n')[1]).toMatch(/^ {2}▀+│▀+ *$/);
  const before = events().length;
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('over by 23 – sending blocked'));
  expect(line(frame, /sending blocked/)).toContain('d remove · e edit · c compact');
  expect(fake.chatRequests).toEqual([]);
  expect(events().slice(before).map(e => e.type)).not.toContain('RequestSent');
  // Removing the long block makes room: sent with the rest of the window as max_tokens.
  await press('down');
  await press('down');
  await press('d');
  frame = await frameMatching(ui, f => f.includes('58 / 80'));
  expect(frame.split('\n')[1]).not.toContain('│');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(fake.chatRequests[0]).toMatchObject({ max_tokens: 80 - 58 });
});

test('an inexact tokenizer shows ±drift and blocks sending that much below the window', async () => {
  const { events } = await start({ window: 80, exact: false, users: ['short'] });
  expect(line(ui.captureCharFrame(), /default/)).toMatch(/58 \/ 80 ±\? {2}$/);
  // The server counts 10 more prompt tokens than the backend did.
  fake.reply({ chunks: ['ok'], usage: { prompt_tokens: 68, completion_tokens: 1 } });
  ui.mockInput.pressEnter();
  let frame = await frameMatching(ui, f => f.includes('answer complete') && /\d+ \/ 80 ±10 {2}$/m.test(f));
  expect(events().find(e => e.type === 'RequestSent')).toMatchObject({ tokens: 58 });
  const total = Number(/(\d+) \/ 80 ±10 {2}$/m.exec(frame)![1]);
  // One word per two tokens: enough to reach the window less the drift, not the window itself.
  await write('x '.repeat(Math.ceil((70 - total - 5) / 2)).trim());
  const over = /(\d+) \/ 80 ±10 over by (\d+) {2}$/m;
  // The count comes after the block: wait for both.
  frame = await frameMatching(ui, f => f.includes('sending blocked') && over.test(f));
  const header = over.exec(frame)!;
  expect(Number(header[1])).toBeGreaterThanOrEqual(70);
  expect(Number(header[1])).toBeLessThan(80);
  expect(Number(header[2])).toBe(Number(header[1]) - 70 + 1);
  expect(fake.chatRequests).toHaveLength(1);
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

test('Esc again aborts streaming; the partial answer is kept as cut off', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hal'], hang: true });
  await write('hi there');
  const streaming = await frameMatching(ui, f => /4\s+Assistant\s+Hal/.test(f));
  expect(line(streaming, /Assistant/)).toMatch(/Hal\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  expect(events().at(-1).type).toBe('RequestSent');
  await escape();
  const stopping = await frameMatching(ui, f => f.includes('model is responding · stops after this answer'));
  expect(stopping).toContain('esc abort  q quit');
  await escape();
  const frame = await frameMatching(ui, f => /Hal\s+\d+\s+[●○]\s+⚠ cut off/.test(f));
  expect(line(frame, /Assistant/)).toMatch(/4\s+Assistant\s+Hal\s+\d+\s+●\s+⚠ cut off/);
  expect(events().slice(-2)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hal', cutOff: true },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
});

test('while the answer streams, the status shows the generation speed', async () => {
  await start();
  fake.reply({ chunks: ['Hal', 'lo', ' there'], hang: true });
  await write('hi there');
  const frame = await frameMatching(ui, f => /model is responding · \d+\.\d tok\/s/.test(f));
  expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] model is responding · \d+\.\d tok\/s/);
  // It changes once a second, though the rate falls with every frame while the stream hangs.
  const shown = new Set<string>();
  for (let i = 0; i < 25; i++) {
    await ui.renderOnce();
    shown.add(/[\d.]+ tok\/s/.exec(ui.captureCharFrame())![0]);
    await Bun.sleep(20);
  }
  expect(shown.size).toBeLessThanOrEqual(2);
  await escape();
  await escape();
  await frameMatching(ui, f => f.includes('⚠ cut off'));
});

test('while the answer streams, the preview shows it as plain text; Markdown renders once it is complete', async () => {
  await start();
  fake.reply({ chunks: ['**bold**'], delay: 0.3 });
  await write('hi there');
  const streaming = await frameMatching(ui, f => previewed(f) === '**bold**');
  expect(streaming).toContain('model is responding');
  await frameMatching(ui, f => f.includes('answer complete') && previewed(f) === 'bold');
});

test('reasoning streams dimmed into its own Thinking row, the status says thinking; it is logged before the answer', async () => {
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

test('cut off while thinking: the Thinking row streams with status thinking, Esc keeps it ⚠ cut off without Assistant block', async () => {
  const { events } = await start();
  fake.reply({ thinking: ['Let me see'], chunks: [], hang: true });
  await write('hi there');
  const streaming = await frameMatching(ui, f => /4\s+Thinking\s+Let me see/.test(f));
  expect(streaming).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] model is thinking/);
  expect(previewed(streaming)).toBe('Let me see');
  await escape();
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

test('a Thinking block the chat template drops counts 0 tokens, is dimmed and flagged ✂ template; the cache is cold from there', async () => {
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

test('the preview shows every block muted, Thinking in italics', async () => {
  await start();
  fake.reply({ thinking: ['plan it'], chunks: ['hello'] });
  await write('hi there');
  await frameMatching(ui, f => f.includes('answer complete'));
  const fg = (text: string) => {
    const span = ui.captureSpans().lines.slice(-20).flatMap(l => l.spans).findLast(s => s.text.includes(text))!;
    return Array.from(span.fg.buffer.slice(0, 3)).join();
  };
  const italic = (text: string) => {
    const spans = ui.captureSpans().lines.flatMap(l => l.spans).filter(s => s.text.includes(text));
    return spans.length > 1 && spans.every(s => (s.attributes & TextAttributes.ITALIC) !== 0);
  };
  await press('up');
  await frameMatching(ui, f => f.includes('┃ Thinking  #4'));
  expect(fg('plan it')).toBe('138,138,138');
  expect(italic('plan it')).toBe(true);
  await press('up');
  await frameMatching(ui, f => previewed(f) === 'hi there');
  expect(fg('hi there')).toBe('138,138,138');
  expect(ui.captureSpans().lines.flatMap(l => l.spans).filter(s => s.text.includes('hi there')).some(s => (s.attributes & TextAttributes.ITALIC) !== 0)).toBe(false);
});

// The colour of the last span holding `text`, once it is not the muted one: tree-sitter highlights in the background.
async function highlighted(text: string) {
  const fg = () => {
    const span = ui.captureSpans().lines.flatMap(l => l.spans).findLast(s => s.text.includes(text));
    return span ? Array.from(span.fg.buffer.slice(0, 3)).join() : '';
  };
  await until(() => fg() !== '' && fg() !== '138,138,138');
  return fg();
}

test('the preview renders Markdown: markers hidden, headings and bold stand out', async () => {
  await start();
  fake.reply({ chunks: ['# Plan\n\nfirst **bold** step\n\n- one\n- two'] });
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('answer complete') && /^┃ Plan\s/m.test(f));
  expect(frame).toMatch(/^┃ first bold step\s/m);
  expect(frame).not.toContain('**');
  const bold = ui.captureSpans().lines.flatMap(l => l.spans).findLast(s => s.text.includes('bold'))!;
  expect(bold.attributes & TextAttributes.BOLD).not.toBe(0);
});

test('a file Note is highlighted by its file type', async () => {
  writeFileSync(join(project, 'code.ts'), 'const answer = "yes";\n');
  await start();
  await write('@code.ts');
  await frameMatching(ui, f => f.includes('[code.ts]'));
  expect(await highlighted('const')).toBe('157,124,216');
  expect(await highlighted('"yes"')).toBe('127,216,143');
});

test('a bash Tool Call is highlighted as bash', async () => {
  await ran('echo "hi"');
  await press('up');
  await press('up');
  await frameMatching(ui, f => f.includes('┃ Tool Call'));
  expect(await highlighted('"hi"')).toBe('127,216,143');
});

test('while the answer streams, ↑↓ select and the preview scrolls; the Context stays as sent', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hal'], hang: true });
  await write('hi there');
  let frame = await frameMatching(ui, f => /4\s+Assistant\s+Hal/.test(f));
  expect(frame).toContain('esc stop after  q quit');
  await press('up');
  frame = await frameMatching(ui, f => previewed(f) === 'hi there');
  await press('d');
  await press('down');
  frame = await frameMatching(ui, f => previewed(f).startsWith('Hal'));
  expect(frame).not.toContain('removed');
  expect(events().at(-1).type).toBe('RequestSent');
  await escape();
  await escape();
  await frameMatching(ui, f => f.includes('⚠ cut off'));
  expect(events().filter(e => e.type === 'Remove')).toEqual([]);
});

test('the key hints stay visible next to a status', async () => {
  await withUsers('hi');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).toContain('⌥↑↓ move  e edit');
});

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

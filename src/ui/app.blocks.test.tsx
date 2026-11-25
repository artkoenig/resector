// UI tests: moving, removing, marking, editing and undoing blocks; cache and the table.
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextAttributes } from '@opentui/core';
import { frameMatching } from '../../test/frames';
import type { Tool } from '../core/log/events';
import { answered, asked, cache, copied, fake, fixture, line, messages, order, press, previewed, project, ran, type Sent, start, ui, useHarness, withUsers, write } from './app.harness';

useHarness();

test('⌥↑⌥↓ move the selected block and flag it ⇄ until sent', async () => {
  const { events } = await withUsers('first', 'second');
  await press('up', { meta: true });
  let frame = await frameMatching(ui, f => /3\s+User\s+second/.test(f));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 second', '4 first']);
  expect(line(frame, /second/)).toMatch(/⇄/);
  expect(line(frame, /first/)).not.toMatch(/⇄/);
  expect(events().at(-1)).toEqual({ type: 'Move', id: 4, after: 2, by: 'user' });
  await press('up', { meta: true });
  frame = await frameMatching(ui, f => f.includes('boundary reached'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 second', '4 first']);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => /5\s+Assistant\s+ok/.test(f) && f.includes('answer complete'));
  expect(frame).not.toContain('⇄');
});

test('p pins nothing: pinning is gone (ADR 0002)', async () => {
  const { events } = await withUsers('rules', 'question');
  const before = events().length;
  await press('up');
  await press('p');
  const frame = await frameMatching(ui, f => previewed(f) === 'rules');
  expect(frame).not.toContain('p pin');
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 rules', '4 question']);
  expect(events()).toHaveLength(before);
});

test('with marks only d and c are offered; d removes every marked block, u brings all back', async () => {
  const { events } = await withUsers('one', 'two', 'three');
  await press(' ');
  await press('up');
  await press('up');
  await press(' ');
  let frame = await frameMatching(ui, f => /●\s+3\s+User/.test(f) && f.includes('esc unmark'));
  expect(frame).not.toContain('edit');
  await press('e');
  await press('d');
  frame = await frameMatching(ui, f => f.includes('removed 2 marked blocks'));
  expect(line(frame, /one/)).toMatch(/User\s+one\s+removed/);
  expect(line(frame, /two/)).not.toMatch(/removed/);
  expect(line(frame, /three/)).toMatch(/User\s+three\s+removed/);
  expect(frame).not.toMatch(/^[ ┃] ●/m);
  expect(events().at(-1)).toEqual({ type: 'Remove', id: 3, others: [5], by: 'user' });
  await press('u');
  frame = await frameMatching(ui, f => f.includes('undone: remove'));
  expect(frame).not.toMatch(/removed\s*$/m);
});

test('while a changed Context is counted, blocks before the change keep their tokens and cache', async () => {
  await withUsers('keep', 'drop');
  const before = line(ui.captureCharFrame(), /keep/)!;
  const release = fake.holdCounts();
  await press('d');
  let frame = await frameMatching(ui, f => f.includes('removed ·'));
  expect(line(frame, /keep/)!.slice(1)).toBe(before.slice(1));
  expect(line(frame, /System prompt/)).toMatch(/System prompt\s+12\b/);
  release();
  frame = await frameMatching(ui, f => f.includes('118 / 4k'));
  expect(line(frame, /keep/)!.slice(1)).toBe(before.slice(1));
});

test('d strikes the block through until sent; u brings it back as a counter-event', async () => {
  const { events } = await withUsers('keep', 'drop');
  await press('d');
  let frame = await frameMatching(ui, f => f.includes('removed ·'));
  expect(line(frame, /drop/)).toMatch(/^ {8}User\s+drop\s+removed/);
  const struck = ui.captureSpans().lines.flatMap(l => l.spans).find(s => s.text.includes('drop') && !s.text.includes('removed ·'))!;
  expect(struck.attributes & TextAttributes.STRIKETHROUGH).toBeTruthy();
  frame = await frameMatching(ui, f => f.includes('118 / 4k'));
  expect(line(frame, /keep/)).toMatch(/3\s+User\s+keep/);
  await press('u');
  frame = await frameMatching(ui, f => f.includes('undone: remove'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 keep', '4 drop']);
  expect(events().slice(-2)).toEqual([{ type: 'Remove', id: 4, by: 'user' }, { type: 'Undo', eventId: 5 }]);
  await press('down');
  await press('d');
  fake.reply({ chunks: ['fine'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('drop');
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 keep', '4 fine']);
});

test('Space marks and unmarks the selected block; the selection stays on the last row', async () => {
  await withUsers('one', 'two');
  await press(' ');
  let frame = await frameMatching(ui, f => /●\s+4\s+User\s+two/.test(f));
  expect(previewed(frame)).toBe('two');
  await press(' ');
  frame = await frameMatching(ui, f => !f.includes('●'));
  expect(line(frame, /two/)).toMatch(/^[ ┃] {2} +4\s+User/);
});

test('Space moves the selection on to the next row, like d', async () => {
  await withUsers('one', 'two');
  await press('up');
  await press(' ');
  const frame = await frameMatching(ui, f => /●\s+3\s+User\s+one/.test(f));
  expect(previewed(frame)).toBe('two');
});

test('@ in the Context starts a file reference in the input line, r does nothing', async () => {
  writeFileSync(join(project, 'at-key.txt'), 'x\n');
  const { events } = await withUsers('hello there');
  await press('r');
  expect(ui.captureCharFrame()).toContain('Tab to write');
  await ui.mockInput.typeText('@at-k');
  const frame = await frameMatching(ui, f => f.includes('┃ @at-k') && f.includes('at-key.txt'));
  expect(frame).toContain('tab/enter complete');
  expect(events().some(e => e.type === 'Rename')).toBe(false);
});

test('the header Context bar highlights the selected block', async () => {
  await start({ users: ['x '.repeat(300)] });
  for (const k of ['down', 'down']) await press(k);
  const bar = () => ui.captureSpans().lines[1]!.spans.filter(s => s.text.includes('▀'));
  const white = () => bar().filter(s => Array.from(s.fg.buffer.slice(0, 3)).join() === '238,238,238').map(s => s.text.length);
  await frameMatching(ui, f => /\d+ \/ 4k/.test(f) && !f.includes('112 / 4k'));
  const user = white();
  await press('up');
  await ui.renderOnce();
  const system = white();
  expect(user).toHaveLength(1);
  expect(system).toHaveLength(1);
  expect(user[0]).toBeGreaterThan(system[0]!);
});

test('the header Context bar keeps the blocks before a change while it is recounted', async () => {
  await withUsers('x '.repeat(300), 'drop');
  // Cells of the bar not in the border colour (#2a2a2a): the blocks' segments.
  const filled = () =>
    ui.captureSpans().lines[1]!.spans.filter(s => s.text.includes('▀') && Array.from(s.fg.buffer.slice(0, 3)).join() !== '42,42,42').reduce((n, s) => n + s.text.length, 0);
  const before = filled();
  expect(before).toBeGreaterThan(0);
  const release = fake.holdCounts();
  await press('d');
  await frameMatching(ui, f => f.includes('removed ·'));
  expect(filled()).toBeGreaterThan(before / 2);
  release();
});

test('the Cache column shows ● for rows before the invalidation point, ○ from it on', async () => {
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

test('a server reusing fewer tokens than predicted is reported', async () => {
  await withUsers('hi there');
  fake.reply({ chunks: ['hello'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  fake.reply({ chunks: ['ok'], cacheN: 3 });
  await write('more');
  const frame = await frameMatching(ui, f => f.includes('server reused'));
  // BOS + System 12 + Tools 36 + User 8 + <|im_start|> assistant \n hello
  expect(frame).toContain('answer complete · ⚠ cache: predicted 121 · server reused 3');
  expect(line(frame, /Type/)).toMatch(/Tokens +Cache +Flags/);
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
  await start();
  fake.reply({ chunks: ['\n\n\n'] });
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(line(frame, /Assistant/)).toMatch(/Assistant\s+\(empty\)/);
});

test('only whitespace before a call adds no Assistant block', async () => {
  const { events } = await asked(['pwd'], { text: '\n\n\n' });
  expect(ui.captureCharFrame()).not.toMatch(/Assistant/);
  expect(events().filter(e => e.kind === 'Assistant')).toEqual([]);
});

test('e edits the block in $EDITOR: a new Revision flagged ✎2 until sent, the request carries it', async () => {
  const { events } = await withUsers('helo');
  const opened: string[] = [];
  fixture.editor = async text => (opened.push(text), 'hello\n');
  await press('e');
  let frame = await frameMatching(ui, f => f.includes('revision 2'));
  expect(opened).toEqual(['helo']);
  expect(line(frame, /User/)).toMatch(/3\s+User\s+hello\s+\d+\s+[●○]?\s+✎2/);
  expect(frame).toContain('edited → revision 2 · u = undo');
  expect(events().at(-1)).toEqual({ type: 'Edit', id: 3, revision: 2, content: 'hello', by: 'user' });
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
  fixture.editor = async () => 'changed';
  await press('e');
  await frameMatching(ui, f => f.includes('revision 2'));
  await press('u');
  const frame = await frameMatching(ui, f => f.includes('undone: edit'));
  expect(line(frame, /3\s+User/)).toMatch(/User\s+keep\s/);
  expect(frame).not.toContain('✎');
});

test('the Tools Block and executed Tool Calls are not opened in $EDITOR', async () => {
  await ran('echo hi');
  const opened: string[] = [];
  fixture.editor = async text => (opened.push(text), 'x');
  await press('up');
  await press('up');
  await press('e');
  await frameMatching(ui, f => f.includes('executed Tool Calls are immutable'));
  for (const k of ['up', 'up']) await press(k);
  await frameMatching(ui, f => previewed(f) === '[');
  await press('e');
  await frameMatching(ui, f => f.includes('Tools Block is not editable'));
  expect(opened).toEqual([]);
});

test('an editor that fails leaves the block unchanged', async () => {
  const { events } = await withUsers('keep');
  fixture.editor = async () => {
    throw new Error('vi exited with 1');
  };
  await press('e');
  await frameMatching(ui, f => f.includes('✗ editor failed') && f.includes('┃ vi exited with 1 – unchanged'));
  expect(events().some(e => e.type === 'Edit')).toBe(false);
});

test('text selected with the mouse in the preview is copied to the clipboard on release', async () => {
  await start();
  const frame = await frameMatching(ui, f => f.includes('You are an agent.'));
  const lines = frame.split('\n');
  const y = lines.findLastIndex(l => l.includes('You are an agent.'));
  const x = lines[y]!.indexOf('You');
  await ui.mockMouse.drag(x, y, x + 6, y);
  await frameMatching(ui, f => /copied 7 chars/.test(f));
  expect(copied).toEqual(['You are']);
  await ui.mockMouse.click(x, y);
  await ui.flush();
  expect(copied).toEqual(['You are']);
});

test('text in the block table is not selectable: dragging over it copies nothing', async () => {
  await start();
  const frame = await frameMatching(ui, f => f.includes('System prompt'));
  const lines = frame.split('\n');
  const y = lines.findIndex(l => l.includes('System prompt'));
  const x = lines[y]!.indexOf('System prompt');
  await ui.mockMouse.drag(x, y, x + 6, y);
  await ui.flush();
  expect(copied).toEqual([]);
});

test('the mouse pointer is a text cursor over the preview, a resize cursor on the split handle, the arrow elsewhere', async () => {
  await start();
  const pointers: string[] = [];
  const out = (ui.renderer as unknown as { nativeSession: { write(bytes: Uint8Array): boolean } }).nativeSession;
  const write = out.write.bind(out);
  out.write = bytes => (pointers.push(...[...new TextDecoder().decode(bytes).matchAll(/\x1b\]22;([^\x1b]*)/g)].map(m => m[1]!)), write(bytes));
  const lines = (await frameMatching(ui, f => f.includes('You are an agent.'))).split('\n');
  const text = lines.findIndex(l => l.includes('You are an agent.'));
  const handle = lines.findIndex(l => /┃ System/.test(l)) - 1;
  await ui.mockMouse.moveTo(4, text);
  await ui.flush();
  expect(pointers.at(-1)).toBe('xterm');
  await ui.mockMouse.moveTo(10, lines.findIndex(l => l.includes('System prompt')));
  await ui.flush();
  expect(pointers.at(-1)).toBe('left_ptr');
  await ui.mockMouse.moveTo(10, handle);
  await ui.flush();
  expect(pointers.at(-1)).toBe('sb_v_double_arrow');
});

test('d removes a Tool Pair as a whole; Space marks it as a whole', async () => {
  const { events } = await ran('echo hi');
  await press('up');
  let frame = await frameMatching(ui, f => /┃ hi\s*$/m.test(f));
  await press(' ');
  frame = await frameMatching(ui, f => /●\s+5\s+Tool Result/.test(f));
  expect(line(frame, /Tool Call/)).toMatch(/●\s+4\s+Tool Call/);
  await press('up');
  await press(' ');
  await frameMatching(ui, f => !/^[ ┃] ●/m.test(f));
  await press('up');
  await press('d');
  frame = await frameMatching(ui, f => f.includes('(whole Tool Pair)'));
  expect(line(frame, /Tool Call/)).toMatch(/^ {8}Tool Call\s+echo hi\s+removed/);
  expect(line(frame, /Tool Result/)).toMatch(/^ {8}Tool Result\s+→ echo hi\s+removed/);
  expect(events().at(-1)).toEqual({ type: 'Remove', id: 5, by: 'user' });
});

test('⌥↑ on a Tool Pair asks; any other key cancels; the same key again turns it into a Note and moves it', async () => {
  const { events } = await ran('echo hi', { text: 'Look.' });
  await press('up');
  await press('up', { meta: true });
  await frameMatching(ui, f => f.includes('press ⌥↑ again to confirm'));
  await press('x');
  await press('up', { meta: true });
  await frameMatching(ui, f => f.includes('press ⌥↑ again to confirm'));
  expect(events().at(-1).type).toBe('ResponseReceived');
  await press('up', { meta: true });
  let frame = await frameMatching(ui, f => /4\s+Note\s+⇄ echo hi.*⇄/.test(f));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 go', '4 ⇄', '5 Look.', '6 ok']);
  expect(frame).not.toContain('Tool Result');
  expect(events().slice(-2)).toEqual([{ type: 'PairToNote', id: 8, call: 5, by: 'user' }, { type: 'Move', id: 8, after: 3, by: 'user' }]);
  fake.reply({ chunks: ['fine'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('fine'));
  expect((fake.chatRequests[2] as Sent).messages.slice(1)).toEqual([
    { role: 'user', content: 'go' },
    { role: 'user', content: '[Tool bash: echo hi]\nhi\n[exit 0]' },
    { role: 'assistant', content: 'Look.' },
    { role: 'assistant', content: 'ok' },
  ]);
});

test('dragging the line above the preview with the mouse moves the split between table and preview', async () => {
  await withUsers('first', 'second');
  let frame = await frameMatching(ui, f => previewed(f) === 'second');
  const lines = frame.split('\n');
  const kind = lines.findIndex(l => /┃ User/.test(l));
  const handle = kind - 1;
  await ui.mockMouse.drag(10, handle, 10, handle - 2);
  frame = await frameMatching(ui, f => f.split('\n').findIndex(l => /┃ User/.test(l)) === kind - 2);
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 first', '4 second']);
  expect(copied).toEqual([]);
  await ui.mockMouse.drag(10, handle - 2, 10, handle);
  await frameMatching(ui, f => f.split('\n').findIndex(l => /┃ User/.test(l)) === kind);
});

test('a mermaid block in an answer shows as a diagram in the preview', async () => {
  await start();
  fake.reply({ chunks: ['flow:\n```mermaid\ngraph LR\n  A[Start] --> B[Done]\n```\n'] });
  await write('draw it');
  const frame = await frameMatching(ui, f => f.includes('answer complete') && f.includes('┌───────┐   ┌──────┐'));
  expect(frame).not.toContain('graph LR');
});

test('a title with a wide emoji keeps the Tokens column aligned', async () => {
  await withUsers('✅ done', 'plain');
  const frame = await frameMatching(ui, f => f.includes('plain'));
  // Columns in terminal cells: ✅ takes two.
  const column = (re: RegExp) => {
    const text = line(frame, re) ?? '';
    return Bun.stringWidth(text.slice(0, text.search(/\d+\s+○/)));
  };
  expect(column(/✅/)).toBe(column(/plain/));
});

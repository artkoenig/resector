// UI tests: Kind Filters (/filter).
import { expect, test } from 'bun:test';
import { frameMatching } from '../../test/frames';
import type { Tool } from '../core/log/events';
import { asked, escape, fake, line, order, press, previewed, ran, ui, useHarness, withUsers, write } from './app.harness';

useHarness();

// Kind Filters: additive, each on or off; a view restriction at the Gate, never logged.
test('/filter <kind> hides blocks of that Kind, again shows them; the line names the hidden ones and the share shown; nothing is logged', async () => {
  const { events } = await withUsers('one', 'two');
  const before = events().length;
  let frame = ui.captureCharFrame();
  expect(frame).not.toContain('hidden:');
  const used = /(\d+) \/ 4k/.exec(frame)![1];
  const users = [line(frame, /User\s+one/), line(frame, /User\s+two/)].map(r => Number(/User\s+\S+\s+(\d+)/.exec(r!)![1]));
  await write('/filter user');
  frame = await frameMatching(ui, f => f.includes('hidden: user'));
  expect(order(frame)).toEqual(['1 System', '2 bash']);
  expect(frame).toContain(`hidden: user · 2/4 blocks · ${Number(used) - users[0]! - users[1]! - 4}/${used} tokens`);
  await write('/filter system');
  frame = await frameMatching(ui, f => f.includes('hidden: system user'));
  expect(frame).toContain('no blocks shown');
  await write('/filter user');
  frame = await frameMatching(ui, f => f.includes('hidden: system ·'));
  expect(order(frame)).toEqual(['3 one', '4 two']);
  expect(events().length).toBe(before);
});

test('by default Tool Calls and their Tool Results are hidden; /filter tool-calls shows them', async () => {
  await ran('echo hi', { hidden: 'default' });
  let frame = await frameMatching(ui, f => f.includes('hidden: tool-calls'));
  expect(frame).toContain('hidden: tool-calls · 4/6 blocks');
  expect(frame).not.toMatch(/Tool (Call|Result)/);
  await write('/filter tool-calls');
  frame = await frameMatching(ui, f => !f.includes('hidden:'));
  expect(line(frame, /Tool Call/)).toMatch(/4\s+Tool Call\s+echo hi/);
  expect(line(frame, /Tool Result/)).toMatch(/5\s+Tool Result\s+→ echo hi/);
});

test('a Tool Call awaiting approval shows while Tool Calls are hidden; y runs it', async () => {
  const { events } = await asked(['echo hello'], { hidden: 'default' });
  let frame = ui.captureCharFrame();
  expect(line(frame, /echo hello/)).toMatch(/^┃ +4\s+Tool Call\s+echo hello .*\? approve/);
  fake.reply({ chunks: ['ok'] });
  await press('y');
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.kind === 'Tool Result').map(e => e.content)).toEqual(['hello\n[exit 0]']);
  expect(frame).not.toMatch(/Tool (Call|Result)/);
});

test('after /filter the Kinds are suggested in glossary order with on/off; all first, only while one is off', async () => {
  await withUsers('one');
  const typing = async (text: string) => {
    ui.mockInput.pressTab();
    await ui.flush();
    await ui.mockInput.typeText(text);
  };
  const suggested = (f: string) => [...f.matchAll(/^ {2}([a-z-]+) +(?:on|off|show all blocks)/gm)].map(m => m[1]);
  await typing('/filter ');
  let frame = await frameMatching(ui, f => f.includes('tool-calls'));
  expect(suggested(frame)).toEqual(['system', 'user', 'thinking', 'assistant', 'tool-calls', 'note']);
  await ui.mockInput.typeText('us');
  frame = await frameMatching(ui, f => !f.includes('tool-calls'));
  expect(suggested(frame)).toEqual(['user']);
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('hidden: user'));
  await typing('/filter t');
  frame = await frameMatching(ui, f => f.includes('tool-calls'));
  expect(suggested(frame)).toEqual(['thinking', 'tool-calls']);
  ui.mockInput.pressBackspace();
  frame = await frameMatching(ui, f => f.includes('  all'));
  expect(suggested(frame)).toEqual(['all', 'system', 'user', 'thinking', 'assistant', 'tool-calls', 'note']);
  expect(line(frame, /^ {2}user /)).toMatch(/off · User/);
});

test('/filter all shows every block again; Esc does not', async () => {
  await withUsers('one', 'two');
  await write('/filter user');
  await write('/filter system');
  await frameMatching(ui, f => f.includes('hidden: system user'));
  await escape();
  let frame = await frameMatching(ui, f => f.includes('hidden: system user'));
  await write('/filter all');
  frame = await frameMatching(ui, f => !f.includes('hidden:'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two']);
});

test('/filter with an unknown Kind is an error listing the values; the filters stay as they were', async () => {
  await withUsers('one');
  await write('/filter User');
  await frameMatching(ui, f => f.includes('hidden: user'));
  await write('/filter foo');
  const frame = await frameMatching(ui, f => f.includes('unknown filter foo'));
  expect(frame).toContain('✗ unknown filter foo');
  expect(frame).toContain('all system user thinking assistant tool-calls note');
  expect(frame).toContain('hidden: user');
});

test('hiding the selected block moves the selection to the next shown one; ↑↓ stay among the shown ones', async () => {
  await withUsers('one', 'two');
  await press('up');
  await press('up');
  await press('up');
  await write('/filter system');
  let frame = await frameMatching(ui, f => f.includes('hidden: system'));
  expect(line(frame, /one/)).toMatch(/^┃ +3\s+User/);
  await press('down');
  await press('down');
  frame = await frameMatching(ui, f => previewed(f) === 'two');
  expect(line(frame, /two/)).toMatch(/^┃ +4\s+User/);
});

test('with every block hidden the table says so and keeps the Template row; d, p and c act on nothing hidden', async () => {
  const { events } = await withUsers('one');
  await write('/filter system');
  await write('/filter user');
  const frame = await frameMatching(ui, f => f.includes('hidden: system user'));
  expect(frame).toContain('no blocks shown');
  expect(frame).toMatch(/Template\s+BOS/);
  expect(frame).not.toMatch(/^┃ [A-Z][\w ]* {2}#\d+/m);
  const before = events().length;
  await press('d');
  await press('p');
  await press('c');
  await ui.flush();
  expect(events().length).toBe(before);
  expect(ui.captureCharFrame()).not.toContain('instruction >');
});

test('⌥↑↓ does not move while blocks are hidden, and its hint is gone; a filter hiding nothing keeps it', async () => {
  const { events } = await withUsers('one', 'two');
  await write('/filter thinking');
  let frame = await frameMatching(ui, f => f.includes('thinking off'));
  expect(frame).not.toContain('hidden:');
  expect(frame).toContain('⌥↑↓ move');
  await write('/filter system');
  frame = await frameMatching(ui, f => f.includes('hidden: system thinking'));
  expect(frame).not.toContain('⌥↑↓ move');
  expect(frame).toContain('e edit');
  const before = events().length;
  await press('up', { meta: true });
  await ui.flush();
  frame = ui.captureCharFrame();
  expect(order(frame)).toEqual(['3 one', '4 two']);
  expect(events().length).toBe(before);
});

test('hiding a Kind clears the marks on its blocks; the others stay marked', async () => {
  await withUsers('one', 'two');
  await press(' ');
  await frameMatching(ui, f => /●\s+4\s+User/.test(f));
  await write('/filter system');
  await frameMatching(ui, f => f.includes('hidden: system'));
  expect(ui.captureCharFrame()).toMatch(/●\s+4\s+User/);
  await write('/filter user');
  await frameMatching(ui, f => f.includes('hidden: system user'));
  await write('/filter all');
  const frame = await frameMatching(ui, f => !f.includes('hidden:'));
  expect(frame).not.toMatch(/^[ ┃] ●/m);
});

test('the proposal of a Compaction stays visible while Notes are hidden', async () => {
  await withUsers('one', 'two');
  await write('/filter note');
  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 1 block'));
  fake.reply({ chunks: ['short'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('enter accept'));
  expect(line(frame, /Note/)).toMatch(/4\s+Note\s+◇ proposal · 1 block/);
  expect(line(frame, /User\s+two/)).toMatch(/◇ proposed/);
  expect(previewed(frame)).toBe('short');
});

test('the filters last across sending: new blocks of a hidden Kind stay hidden', async () => {
  await withUsers('one');
  await write('/filter assistant');
  fake.reply({ chunks: ['fine'] });
  await write('two');
  const frame = await frameMatching(ui, f => f.includes('answer complete') && f.includes('hidden: assistant'));
  expect(frame).toContain('hidden: assistant · 4/5 blocks');
  expect(line(frame, /two/)).toMatch(/^┃ +4\s+User/);
  expect(frame).not.toMatch(/Assistant\s+fine/);
});

test('with only removed blocks shown the table still says none are shown', async () => {
  await withUsers('one');
  await press('d');
  await write('/filter system');
  const frame = await frameMatching(ui, f => f.includes('hidden: system'));
  expect(line(frame, /one/)).toMatch(/User\s+one\s+removed/);
  expect(frame).toContain('no blocks shown');
});

test('/filter alone shows each filter on or off and the values', async () => {
  await withUsers('one');
  await write('/filter note');
  await write('/filter');
  const frame = await frameMatching(ui, f => f.includes('filter: system on'));
  expect(frame.replace(/\s+/g, ' ')).toContain('note off · /filter all system');
  expect(frame).not.toContain('✗');
});

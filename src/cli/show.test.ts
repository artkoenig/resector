// --show on stderr: the lines of each event, Thinking streamed, statuses, color only on a terminal.
import { expect, test } from 'bun:test';
import { SHOWN } from '../core/config/config';
import { createShow } from './show';

const all = () => createShow([...SHOWN], false);
const call = (content: string, tool?: 'search') => ({ type: 'BlockAdded' as const, id: 5, kind: 'Tool Call' as const, origin: 'model' as const, content, ...(tool && { tool }) });
const result = (content: string) => ({ type: 'BlockAdded' as const, id: 6, kind: 'Tool Result' as const, origin: 'tool' as const, content, call: 5 });

test('a Tool Call is one $ line, its result cut to 3 lines and how the run ended', () => {
  const show = all();
  expect(show.event(call('ls -la'))).toBe('$ ls -la\n');
  expect(show.event(call('bun docs', 'search'))).toBe('$ search bun docs\n');
  expect(show.event(result('a\nb\nc\nd\ne\n[exit 1]'))).toBe('  │ a\n  │ b\n  │ c\n  │ … 2 more lines\n  └ exit 1\n');
  expect(show.event(result('[killed]'))).toBe('  └ killed\n');
  expect(show.event(result('denied by rule'))).toBe('  │ denied by rule\n');
});

test('Notes and policy operations are ◆ lines', () => {
  const show = all();
  expect(show.event({ type: 'BlockAdded', id: 7, kind: 'Note', origin: 'compaction', content: 'the gist\nmore' })).toBe('◆ note: the gist (+1 line)\n');
  expect(show.event({ type: 'FileReferenced', id: 8, file: 'src/a.ts' })).toBe('◆ @src/a.ts\n');
  expect(show.event({ type: 'Compact', sources: [3, 4], instruction: 'merge', noteId: 9, content: 'the gist\nmore', by: 'summary-reset' })).toBe('◆ summary-reset: compact #3, #4 → the gist (+1 line)\n');
  expect(show.event({ type: 'Remove', id: 4, by: 'summary-reset' })).toBe('◆ summary-reset: remove #4\n');
  expect(show.event({ type: 'NoteAdded', id: 10, after: 9, content: 'go on', by: 'onward' })).toBe('◆ onward: note → go on\n');
  expect(show.event({ type: 'NoteAdded', id: 11, after: 9, content: 'x'.repeat(100), by: 'onward' })).toBe(`◆ onward: note → ${'x'.repeat(79)}…\n`);
  expect(show.event({ type: 'Remove', id: 4, by: 'user' })).toBe('');
  expect(show.event({ type: 'RequestSent', hash: 'h', tokens: 3 })).toBe('');
});

test('without policy, the Notes a policy writes are ◆ note lines', () => {
  const notes = createShow(['notes'], false);
  expect(notes.event({ type: 'Compact', sources: [3, 4], instruction: 'merge', noteId: 9, content: 'the gist\nmore', by: 'summary-reset' })).toBe('◆ note: the gist (+1 line)\n');
  expect(notes.event({ type: 'NoteAdded', id: 10, after: 9, content: 'go on', by: 'onward' })).toBe('◆ note: go on\n');
  expect(notes.event({ type: 'Remove', id: 4, by: 'summary-reset' })).toBe('');
});

test('only the kinds chosen are shown; statuses with any of them, errors never', () => {
  const tools = createShow(['tools'], false);
  expect(tools.event({ type: 'Remove', id: 4, by: 'summary-reset' })).toBe('');
  expect(tools.event(call('ls'))).toBe('$ ls\n');
  expect(tools.status({ text: 'not run: no user to approve', tone: 'warn' })).toBe('· not run: no user to approve\n');
  expect(tools.status({ text: 'backend error: gone', tone: 'error' })).toBe('');
  const none = createShow([], false);
  expect([none.event(call('ls')), none.thinking('hm'), none.status({ text: 'x', tone: 'info' })]).toEqual(['', '', '']);
});

test('Thinking streams: only the new text, ∴ before each line; end closes the line', () => {
  const show = all();
  expect(show.thinking('Let me')).toBe('∴ Let me');
  expect(show.thinking('Let me look\nat it')).toBe(' look\n∴ at it');
  expect(show.end()).toBe('\n');
  expect(show.end()).toBe('');
  expect(show.thinking('Again')).toBe('∴ Again');
});

test('an event or status while Thinking streams starts on a new line; the Thinking goes on after ∴', () => {
  const show = all();
  show.thinking('Let me');
  expect(show.event(call('ls'))).toBe('\n$ ls\n');
  expect(show.thinking('Let me look')).toBe('∴  look');
  expect(show.status({ text: 'x', tone: 'info' })).toBe('\n· x\n');
  expect(show.end()).toBe('');
});

test('with color the lines are painted', () => {
  expect(createShow(['tools'], true).event(call('ls'))).toBe('\x1b[36m$\x1b[0m ls\n');
});

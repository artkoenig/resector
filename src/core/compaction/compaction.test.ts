import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { fold } from '../log/fold';
import { undo } from '../context/operations';
import { accept, COMPACTION_SYSTEM, compactionRequest, DEFAULT_INSTRUCTION, reduction, sourcesOf } from './compaction';

const session = (...then: SessionEvent[]): SessionEvent[] => [
  { type: 'SessionCreated', profile: 'default', protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
  { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: '[]' },
  { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'find the bug' },
  { type: 'BlockAdded', id: 4, kind: 'Tool Call', origin: 'model', content: 'ls' },
  { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'a b\n[exit 0]', call: 4 },
  { type: 'BlockAdded', id: 6, kind: 'Assistant', origin: 'model', content: 'found it' },
  ...then,
];
const NOTHING = { error: 'nothing to compact (System, Tools and pending Tool Calls, unread @path references are excluded)' };

test('the sources are the marked blocks in Context order', () => {
  expect(sourcesOf(fold(session()), new Set([6, 3]), 1)).toEqual({ sources: [3, 6] });
});

test('without marks the selected block is the source, a Tool Pair as a whole', () => {
  expect(sourcesOf(fold(session()), new Set(), 3)).toEqual({ sources: [3] });
  expect(sourcesOf(fold(session()), new Set(), 5)).toEqual({ sources: [4, 5] });
});

test('a selection that is no block (the live row) has no sources', () => {
  expect(sourcesOf(fold(session()), new Set(), 99)).toEqual(NOTHING);
});

test('the model is told to rewrite into one note; the default instruction keeps what the task needs', () => {
  expect(COMPACTION_SYSTEM).toBe('Rewrite the given context blocks into one compact note, following the instruction. Output only the note.');
  expect(DEFAULT_INSTRUCTION).toBe('Keep file paths, line numbers, decisions, errors and open todos. Drop passing output and code already fixed.');
});

test('System, Tools Block, pending Tool Calls and removed blocks are never sources', () => {
  const events = session({ type: 'BlockAdded', id: 7, kind: 'Tool Call', origin: 'model', content: 'pwd' }, { type: 'Remove', id: 6 });
  expect(sourcesOf(fold(events), new Set([1, 2, 6, 7]), 1)).toEqual(NOTHING);
  expect(sourcesOf(fold(events), new Set(), 1)).toEqual(NOTHING);
  expect(sourcesOf(fold(events), new Set(), 7)).toEqual(NOTHING);
  expect(sourcesOf(fold(events), new Set([3, 7]), 1)).toEqual({ sources: [3] });
});

test('the request holds only the sources, in Context order, and the instruction', () => {
  const context = fold(session());
  expect(compactionRequest(context, [6, 4, 5], 'keep errors')).toEqual({
    messages: [
      { role: 'system', content: COMPACTION_SYSTEM },
      { role: 'user', content: '# Tool Call\nls\n\n# Tool Result\na b\n[exit 0]\n\n# Assistant\nfound it\n\nInstruction: keep errors' },
    ],
    tools: [],
  });
});

test('accept logs the Compaction; an empty proposal is not accepted', () => {
  expect(accept([3, 6], 'keep', 7, 'gist')).toEqual({ event: { type: 'Compact', sources: [3, 6], instruction: 'keep', noteId: 7, content: 'gist' } });
  expect(accept([3, 6], 'keep', 7, ' \n')).toEqual({ error: 'empty proposal – e to edit, i to change the instruction, x to discard' });
});

test('u undoes a Compaction', () => {
  const events = session({ type: 'Compact', sources: [3], instruction: 'keep', noteId: 7, content: 'gist' });
  expect(undo(events)).toEqual({ event: { type: 'Undo', eventId: events.length - 1 } });
});

test('reduction is the share of tokens saved, in whole percent', () => {
  expect(reduction(200, 50)).toBe(75);
  expect(reduction(3, 2)).toBe(33);
  expect(reduction(100, 120)).toBe(-20);
  expect(reduction(0, 5)).toBe(0);
});

test('an unread @path reference is not compacted: it is read only on send', () => {
  const events = session({ type: 'FileReferenced', id: 9, file: 'a.ts' });
  expect(sourcesOf(fold(events), new Set(), 9)).toEqual(NOTHING);
});

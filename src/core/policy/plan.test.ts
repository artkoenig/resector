import { expect, test } from 'bun:test';
import { plan, summary, type Change } from './plan';
import type { PolicyOperation } from './policy';
import { pending, session } from './policy.harness';

const planOf = (op: PolicyOperation, events = session()) => plan(events, op);

test('remove: the block, a Tool Pair as a whole', () => {
  expect(planOf({ op: 'remove', id: 3 })).toEqual({ events: [{ type: 'Remove', id: 3 }], change: { noun: 'Thinking', verb: 'removed' } });
  expect(planOf({ op: 'remove', id: 6 })).toEqual({ events: [{ type: 'Remove', id: 6 }], change: { noun: 'Tool Pair', verb: 'removed' } });
});

test('System, Tools Block, pending Tool Calls and blocks not sent are untouchable', () => {
  expect(planOf({ op: 'remove', id: 1 })).toEqual({ error: 'System prompt cannot be removed' });
  expect(planOf({ op: 'remove', id: 8 }, session(pending))).toEqual({ error: 'Tool Call awaits approval – y run once · a allow for session · n reject · e edit' });
  expect(planOf({ op: 'remove', id: 3 }, session({ type: 'Remove', id: 3 }))).toEqual({ error: 'no block 3 in the Context' });
  expect(planOf({ op: 'remove', id: 99 })).toEqual({ error: 'no block 99 in the Context' });
  expect(planOf({ op: 'edit', id: 99, content: 'x' })).toEqual({ error: 'no block 99 in the Context' });
  expect(planOf({ op: 'move', id: 99, after: 3 })).toEqual({ error: 'no block 99 in the Context' });
});

test('edit: the content as is becomes the next Revision', () => {
  expect(planOf({ op: 'edit', id: 7, content: 'go on\n' })).toEqual({ events: [{ type: 'Edit', id: 7, revision: 2, content: 'go on\n' }], change: { noun: 'block', verb: 'edited' } });
  expect(planOf({ op: 'edit', id: 6, content: 'a' })).toMatchObject({ events: [{ type: 'Edit', id: 6, content: 'a' }] });
});

test('edit: not System, Tools Block, a pending or an executed Tool Call, nor to the same content', () => {
  expect(planOf({ op: 'edit', id: 1, content: 'x' })).toEqual({ error: 'System prompt is fixed' });
  expect(planOf({ op: 'edit', id: 2, content: 'x' })).toEqual({ error: 'Tools Block is fixed' });
  expect(planOf({ op: 'edit', id: 8, content: 'x' }, session(pending))).toMatchObject({ error: expect.stringContaining('awaits approval') });
  expect(planOf({ op: 'edit', id: 5, content: 'x' })).toEqual({ error: 'executed Tool Calls are immutable' });
  expect(planOf({ op: 'edit', id: 7, content: 'go on' })).toEqual({ error: 'unchanged – no new Revision' });
});

test('move: the block after another; a Tool Pair becomes a Note first, then moves', () => {
  expect(planOf({ op: 'move', id: 7, after: 3 })).toEqual({ events: [{ type: 'Move', id: 7, after: 3 }], change: { noun: 'block', verb: 'moved' } });
  expect(planOf({ op: 'move', id: 6, after: 3 })).toEqual({
    events: [{ type: 'PairToNote', id: 8, call: 5 }, { type: 'Move', id: 8, after: 3 }],
    change: { noun: 'block', verb: 'moved' },
  });
  expect(planOf({ op: 'move', id: 7, after: 1 })).toEqual({ error: 'System and Tools Block stay first' });
  expect(planOf({ op: 'move', id: 7, after: 6 })).toEqual({ error: 'unchanged – already there' });
  expect(planOf({ op: 'move', id: 5, after: 1 })).toEqual({ error: 'System and Tools Block stay first' });
});

test('compact: the sources in Context order, a Tool Pair as a whole, with the instruction', () => {
  expect(planOf({ op: 'compact', sources: [7, 3], instruction: 'short' })).toEqual({ compact: { sources: [3, 7], instruction: 'short' }, change: { text: '1 Thinking + 1 User → 1 Note' } });
  expect(planOf({ op: 'compact', sources: [5, 3], instruction: 'short' })).toEqual({ compact: { sources: [3, 5, 6], instruction: 'short' }, change: { text: '1 Thinking + 1 Tool Pair → 1 Note' } });
  expect(planOf({ op: 'compact', sources: [6, 5], instruction: 'short' })).toMatchObject({ change: { text: '1 Tool Pair → 1 Note' } });
});

test('compact: every source sent and touchable, at least one, and an instruction', () => {
  expect(planOf({ op: 'compact', sources: [3, 2], instruction: 'i' })).toEqual({ error: 'Tools Block is fixed' });
  expect(planOf({ op: 'compact', sources: [3, 99], instruction: 'i' })).toEqual({ error: 'no block 99 in the Context' });
  expect(planOf({ op: 'compact', sources: [], instruction: 'i' })).toEqual({ error: 'nothing to compact' });
  expect(planOf({ op: 'compact', sources: [3], instruction: ' ' })).toEqual({ error: 'no instruction' });
});

test('note: a Note with the content after the block, the next id', () => {
  expect(planOf({ op: 'note', after: 2, content: 'about' })).toEqual({ events: [{ type: 'NoteAdded', id: 8, after: 2, content: 'about' }], change: { noun: 'Note', verb: 'added' } });
  expect(planOf({ op: 'note', after: 1, content: 'about' })).toEqual({ error: 'System and Tools Block stay first' });
  expect(planOf({ op: 'note', after: 2, content: '' })).toEqual({ error: 'empty Note' });
});

test('the summary counts what the policy did, a Tool Pair and a block counted in plural', () => {
  const changes: Change[] = [
    { noun: 'Tool Pair', verb: 'removed' }, { noun: 'Thinking', verb: 'removed' }, { noun: 'Tool Pair', verb: 'removed' },
    { text: '5 Thinking → 1 Note' }, { noun: 'Thinking', verb: 'removed' }, { noun: 'block', verb: 'edited' }, { noun: 'block', verb: 'edited' }, { noun: 'block', verb: 'moved' },
  ];
  expect(summary('trail', changes)).toBe('trail: 2 Tool Pairs removed, 2 Thinking removed, 5 Thinking → 1 Note, 2 blocks edited, 1 block moved');
  expect(summary('trail', [{ text: 'a' }, { text: 'a' }])).toBe('trail: a, a');
  expect(summary('trail', [])).toBe('trail: no change');
});

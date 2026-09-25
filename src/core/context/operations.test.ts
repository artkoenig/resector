import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { fold } from '../log/fold';
import { approvable, isFixed, move, nextCall, pin, reject, remove, rename, toolResult, undo } from './operations';

const session = (...then: SessionEvent[]): SessionEvent[] => [
  { type: 'SessionCreated', profile: 'default', protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
  { type: 'BlockAdded', id: 2, kind: 'User', origin: 'user', content: 'a' },
  { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'b' },
  { type: 'BlockAdded', id: 4, kind: 'User', origin: 'user', content: 'c' },
  ...then,
];
const at = (events: SessionEvent[], id: number) => {
  const context = fold(events);
  return [context, context.blocks.find(b => b.id === id)!] as const;
};
const FIXED = { error: 'System prompt is fixed' };
const BOUNDARY = { error: 'boundary reached (fixed / pinned area)' };

test('move up anchors the block after the neighbour’s predecessor', () => {
  expect(move(...at(session(), 3), -1)).toEqual({ event: { type: 'Move', id: 3, after: 1 } });
  expect(move(...at(session(), 4), -1)).toEqual({ event: { type: 'Move', id: 4, after: 2 } });
});

test('move down anchors the block after its neighbour', () => {
  expect(move(...at(session(), 2), 1)).toEqual({ event: { type: 'Move', id: 2, after: 3 } });
});

test('move skips struck-through blocks', () => {
  const events = session({ type: 'Remove', id: 3 });
  expect(move(...at(events, 2), 1)).toEqual({ event: { type: 'Move', id: 2, after: 4 } });
  expect(move(...at(events, 4), -1)).toEqual({ event: { type: 'Move', id: 4, after: 1 } });
});

test('move stops at System, the ends, and the pinned areas', () => {
  expect(move(...at(session(), 1), 1)).toEqual(FIXED);
  expect(move(...at(session(), 2), -1)).toEqual(BOUNDARY);
  expect(move(...at(session(), 4), 1)).toEqual(BOUNDARY);
  const pinned = session({ type: 'Pin', id: 2, at: 'top' }, { type: 'Pin', id: 4, at: 'bottom' });
  expect(move(...at(pinned, 3), -1)).toEqual(BOUNDARY);
  expect(move(...at(pinned, 3), 1)).toEqual(BOUNDARY);
});

test('pinned blocks reorder among themselves', () => {
  const pinned = session({ type: 'Pin', id: 2, at: 'top' }, { type: 'Pin', id: 3, at: 'top' });
  expect(move(...at(pinned, 3), -1)).toEqual({ event: { type: 'Move', id: 3, after: 1 } });
});

test('pin cycles top → bottom → off', () => {
  expect(pin(at(session(), 2)[1])).toEqual({ event: { type: 'Pin', id: 2, at: 'top' } });
  expect(pin(at(session({ type: 'Pin', id: 2, at: 'top' }), 2)[1])).toEqual({ event: { type: 'Pin', id: 2, at: 'bottom' } });
  expect(pin(at(session({ type: 'Pin', id: 2, at: 'bottom' }), 2)[1])).toEqual({ event: { type: 'Unpin', id: 2 } });
  expect(pin(at(session(), 1)[1])).toEqual(FIXED);
});

test('remove any block but System', () => {
  expect(remove(at(session(), 3)[1])).toEqual({ event: { type: 'Remove', id: 3 } });
  expect(remove(at(session(), 1)[1])).toEqual({ error: 'System prompt cannot be removed' });
});

test('rename trims the title; empty resets', () => {
  expect(rename(at(session(), 2)[1], '  greeting ')).toEqual({ event: { type: 'Rename', id: 2, title: 'greeting' } });
  expect(rename(at(session(), 2)[1], '  ')).toEqual({ event: { type: 'Rename', id: 2, title: '' } });
});

test('undo names the latest Context operation not yet undone', () => {
  const events = session({ type: 'Remove', id: 2 }, { type: 'Rename', id: 3, title: 'x' }, { type: 'RequestSent', hash: 'h', tokens: 1 });
  expect(undo(events)).toEqual({ event: { type: 'Undo', eventId: 6 } });
  expect(undo([...events, { type: 'Undo', eventId: 6 }])).toEqual({ event: { type: 'Undo', eventId: 5 } });
  for (const op of [{ type: 'Move', id: 3, after: 1 }, { type: 'Pin', id: 3, at: 'top' }, { type: 'Unpin', id: 3 }] as SessionEvent[])
    expect(undo(session(op))).toEqual({ event: { type: 'Undo', eventId: 5 } });
});

test('undo has nothing to cancel without Context operations', () => {
  expect(undo(session())).toEqual({ error: 'nothing to undo' });
  expect(undo(session({ type: 'Remove', id: 2 }, { type: 'Undo', eventId: 5 }))).toEqual({ error: 'nothing to undo' });
});

const tools: SessionEvent = { type: 'BlockAdded', id: 5, kind: 'Tools', origin: 'config', content: '[]' };
const call = (id: number): SessionEvent => ({ type: 'BlockAdded', id, kind: 'Tool Call', origin: 'model', content: `cmd ${id}` });
const answered = (id: number, of: number): SessionEvent => ({ type: 'BlockAdded', id, kind: 'Tool Result', origin: 'tool', content: 'out', call: of });
const AWAITS = { error: 'Tool Call awaits approval – y run once · n reject' };

test('the Tools Block is fixed like System (FR-12)', () => {
  const [context, block] = at(session(tools), 5);
  expect(isFixed(block)).toBe(true);
  expect(move(context, block, -1)).toEqual({ error: 'Tools Block is fixed' });
  expect(pin(block)).toEqual({ error: 'Tools Block is fixed' });
  expect(remove(block)).toEqual({ error: 'Tools Block cannot be removed' });
  expect(isFixed(at(session(), 2)[1])).toBe(false);
});

test('a Tool Call awaiting approval is not moved, pinned or removed', () => {
  const events = session(call(6));
  expect(move(...at(events, 6), -1)).toEqual(AWAITS);
  expect(pin(at(events, 6)[1])).toEqual(AWAITS);
  expect(remove(at(events, 6)[1])).toEqual(AWAITS);
  expect(remove(at([...events, answered(7, 6)], 6)[1])).toEqual({ event: { type: 'Remove', id: 6 } });
});

test('Tool Calls are approved one by one in order (FR-24)', () => {
  const events = session(call(6), call(7), answered(8, 6), call(9));
  expect(nextCall(fold(events))?.id).toBe(7);
  expect(approvable(...at(events, 7))).toBeNull();
  expect(approvable(...at(events, 9))).toBe('approve the earlier Tool Call first');
  expect(approvable(...at(events, 6))).toBe('not awaiting approval');
  expect(approvable(...at(events, 2))).toBe('not awaiting approval');
  expect(nextCall(fold(session()))).toBeUndefined();
});

test('reject answers the call with a Tool Result "rejected by user" (FR-23)', () => {
  const events = session(call(6), call(7));
  expect(reject(...at(events, 6), 8)).toEqual({
    event: { type: 'BlockAdded', id: 8, kind: 'Tool Result', origin: 'tool', content: 'rejected by user', call: 6 },
  });
  expect(reject(...at(events, 7), 8)).toEqual({ error: 'approve the earlier Tool Call first' });
});

test('a run becomes the Tool Result of its call, flagged when stopped', () => {
  const [, block] = at(session(call(6)), 6);
  expect(toolResult(block, 7, { output: 'x', exit: 0, stopped: null }, 120)).toEqual({
    type: 'BlockAdded', id: 7, kind: 'Tool Result', origin: 'tool', content: 'x\n[exit 0]', call: 6,
  });
  expect(toolResult(block, 7, { output: '', exit: null, stopped: 'killed' }, 120)).toEqual({
    type: 'BlockAdded', id: 7, kind: 'Tool Result', origin: 'tool', content: '[killed]', call: 6, stopped: 'killed',
  });
});

import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { fold } from '../log/fold';
import { move, pin, remove, rename, undo } from './operations';

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
  expect(rename(at(session(), 2)[1], '  greeting ')).toEqual({ type: 'Rename', id: 2, title: 'greeting' });
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

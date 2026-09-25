import { expect, test } from 'bun:test';
import type { SessionEvent } from './events';
import { fold, undone } from './fold';

test('Context holds the session profile and the added blocks in order', () => {
  const context = fold([
    { type: 'SessionCreated', profile: 'default', protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'You are an agent.' },
    { type: 'BlockAdded', id: 2, kind: 'User', origin: 'user', content: 'hi' },
    { type: 'RequestSent', hash: 'abc', tokens: 12 },
    { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'hello', cutOff: true },
    { type: 'ResponseReceived', usage: { prompt_tokens: 12, completion_tokens: 1 }, cached: 0 },
  ]);
  expect(context).toEqual({
    profile: 'default',
    protocol: 'native',
    blocks: [
      { id: 1, kind: 'System', origin: 'config', content: 'You are an agent.', cutOff: false, title: null, pin: null, removed: false, moved: false, pinChanged: false },
      { id: 2, kind: 'User', origin: 'user', content: 'hi', cutOff: false, title: null, pin: null, removed: false, moved: false, pinChanged: false },
      { id: 3, kind: 'Assistant', origin: 'model', content: 'hello', cutOff: true, title: null, pin: null, removed: false, moved: false, pinChanged: false },
    ],
    nextId: 4,
  });
});

test('an empty log is rejected', () => {
  expect(() => fold([])).toThrow('Session Log must start with SessionCreated');
});

test('a log without SessionCreated is rejected', () => {
  expect(() => fold([{ type: 'BlockAdded', id: 1, kind: 'User', origin: 'user', content: 'hi' }])).toThrow(
    'Session Log must start with SessionCreated',
  );
});

// Session with System + User blocks 2..n; `then` events follow.
const session = (users: number, ...then: SessionEvent[]): SessionEvent[] => [
  { type: 'SessionCreated', profile: 'default', protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
  ...Array.from({ length: users }, (_, i): SessionEvent => ({ type: 'BlockAdded', id: i + 2, kind: 'User', origin: 'user', content: `u${i + 2}` })),
  ...then,
];
const ids = (events: SessionEvent[]) => fold(events).blocks.map(b => b.id);
const block = (events: SessionEvent[], id: number) => fold(events).blocks.find(b => b.id === id)!;
const sent: SessionEvent = { type: 'RequestSent', hash: 'h', tokens: 1 };

test('a new block starts unpinned, untitled and unflagged', () => {
  expect(block(session(1), 2)).toEqual({
    id: 2, kind: 'User', origin: 'user', content: 'u2', cutOff: false,
    title: null, pin: null, removed: false, moved: false, pinChanged: false,
  });
});

test('nextId follows the highest block id, also past hidden blocks', () => {
  expect(fold(session(0)).nextId).toBe(2);
  expect(fold(session(2, { type: 'Remove', id: 3 }, sent)).nextId).toBe(4);
});

test('Move puts the block right after its anchor and flags it until the next request', () => {
  const moved = session(3, { type: 'Move', id: 4, after: 1 });
  expect(ids(moved)).toEqual([1, 4, 2, 3]);
  expect(block(moved, 4).moved).toBe(true);
  expect(block(moved, 2).moved).toBe(false);
  expect(block([...moved, sent], 4).moved).toBe(false);
});

test('Move down past the neighbour', () => {
  expect(ids(session(3, { type: 'Move', id: 2, after: 3 }))).toEqual([1, 3, 2, 4]);
});

test('Pin top goes right after System and earlier top pins, keeping their order', () => {
  const events = session(3, { type: 'Pin', id: 3, at: 'top' }, { type: 'Pin', id: 4, at: 'top' });
  expect(ids(events)).toEqual([1, 3, 4, 2]);
  expect(block(events, 3)).toMatchObject({ pin: 'top', pinChanged: true });
});

test('Pin bottom goes to the very end; blocks added later stay above bottom pins', () => {
  const events = session(2, { type: 'Pin', id: 2, at: 'bottom' }, { type: 'Pin', id: 3, at: 'bottom' },
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'a' });
  expect(ids(events)).toEqual([1, 4, 2, 3]);
  expect(block(events, 2).pin).toBe('bottom');
});

test('Unpin puts the block at the end of the unpinned area, before bottom pins', () => {
  const events = session(3, { type: 'Pin', id: 2, at: 'top' }, { type: 'Pin', id: 3, at: 'bottom' }, { type: 'Unpin', id: 2 });
  expect(ids(events)).toEqual([1, 4, 2, 3]);
  expect(block(events, 2)).toMatchObject({ pin: null, pinChanged: false });
});

test('the pin flag compares with the pin at the last request', () => {
  const pinned = session(1, { type: 'Pin', id: 2, at: 'top' }, sent);
  expect(block(pinned, 2)).toMatchObject({ pin: 'top', pinChanged: false });
  expect(block([...pinned, { type: 'Pin', id: 2, at: 'bottom' }], 2).pinChanged).toBe(true);
  expect(block([...pinned, { type: 'Unpin', id: 2 }], 2).pinChanged).toBe(true);
});

test('Remove strikes the block until the next request, then hides it', () => {
  const removed = session(2, { type: 'Remove', id: 2 });
  expect(block(removed, 2).removed).toBe(true);
  expect(block(removed, 3).removed).toBe(false);
  expect(ids([...removed, sent])).toEqual([1, 3]);
});

test('Rename sets a display title; an empty title resets it', () => {
  const renamed = session(1, { type: 'Rename', id: 2, title: 'greeting' });
  expect(block(renamed, 2).title).toBe('greeting');
  expect(block([...renamed, { type: 'Rename', id: 2, title: '' }], 2).title).toBeNull();
});

test('Undo cancels the named event, even across a request', () => {
  const events = session(3, { type: 'Move', id: 4, after: 1 }, { type: 'Remove', id: 2 }, sent, { type: 'Undo', eventId: 6 });
  expect(ids(events)).toEqual([1, 4, 2, 3]);
  expect(block(events, 2).removed).toBe(false);
});

test('undone lists the event ids cancelled by Undo events', () => {
  expect([...undone(session(1, { type: 'Remove', id: 2 }, { type: 'Undo', eventId: 3 }))]).toEqual([3]);
});

test('undoing an operation already sent flags the change again', () => {
  const moved = session(2, { type: 'Move', id: 3, after: 1 }, { type: 'Pin', id: 2, at: 'top' }, sent);
  const undoneAfterSend = [...moved, { type: 'Undo', eventId: 5 }, { type: 'Undo', eventId: 4 }] satisfies SessionEvent[];
  expect(block(undoneAfterSend, 3)).toMatchObject({ moved: true });
  expect(block(undoneAfterSend, 2)).toMatchObject({ pin: null, pinChanged: true });
  const undoneBeforeSend = session(2, { type: 'Move', id: 3, after: 1 }, { type: 'Pin', id: 2, at: 'top' }, { type: 'Undo', eventId: 5 }, { type: 'Undo', eventId: 4 });
  expect(block(undoneBeforeSend, 3)).toMatchObject({ moved: false });
  expect(block(undoneBeforeSend, 2)).toMatchObject({ pin: null, pinChanged: false });
  expect(block([...undoneAfterSend, sent], 3)).toMatchObject({ moved: false });
});

test('undoing a sent Unpin flags the pin again; undoing other operations flags nothing', () => {
  const unpinned = session(2, { type: 'Pin', id: 2, at: 'top' }, sent, { type: 'Unpin', id: 2 }, sent, { type: 'Undo', eventId: 6 });
  expect(block(unpinned, 2)).toMatchObject({ pin: 'top', pinChanged: true });
  const removed = session(2, { type: 'Remove', id: 3 }, { type: 'Rename', id: 2, title: 'x' }, sent, { type: 'Undo', eventId: 5 }, { type: 'Undo', eventId: 4 });
  expect(block(removed, 3)).toMatchObject({ moved: false, pinChanged: false, removed: false });
  expect(block(removed, 2)).toMatchObject({ moved: false, pinChanged: false, title: null });
});

test('a ProfileFallback replaces the session profile (FR-35)', () => {
  expect(fold(session(0, { type: 'ProfileFallback', profile: 'qwen' })).profile).toBe('qwen');
});

test('a session rename changes no block', () => {
  expect(fold(session(1, { type: 'SessionRenamed', title: 'x' })).blocks).toEqual(fold(session(1)).blocks);
});

import { expect, test } from 'bun:test';
import type { SessionEvent } from '../core/log/events';
import { fold } from '../core/log/fold';
import { review } from './review';

// Session with System + User blocks 2..n; `then` events follow.
const session = (users: number, ...then: SessionEvent[]): SessionEvent[] => [
  { type: 'SessionCreated', profile: 'default', protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
  ...Array.from({ length: users }, (_, i): SessionEvent => ({ type: 'BlockAdded', id: i + 2, kind: 'User', origin: 'user', content: `u${i + 2}` })),
  ...then,
];
const shown = (events: SessionEvent[]) => review(events, fold(events));
const ids = (events: SessionEvent[]) => shown(events).map(b => b.id);
const block = (events: SessionEvent[], id: number) => shown(events).find(b => b.id === id)!;
const sent: SessionEvent = { type: 'RequestSent', hash: 'h', tokens: 1 };
const edit = (id: number, revision: number, content: string): SessionEvent => ({ type: 'Edit', id, revision, content });
const call = (id: number, command: string): SessionEvent => ({ type: 'BlockAdded', id, kind: 'Tool Call', origin: 'model', content: command });
const result = (id: number, of: number): SessionEvent => ({ type: 'BlockAdded', id, kind: 'Tool Result', origin: 'tool', content: `out ${of}`, call: of });

test('a new block is shown untitled and unflagged', () => {
  expect(block(session(1), 2)).toEqual({ id: 2, kind: 'User', origin: 'user', content: 'u2', cutOff: false, revision: 1, title: null, removed: false, moved: false, revised: false });
});

test('a moved block is flagged until the next request', () => {
  const moved = session(3, { type: 'Move', id: 4, after: 1 });
  expect(ids(moved)).toEqual([1, 4, 2, 3]);
  expect(block(moved, 4).moved).toBe(true);
  expect(block(moved, 2).moved).toBe(false);
  expect(block([...moved, sent], 4).moved).toBe(false);
});

test('a removed block is struck through in its place until the next request, then gone', () => {
  const removed = session(2, { type: 'Remove', id: 2 });
  expect(ids(removed)).toEqual([1, 2, 3]);
  expect(block(removed, 2).removed).toBe(true);
  expect(block(removed, 3).removed).toBe(false);
  expect(ids([...removed, sent])).toEqual([1, 3]);
});

test('a removed Tool Pair is struck through as a whole; its call no longer awaits approval', () => {
  const events = session(1, call(3, 'ls'), result(4, 3), { type: 'Remove', id: 4 });
  expect([3, 4].map(id => block(events, id))).toMatchObject([{ removed: true, pending: false }, { removed: true }]);
});

test('Rename sets a display title; an empty title resets it; undo restores the one before', () => {
  const renamed = session(1, { type: 'Rename', id: 2, title: 'greeting' });
  expect(block(renamed, 2).title).toBe('greeting');
  expect(block([...renamed, { type: 'Rename', id: 2, title: '' }], 2).title).toBeNull();
  expect(block([...renamed, { type: 'Rename', id: 2, title: 'hello' }, { type: 'Undo', eventId: 4 }], 2).title).toBe('greeting');
});

test('a new Revision is flagged until the next request', () => {
  const events = session(1, edit(2, 2, 'x'));
  expect(block(events, 2).revised).toBe(true);
  expect(block([...events, sent], 2)).toMatchObject({ revision: 2, revised: false });
  expect(block([...events, sent, edit(2, 3, 'y')], 2)).toMatchObject({ revision: 3, revised: true });
});

test('undoing an Edit is flagged only when the Edit was sent', () => {
  expect(block(session(1, edit(2, 2, 'x'), { type: 'Undo', eventId: 3 }), 2)).toMatchObject({ revision: 1, revised: false });
  expect(block(session(1, edit(2, 2, 'x'), sent, { type: 'Undo', eventId: 3 }), 2)).toMatchObject({ revision: 1, revised: true });
});

test('undoing a Move already sent flags the change again', () => {
  const moved = session(2, { type: 'Move', id: 3, after: 1 }, sent);
  const undoneAfterSend = [...moved, { type: 'Undo', eventId: 4 }] satisfies SessionEvent[];
  expect(block(undoneAfterSend, 3)).toMatchObject({ moved: true });
  expect(block(session(2, { type: 'Move', id: 3, after: 1 }, { type: 'Undo', eventId: 4 }), 3)).toMatchObject({ moved: false });
  expect(block([...undoneAfterSend, sent], 3)).toMatchObject({ moved: false });
});

test('undoing other sent operations flags nothing', () => {
  const events = session(2, { type: 'Remove', id: 3 }, { type: 'Rename', id: 2, title: 'x' }, sent, { type: 'Undo', eventId: 5 }, { type: 'Undo', eventId: 4 });
  expect(block(events, 3)).toMatchObject({ moved: false, removed: false, revised: false });
  expect(block(events, 2)).toMatchObject({ moved: false, title: null, revised: false });
});

test('a block brought back by undo keeps the Revision it was sent with', () => {
  const events = session(2, edit(3, 2, 'x'), sent, { type: 'Remove', id: 3 }, sent, { type: 'Undo', eventId: 6 });
  expect(block(events, 3)).toMatchObject({ removed: false, revision: 2, revised: false });
});

test('the blocks as the Gate holds them: peeked references, and why one cannot be read', () => {
  const events = session(1, { type: 'FileReferenced', id: 3, file: 'a.ts' }, { type: 'FileReferenced', id: 4, file: 'b.ts' });
  const context = fold(events);
  const peeked = { ...context, blocks: context.blocks.map(b => (b.id === 3 ? { ...b, content: '[a.ts]\nx' } : b)) };
  const blocks = review(events, peeked, new Map([[4, 'file not found: b.ts']]));
  expect(blocks[2]).toMatchObject({ id: 3, content: '[a.ts]\nx' });
  expect(blocks[2]).not.toHaveProperty('missing');
  expect(blocks[3]).toMatchObject({ id: 4, missing: 'file not found: b.ts' });
});

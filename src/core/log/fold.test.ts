import { expect, test } from 'bun:test';
import type { SessionEvent } from './events';
import { callText, fold, undone } from './fold';

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
    thinking: null,
    blocks: [
      { id: 1, kind: 'System', origin: 'config', content: 'You are an agent.', cutOff: false, revision: 1 },
      { id: 2, kind: 'User', origin: 'user', content: 'hi', cutOff: false, revision: 1 },
      { id: 3, kind: 'Assistant', origin: 'model', content: 'hello', cutOff: true, revision: 1 },
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

test('a new block starts at its first Revision', () => {
  expect(block(session(1), 2)).toEqual({
    id: 2, kind: 'User', origin: 'user', content: 'u2', cutOff: false,
    revision: 1,
  });
});

test('nextId follows the highest block id, also past hidden blocks', () => {
  expect(fold(session(0)).nextId).toBe(2);
  expect(fold(session(2, { type: 'Remove', id: 3 }, sent)).nextId).toBe(4);
});

test('Move puts the block right after its anchor', () => {
  expect(ids(session(3, { type: 'Move', id: 4, after: 1 }))).toEqual([1, 4, 2, 3]);
});

test('Move down past the neighbour', () => {
  expect(ids(session(3, { type: 'Move', id: 2, after: 3 }))).toEqual([1, 3, 2, 4]);
});

// Pins are gone (ADR 0002); older Session Logs still carry them.
const legacy = (event: object) => event as unknown as SessionEvent;

test('Pin and Unpin from older logs are ignored on replay', () => {
  const events = session(3, legacy({ type: 'Pin', id: 3, at: 'top' }), legacy({ type: 'Pin', id: 4, at: 'bottom' }), legacy({ type: 'Unpin', id: 3 }));
  expect(ids(events)).toEqual([1, 2, 3, 4]);
  expect(block(events, 4)).not.toHaveProperty('pin');
});

test('a block added pinned in an older log stays where it was added', () => {
  const events = session(1, legacy({ type: 'BlockAdded', id: 3, kind: 'Note', origin: 'environment', content: 'env', pin: 'top' }));
  expect(ids(events)).toEqual([1, 2, 3]);
  expect(block(events, 3)).not.toHaveProperty('pin');
});

test('Remove takes the block out of the Context at once', () => {
  expect(ids(session(2, { type: 'Remove', id: 2 }))).toEqual([1, 3]);
});

test('Rename changes no block: titles are the Gate\'s', () => {
  expect(fold(session(1, { type: 'Rename', id: 2, title: 'greeting' })).blocks).toEqual(fold(session(1)).blocks);
});

test('Undo cancels the named event, even across a request', () => {
  const events = session(3, { type: 'Move', id: 4, after: 1 }, { type: 'Remove', id: 2 }, sent, { type: 'Undo', eventId: 6 });
  expect(ids(events)).toEqual([1, 4, 2, 3]);
});

test('undone lists the event ids cancelled by Undo events', () => {
  expect([...undone(session(1, { type: 'Remove', id: 2 }, { type: 'Undo', eventId: 3 }))]).toEqual([3]);
});

test('a ProfileFallback replaces the session profile', () => {
  expect(fold(session(0, { type: 'ProfileFallback', profile: 'qwen' })).profile).toBe('qwen');
});

test('a session rename changes no block', () => {
  expect(fold(session(1, { type: 'SessionRenamed', title: 'x' })).blocks).toEqual(fold(session(1)).blocks);
});

const call = (id: number, command: string): SessionEvent => ({ type: 'BlockAdded', id, kind: 'Tool Call', origin: 'model', content: command });
const result = (id: number, of: number, extra: Partial<Extract<SessionEvent, { type: 'BlockAdded' }>> = {}): SessionEvent =>
  ({ type: 'BlockAdded', id, kind: 'Tool Result', origin: 'tool', content: `out ${of}`, call: of, ...extra });

test('a Tool Result keeps its Tool Call and how the run stopped', () => {
  const events = session(1, call(3, 'ls'), result(4, 3, { stopped: 'timeout' }));
  expect(block(events, 4)).toMatchObject({ kind: 'Tool Result', call: 3, stopped: 'timeout' });
  expect(block(events, 3).call).toBeUndefined();
});

test('Tool Results follow the Tool Calls of their answer, in call order, before blocks added since', () => {
  const events = session(1, call(3, 'a'), call(4, 'b'), { type: 'BlockAdded', id: 5, kind: 'User', origin: 'user', content: 'wait' }, result(6, 3), result(7, 4));
  expect(ids(events)).toEqual([1, 2, 3, 4, 6, 7, 5]);
});

test('a Tool Call awaits approval until it has a Tool Result', () => {
  const events = session(1, call(3, 'ls'), call(4, 'pwd'), result(5, 3));
  expect(block(events, 3).pending).toBe(false);
  expect(block(events, 4).pending).toBe(true);
  expect(block(events, 2).pending).toBeUndefined();
});

test('Remove takes the whole Tool Pair, from either block', () => {
  const events = session(1, call(3, 'ls'), result(4, 3), call(5, 'pwd'));
  for (const id of [3, 4]) {
    expect(ids([...events, { type: 'Remove', id } as SessionEvent])).toEqual([1, 2, 5]);
  }
  expect(ids([...events, { type: 'Remove', id: 2 }])).toEqual([1, 3, 4, 5]);
});

const toNote = (id: number, of: number): SessionEvent => ({ type: 'PairToNote', id, call: of });

test('PairToNote turns the Tool Pair into a Note after the calls and results of its answer: `[Tool bash: <cmd>]` + result', () => {
  const events = session(1, call(3, 'ls'), call(4, 'pwd'), result(5, 3), result(6, 4), toNote(7, 3));
  expect(ids(events)).toEqual([1, 2, 4, 6, 7]);
  expect(block(events, 7)).toEqual({
    id: 7, kind: 'Note', origin: 'tool', content: '[Tool bash: ls]\nout 3', source: 'ls', cutOff: false,
    revision: 1,
  });
  expect(ids([...events, sent])).toEqual([1, 2, 4, 6, 7]);
  expect(ids(session(1, call(3, 'ls'), call(4, 'pwd'), result(5, 3), result(6, 4), toNote(7, 4)))).toEqual([1, 2, 3, 5, 7]);
  expect(fold(events).nextId).toBe(8);
});

test('a search call keeps its tool; its pair becomes a Note `[Tool search: <query>]`, titled by tool and query', () => {
  const search: SessionEvent = { type: 'BlockAdded', id: 3, kind: 'Tool Call', origin: 'model', content: 'bun', tool: 'search' };
  expect(block(session(1, search), 3)).toMatchObject({ kind: 'Tool Call', tool: 'search', content: 'bun', pending: true });
  expect(block(session(1, call(3, 'ls')), 3)).not.toHaveProperty('tool');
  expect(block(session(1, search, result(4, 3), toNote(5, 3)), 5)).toMatchObject({ content: '[Tool search: bun]\nout 3', source: 'search bun' });
});

test('callText: the bash command as is, another tool by name and query', () => {
  expect(callText({ content: 'ls' })).toBe('ls');
  expect(callText({ tool: 'bash', content: 'ls' })).toBe('ls');
  expect(callText({ tool: 'search', content: 'bun' })).toBe('search bun');
});

test('a Tool Result edited in place stays the result of its call', () => {
  const events = session(1, call(3, 'ls'), result(4, 3), edit(4, 2, 'short'));
  expect(block(events, 4)).toMatchObject({ kind: 'Tool Result', call: 3, content: 'short' });
  expect(ids(events)).toEqual([1, 2, 3, 4]);
});

test('the Note carries the result as edited in place; undo brings the pair back', () => {
  const events = session(1, call(3, 'ls'), result(4, 3), edit(4, 2, 'short'), toNote(5, 3));
  expect(block(events, 5).content).toBe('[Tool bash: ls]\nshort');
  expect(ids([...events, { type: 'Undo', eventId: 6 }])).toEqual([1, 2, 3, 4]);
});

const edit = (id: number, revision: number, content: string): SessionEvent => ({ type: 'Edit', id, revision, content });

test('Edit replaces the content with the new Revision, keeping kind and place', () => {
  const events = session(2, edit(2, 2, 'better'));
  expect(block(events, 2)).toMatchObject({ kind: 'User', content: 'better', revision: 2 });
  expect(ids(events)).toEqual([1, 2, 3]);
});

test('undoing an Edit restores the earlier Revision, also across a request', () => {
  expect(block(session(1, edit(2, 2, 'x'), { type: 'Undo', eventId: 3 }), 2)).toMatchObject({ content: 'u2', revision: 1 });
  expect(block(session(1, edit(2, 2, 'x'), sent, { type: 'Undo', eventId: 3 }), 2)).toMatchObject({ content: 'u2', revision: 1 });
});

const compact = (sources: number[], noteId: number, content = 'short'): SessionEvent => ({ type: 'Compact', sources, instruction: 'keep it', noteId, content });

test('Compact replaces its sources at once by one Note at the first source’s place', () => {
  const events = session(4, compact([3, 4], 6, 'gist'));
  expect(ids(events)).toEqual([1, 2, 6, 5]);
  expect(block(events, 6)).toEqual({
    id: 6, kind: 'Note', origin: 'compaction', content: 'gist', cutOff: false, compacted: { sources: [3, 4], instruction: 'keep it' },
    revision: 1,
  });
  expect(fold(events).nextId).toBe(7);
});

test('the sources of a Compaction stay gone after the next request', () => {
  expect(ids(session(3, compact([2, 3], 5), sent))).toEqual([1, 5, 4]);
});

test('undoing a Compaction brings its sources back and drops the Note', () => {
  const events = session(3, compact([2, 3], 5));
  expect(ids([...events, { type: 'Undo', eventId: events.length - 1 }])).toEqual([1, 2, 3, 4]);
});

test('a Compaction of a Tool Pair hides both its blocks', () => {
  const events: SessionEvent[] = [
    ...session(1),
    { type: 'BlockAdded', id: 3, kind: 'Tool Call', origin: 'model', content: 'ls' },
    { type: 'BlockAdded', id: 4, kind: 'Tool Result', origin: 'tool', content: 'a', call: 3 },
    compact([3, 4], 5),
  ];
  expect(ids(events)).toEqual([1, 2, 5]);
});

test('a file reference is an unread Note until the file is read, then a plain snapshot', () => {
  const referenced = session(1, { type: 'FileReferenced', id: 3, file: 'a.ts:1-2' });
  expect(block(referenced, 3)).toEqual({
    id: 3, kind: 'Note', origin: 'file', file: 'a.ts:1-2', unread: true, content: '', cutOff: false,
    revision: 1,
  });
  const read = block([...referenced, { type: 'FileRead', id: 3, content: '[a.ts:1-2]\n1: x' }], 3);
  expect(read).toMatchObject({ file: 'a.ts:1-2', content: '[a.ts:1-2]\n1: x', revision: 1 });
  expect(read.unread).toBeUndefined();
});

test('ThinkingSet sets the thinking of the following requests; the last one wins', () => {
  const created = { type: 'SessionCreated', profile: 'default', protocol: 'native' } as const;
  expect(fold([created]).thinking).toBeNull();
  expect(fold([created, { type: 'ThinkingSet', thinking: 'on' }, { type: 'ThinkingSet', thinking: 'high' }]).thinking).toBe('high');
});

test('NoteAdded puts a Context Policy\'s Note right after its anchor; undo drops it', () => {
  const events = session(3, { type: 'NoteAdded', id: 5, after: 2, content: 'about', by: 'trail' });
  expect(ids(events)).toEqual([1, 2, 5, 3, 4]);
  expect(block(events, 5)).toEqual({ id: 5, kind: 'Note', origin: 'policy', content: 'about', cutOff: false, revision: 1 });
  expect(fold(events).nextId).toBe(6);
  expect(ids([...events, { type: 'Undo', eventId: events.length - 1 }])).toEqual([1, 2, 3, 4]);
});

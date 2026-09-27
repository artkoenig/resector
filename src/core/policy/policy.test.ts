import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { fold, type Context } from '../log/fold';
import { applyPolicy, MAX_PASSES, parse, plan, summary, viewOf, type Change, type Policy, type PolicyContext, type PolicyOperation, type Ports } from './policy';

// System, Tools, User, Thinking, Assistant, a Tool Pair (5, 6), a User message.
const session = (...then: SessionEvent[]): SessionEvent[] => [
  { type: 'SessionCreated', profile: 'default', protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
  { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: '[]' },
  { type: 'BlockAdded', id: 3, kind: 'Thinking', origin: 'model', content: 'hmm' },
  { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'let me look' },
  { type: 'BlockAdded', id: 5, kind: 'Tool Call', origin: 'model', content: 'ls' },
  { type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'a b', call: 5 },
  { type: 'BlockAdded', id: 7, kind: 'User', origin: 'user', content: 'go on' },
  ...then,
];
const pending: SessionEvent = { type: 'BlockAdded', id: 8, kind: 'Tool Call', origin: 'model', content: 'pwd' };
const planOf = (op: PolicyOperation, events = session()) => plan(events, op);

test('the view: each block sent with its tokens, the other block of its Tool Pair, and whether it awaits approval', () => {
  const context = fold(session({ type: 'Remove', id: 4 }, pending));
  expect(viewOf(context, { blocks: [5, 6, 7, 8, 9, 10, 11], total: 60 }, 4096)).toEqual({
    window: 4096,
    used: 60,
    blocks: [
      { id: 1, kind: 'System', origin: 'config', content: 'sys', tokens: 5, pair: null, pending: false },
      { id: 2, kind: 'Tools', origin: 'config', content: '[]', tokens: 6, pair: null, pending: false },
      { id: 3, kind: 'Thinking', origin: 'model', content: 'hmm', tokens: 7, pair: null, pending: false },
      { id: 5, kind: 'Tool Call', origin: 'model', content: 'ls', tokens: 8, pair: 6, pending: false },
      { id: 6, kind: 'Tool Result', origin: 'tool', content: 'a b', tokens: 9, pair: 5, pending: false },
      { id: 7, kind: 'User', origin: 'user', content: 'go on', tokens: 10, pair: null, pending: false },
      { id: 8, kind: 'Tool Call', origin: 'model', content: 'pwd', tokens: 11, pair: null, pending: true },
    ],
  });
});

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

test('an operation of another shape is refused', () => {
  for (const op of [null, 'remove', { op: 'pin', id: 3 }, { op: 'remove', id: '3' }, { op: 'remove', id: 3.5 }, { op: 'edit', id: 3 }, { op: 'move', id: 3 }, { op: 'compact', sources: [3] }])
    expect(parse(op)).toEqual({ error: `not an operation: ${JSON.stringify(op)}` });
  expect(parse({ op: 'move', id: 3, after: 4, extra: 1 })).toEqual({ op: 'move', id: 3, after: 4 });
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

// The Session Log in memory; counting gives every block 10 tokens; compaction writes `note`.
function ports(events: SessionEvent[], { note = async () => 'the gist' }: { note?: Ports['compact'] } = {}) {
  const log = [...events];
  const seen: PolicyContext[] = [];
  const compacted: { sources: number[]; instruction: string; blocks: number }[] = [];
  const port: Ports = {
    events: () => log,
    append: event => void log.push(event),
    count: async (context: Context) => ({ blocks: context.blocks.filter(b => !b.removed).map(() => 10), total: 999 }),
    window: 4096,
    compact: async (context, sources, instruction) => {
      compacted.push({ sources, instruction, blocks: context.blocks.length });
      return note(context, sources, instruction);
    },
  };
  return { port, log, seen, compacted, added: () => log.slice(events.length) };
}
// A policy running `passes` in turn, then nothing; it records the Contexts it saw.
function policy(passes: PolicyOperation[][], seen: PolicyContext[] = []): Policy {
  let pass = 0;
  return { name: 'trail', run: context => (seen.push(context), passes[pass++] ?? []) };
}

test('the policy runs until it returns nothing; its operations are logged in turn, attributed to it', async () => {
  const { port, added, seen } = ports(session());
  const result = await applyPolicy(policy([[{ op: 'remove', id: 3 }, { op: 'remove', id: 5 }], [{ op: 'edit', id: 7, content: 'more' }]], seen), port);
  expect(result).toEqual({ changes: [{ noun: 'Thinking', verb: 'removed' }, { noun: 'Tool Pair', verb: 'removed' }, { noun: 'block', verb: 'edited' }], error: null });
  expect(added()).toEqual([{ type: 'Remove', id: 3, by: 'trail' }, { type: 'Remove', id: 5, by: 'trail' }, { type: 'Edit', id: 7, revision: 2, content: 'more', by: 'trail' }]);
  expect(seen.map(c => c.blocks.map(b => b.id))).toEqual([[1, 2, 3, 4, 5, 6, 7], [1, 2, 4, 7], [1, 2, 4, 7]]);
  expect(seen[0]).toMatchObject({ window: 4096, used: 999, blocks: [{ tokens: 10 }, { tokens: 10 }, { tokens: 10 }, { tokens: 10 }, { tokens: 10 }, { tokens: 10 }, { tokens: 10 }] });
});

test('a policy returning nothing changes nothing', async () => {
  const { port, added } = ports(session());
  expect(await applyPolicy(policy([]), port)).toEqual({ changes: [], error: null });
  expect(added()).toEqual([]);
});

test(`a policy still changing the Context after ${MAX_PASSES} passes stops; what it did stays`, async () => {
  const { port, added } = ports(session());
  const edits = Array.from({ length: MAX_PASSES }, (_, i): PolicyOperation[] => [{ op: 'edit', id: 7, content: `v${i}` }]);
  const result = await applyPolicy(policy(edits), port);
  expect(result.error).toBe(`still changing the Context after ${MAX_PASSES} passes`);
  expect(result.changes).toHaveLength(MAX_PASSES - 1);
  expect(added().map(e => e.type === 'Edit' && e.content)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
  const { port: last } = ports(session());
  expect((await applyPolicy(policy(edits.slice(1)), last)).error).toBeNull();
});

test('an operation the rules refuse stops the policy; the ones before it stay', async () => {
  const { port, added } = ports(session());
  const result = await applyPolicy(policy([[{ op: 'remove', id: 3 }, { op: 'remove', id: 1 }, { op: 'remove', id: 7 }]]), port);
  expect(result).toEqual({ changes: [{ noun: 'Thinking', verb: 'removed' }], error: 'remove 1: System prompt cannot be removed' });
  expect(added()).toEqual([{ type: 'Remove', id: 3, by: 'trail' }]);
});

test('the refused operation is named', async () => {
  const refused = async (op: unknown) => (await applyPolicy({ name: 'x', run: () => [op as PolicyOperation] }, ports(session()).port)).error;
  expect(await refused({ op: 'edit', id: 1, content: 'x' })).toBe('edit 1: System prompt is fixed');
  expect(await refused({ op: 'move', id: 7, after: 1 })).toBe('move 7 after 1: System and Tools Block stay first');
  expect(await refused({ op: 'compact', sources: [1, 3], instruction: 'i' })).toBe('compact 1 3: System prompt is fixed');
  expect(await refused({ op: 'pin', id: 3 })).toBe('not an operation: {"op":"pin","id":3}');
  expect(await refused({ op: 'remove', id: 99 })).toBe('remove 99: no block 99 in the Context');
});

test('a policy that throws, or returns no list, stops', async () => {
  const thrown = { name: 'x', run: () => { throw new Error('boom'); } };
  expect(await applyPolicy(thrown, ports(session()).port)).toEqual({ changes: [], error: 'failed: boom' });
  const rejected = { name: 'x', run: () => Promise.reject('nope') };
  expect(await applyPolicy(rejected, ports(session()).port)).toEqual({ changes: [], error: 'failed: nope' });
  const odd = { name: 'x', run: () => ({ op: 'remove', id: 3 }) as unknown as PolicyOperation[] };
  expect(await applyPolicy(odd, ports(session()).port)).toEqual({ changes: [], error: 'returned no list of operations' });
});

test('compact: the Compaction runs on the Context, its Note accepted without review and attributed', async () => {
  const { port, added, compacted } = ports(session());
  const result = await applyPolicy(policy([[{ op: 'compact', sources: [3, 4], instruction: 'short' }, { op: 'remove', id: 7 }]]), port);
  expect(result).toEqual({ changes: [{ text: '1 Thinking + 1 Assistant → 1 Note' }, { noun: 'User', verb: 'removed' }], error: null });
  expect(compacted).toEqual([{ sources: [3, 4], instruction: 'short', blocks: 7 }]);
  expect(added()).toEqual([
    { type: 'Compact', sources: [3, 4], instruction: 'short', noteId: 8, content: 'the gist', by: 'trail' },
    { type: 'Remove', id: 7, by: 'trail' },
  ]);
});

test('a Compaction that fails or writes nothing stops the policy', async () => {
  const op: PolicyOperation[][] = [[{ op: 'compact', sources: [3], instruction: 'short' }]];
  const failing = ports(session(), { note: () => Promise.reject(new Error('server gone')) });
  expect(await applyPolicy(policy(op), failing.port)).toEqual({ changes: [], error: 'compact 3: compaction failed: server gone' });
  const empty = ports(session(), { note: async () => ' \n' });
  expect(await applyPolicy(policy(op), empty.port)).toEqual({ changes: [], error: 'compact 3: compaction failed: empty Note' });
  expect([...failing.added(), ...empty.added()]).toEqual([]);
});

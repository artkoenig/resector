import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import type { Context } from '../log/fold';
import { applyPolicy, MAX_PASSES, type Ports } from './apply';
import type { Policy, PolicyContext, PolicyOperation } from './policy';
import { session } from './policy.harness';

// The Session Log in memory; counting gives every block 10 tokens; compaction writes `note`.
// abortAt: the number of aborted() checks after which Esc counts as pressed.
function ports(events: SessionEvent[], { note = async () => 'the gist', abortAt = Infinity }: { note?: Ports['compact']; abortAt?: number } = {}) {
  let checks = 0;
  const log = [...events];
  const seen: PolicyContext[] = [];
  const compacted: { sources: number[]; instruction: string; blocks: number; inContext?: boolean }[] = [];
  const port: Ports = {
    events: () => log,
    append: event => void log.push(event),
    count: async (context: Context) => ({ blocks: context.blocks.map(() => 10), total: 999 }),
    situation: { window: 4096 },
    aborted: () => ++checks > abortAt,
    compact: async (context, sources, instruction, inContext) => {
      compacted.push({ sources, instruction, blocks: context.blocks.length, ...(inContext && { inContext }) });
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

test('a send is no change: it is reported, and a pass with nothing else ends the run', async () => {
  const { port, added } = ports(session());
  expect(await applyPolicy(policy([[{ op: 'remove', id: 3 }, { op: 'send' }], [{ op: 'send' }]]), port)).toEqual({ changes: [{ noun: 'Thinking', verb: 'removed' }], error: null, send: true });
  expect(added()).toEqual([{ type: 'Remove', id: 3, by: 'trail' }]);
});

test('only to send: the operations apply if the first pass asks to send on, else nothing changes', async () => {
  const edits = ports(session());
  expect(await applyPolicy(policy([[{ op: 'remove', id: 3 }]]), edits.port, { onlyToSend: true })).toEqual({ changes: [], error: null });
  expect(edits.added()).toEqual([]);
  const sends = ports(session());
  const passes: PolicyOperation[][] = [[{ op: 'remove', id: 3 }, { op: 'send' }], [{ op: 'remove', id: 5 }]];
  expect(await applyPolicy(policy(passes), sends.port, { onlyToSend: true })).toEqual({ changes: [{ noun: 'Thinking', verb: 'removed' }, { noun: 'Tool Pair', verb: 'removed' }], error: null, send: true });
});

test(`a policy still changing the Context after ${MAX_PASSES} passes stops; what it did stays`, async () => {
  const { port, added } = ports(session());
  const edits = Array.from({ length: MAX_PASSES + 1 }, (_, i): PolicyOperation[] => [{ op: 'edit', id: 7, content: `v${i}` }]);
  const result = await applyPolicy(policy(edits), port);
  expect(result.error).toBe(`still changing the Context after ${MAX_PASSES} passes`);
  expect(result.changes).toHaveLength(MAX_PASSES);
  expect(added().map(e => e.type === 'Edit' && e.content)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7']);
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
  expect(await refused(null)).toBe('not an operation: null');
  expect(await refused({ op: 'remove', id: 99 })).toBe('remove 99: no block 99 in the Context');
  expect(await refused({ op: 'note', after: 1, content: 'x' })).toBe('note after 1: System and Tools Block stay first');
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

test('compact in the Context: the port is told so', async () => {
  const { port, compacted } = ports(session());
  await applyPolicy(policy([[{ op: 'compact', sources: [3, 4], instruction: 'short', inContext: true }]]), port);
  expect(compacted).toEqual([{ sources: [3, 4], instruction: 'short', blocks: 7, inContext: true }]);
});

test('a Compaction that fails or writes nothing stops the policy', async () => {
  const op: PolicyOperation[][] = [[{ op: 'compact', sources: [3], instruction: 'short' }]];
  const failing = ports(session(), { note: () => Promise.reject(new Error('server gone')) });
  expect(await applyPolicy(policy(op), failing.port)).toEqual({ changes: [], error: 'compact 3: compaction failed: server gone' });
  const empty = ports(session(), { note: async () => ' \n' });
  expect(await applyPolicy(policy(op), empty.port)).toEqual({ changes: [], error: 'compact 3: compaction failed: empty Note' });
  expect([...failing.added(), ...empty.added()]).toEqual([]);
});

test('Esc stops the policy before the next pass or operation; what it did stays', async () => {
  const passes: PolicyOperation[][] = [[{ op: 'remove', id: 3 }, { op: 'remove', id: 4 }], [{ op: 'remove', id: 7 }]];
  const first = ports(session(), { abortAt: 0 });
  expect(await applyPolicy(policy(passes), first.port)).toEqual({ changes: [], error: 'aborted' });
  const between = ports(session(), { abortAt: 2 });
  expect(await applyPolicy(policy(passes), between.port)).toEqual({ changes: [{ noun: 'Thinking', verb: 'removed' }], error: 'aborted' });
  expect(between.added()).toEqual([{ type: 'Remove', id: 3, by: 'trail' }]);
  const nextPass = ports(session(), { abortAt: 3 });
  expect(await applyPolicy(policy(passes), nextPass.port)).toEqual({ changes: [{ noun: 'Thinking', verb: 'removed' }, { noun: 'Assistant', verb: 'removed' }], error: 'aborted' });
});

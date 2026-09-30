import { expect, test } from 'bun:test';
import { DEFAULT_INSTRUCTION } from '../../src/core/compaction/compaction';
import type { Kind } from '../../src/core/log/events';
import type { PolicyBlock } from '../../src/core/policy/policy';
import leanCompact from './lean-compact';

type Spec = Kind | [Kind, Partial<PolicyBlock>];

// Blocks with ids from 1; a Tool Result pairs with the Tool Call right before it.
const blocks = (...specs: Spec[]): PolicyBlock[] => {
  const kinds = specs.map(s => (Array.isArray(s) ? s[0] : s));
  return specs.map((s, i) => {
    const kind = kinds[i]!;
    const pair = kind === 'Tool Call' && kinds[i + 1] === 'Tool Result' ? i + 2 : kind === 'Tool Result' ? i : null;
    const block: PolicyBlock = { id: i + 1, kind, origin: 'model', content: kind, tokens: 300, pair, pending: false };
    return Array.isArray(s) ? { ...block, ...s[1] } : block;
  });
};
const call = (content: string): Spec => ['Tool Call', { content }];
const compact = (...sources: number[]) => ({ op: 'compact' as const, sources, instruction: DEFAULT_INSTRUCTION });

test('below half the window nothing happens', () => {
  expect(leanCompact({ window: 100, used: 49, blocks: blocks('User', 'Thinking', 'Assistant', 'User') })).toEqual([]);
});

test('from half the window on, the work is compacted; the user and the newest block stay', () => {
  expect(leanCompact({ window: 100, used: 50, blocks: blocks('User', 'Thinking', 'Assistant', 'User') })).toEqual([compact(2, 3)]);
});

test('read-only Tool Pairs and short Thinking are removed, the rest compacted', () => {
  const context = blocks('User', call('grep -n foo src'), 'Tool Result', ['Thinking', { tokens: 50 }], call('bun test'), 'Tool Result', 'Assistant', 'User');
  expect(leanCompact({ window: 100, used: 60, blocks: context })).toEqual([
    { op: 'remove', id: 2 },
    { op: 'remove', id: 4 },
    compact(5, 6, 7),
  ]);
});

test('a command that writes or runs something is not a read', () => {
  for (const command of ['sed -i s/a/b/ x', 'find . -delete', 'cat x > y', 'echo "$(rm x)"', 'ls && rm x']) {
    const ops = leanCompact({ window: 100, used: 60, blocks: blocks('User', call(command), 'Tool Result', 'User') });
    expect(ops).toEqual([compact(2, 3)]);
  }
});

test('quoted operators are arguments', () => {
  const ops = leanCompact({ window: 100, used: 60, blocks: blocks('User', call("grep 'a|b' x"), 'Tool Result', 'User') });
  expect(ops).toEqual([{ op: 'remove', id: 2 }]);
});

test('the newest Tool Pair stays as a whole', () => {
  expect(leanCompact({ window: 100, used: 60, blocks: blocks('User', 'Assistant', call('ls'), 'Tool Result') })).toEqual([compact(2)]);
});

test('only an earlier Compaction Note left: nothing to compact again', () => {
  const context = blocks('User', ['Note', { origin: 'compaction' }], 'User');
  expect(leanCompact({ window: 100, used: 60, blocks: context })).toEqual([]);
});

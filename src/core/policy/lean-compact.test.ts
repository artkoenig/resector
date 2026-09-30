import { expect, test } from 'bun:test';
import { DEFAULT_INSTRUCTION } from '../compaction/compaction';
import type { Kind } from '../log/events';
import type { PolicyBlock } from './policy';
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

// The operations for one Tool Pair between two User blocks.
const opsFor = (command: string) => leanCompact({ window: 100, used: 60, blocks: blocks('User', call(command), 'Tool Result', 'User') });

test('read-only commands, alone or chained, with quoted arguments and output sent to stderr or /dev/null, are reads', () => {
  const commands = ['ls', 'tree', 'cat a', 'head a', 'tail a', 'wc a', 'grep x a', 'rg x', 'find .', 'sed -n 1p a', 'git status', 'git diff', 'git log',
    'git show HEAD', 'pwd', 'cd src', 'stat a', 'file a', 'echo hi', 'ls | wc -l', 'ls; pwd', 'ls\npwd', 'ls || pwd', "grep 'a|b' x", 'grep "ab|c" x',
    'grep "a b" x', "grep '$(x)' x", 'ls>&2', 'ls >&2', 'ls 2>&1', 'ls>/dev/null', 'ls > /dev/null', 'ls 2>/dev/null'];
  for (const command of commands) expect(opsFor(command), command).toEqual([{ op: 'remove', id: 2 }]);
});

test('a command that writes or runs something is not a read', () => {
  const commands = ['sed -i s/a/b/ x', 'sed -n -i s/a/b/ x', 'sed -n -nEi p x', 'sed -n --in-place p x', 'find . -delete', 'find . -delete -name x',
    'find . -exec rm {} +', 'git diff --output=x', 'git diff --output x', 'git log --output', 'rg --pre=cat x', 'rg --pre cat x', 'rg x --pre',
    'cat x > y', 'echo "$(rm x)"', 'echo "`rm x`"', 'echo `rm x`', 'ls && rm x', "'x'cat f"];
  for (const command of commands) expect(opsFor(command), command).toEqual([compact(2, 3)]);
});

test('a Tool Pair the user answered (a Question) or a Tool Call without result is not a read', () => {
  expect(leanCompact({ window: 100, used: 60, blocks: blocks('User', call('ls'), ['Tool Result', { origin: 'user' }], 'User') })).toEqual([compact(2, 3)]);
  expect(leanCompact({ window: 100, used: 60, blocks: blocks('User', call('ls'), 'Assistant', 'User') })).toEqual([compact(2, 3)]);
  expect(leanCompact({ window: 100, used: 60, blocks: blocks('User', ['Assistant', { content: 'ls' }], call('x'), ['Tool Result', { content: 'ls' }], 'User') })).toEqual([compact(2, 3, 4)]);
});

test('short means Thinking under 200 tokens; other short blocks are compacted', () => {
  const context = blocks('User', ['Thinking', { tokens: 199 }], ['Thinking', { tokens: 200 }], ['Assistant', { tokens: 10 }], 'User');
  expect(leanCompact({ window: 100, used: 60, blocks: context })).toEqual([{ op: 'remove', id: 2 }, compact(3, 4)]);
});

test('System, Tools, pending Tool Calls and the Notes of the environment and of files are not compacted', () => {
  const context = blocks('System', 'Tools', ['Note', { origin: 'environment' }], ['Note', { origin: 'file' }], 'User', 'Assistant', ['Tool Call', { pending: true }], 'User');
  expect(leanCompact({ window: 100, used: 60, blocks: context })).toEqual([compact(6)]);
});

test('an empty Context: nothing to do', () => {
  expect(leanCompact({ window: 0, used: 0, blocks: [] })).toEqual([]);
});

test('the newest answer stays as a whole: its Thinking, text and Tool Pairs', () => {
  // Two calls of one answer, then their results: 7 ↔ 9, 8 ↔ 10.
  const context = blocks('User', 'Thinking', call('bun test'), 'Tool Result', ['Thinking', { tokens: 50 }], 'Assistant',
    ['Tool Call', { content: 'ls', pair: 9 }], ['Tool Call', { content: 'bun test', pair: 10 }], ['Tool Result', { pair: 7 }], ['Tool Result', { pair: 8 }]);
  expect(leanCompact({ window: 100, used: 60, blocks: context })).toEqual([compact(2, 3, 4)]);
});

// The operations when the Context is `specs`, from half the window on.
const lean = (...specs: Spec[]) => leanCompact({ window: 100, used: 60, blocks: blocks(...specs) });

test('the answer before the newest one is compacted: its Tool Results end where the newest Thinking starts', () => {
  expect(lean('User', 'Thinking', call('bun test'), 'Tool Result', 'Thinking', call('bun test'), 'Tool Result')).toEqual([compact(2, 3, 4)]);
});

test('an answer without calls stays, Thinking cut off too, short or not', () => {
  expect(lean('User', 'Assistant', 'User', ['Thinking', { tokens: 50 }], 'Assistant')).toEqual([compact(2)]);
  expect(lean('User', 'Assistant', 'User', ['Thinking', { tokens: 50 }])).toEqual([compact(2)]);
  expect(lean('User', 'Assistant', 'User', 'Thinking')).toEqual([compact(2)]);
});

test('an answer whose Tool Call awaits approval stays, its short Thinking too', () => {
  expect(lean('User', 'Assistant', 'User', ['Thinking', { tokens: 50 }], ['Tool Call', { pending: true }])).toEqual([compact(2)]);
});

test('an answer ending with a Question the user answered, or a call rejected, stays', () => {
  expect(lean('User', 'Assistant', 'User', 'Thinking', call('question'), ['Tool Result', { origin: 'user' }])).toEqual([compact(2)]);
  expect(lean('User', 'Assistant', 'User', 'Thinking', call('rm x'), ['Tool Result', { content: 'rejected by user' }])).toEqual([compact(2)]);
});

test('a read-only Tool Pair of the newest answer stays, the earlier ones go', () => {
  expect(lean('User', call('ls'), 'Tool Result', call('cat a'), 'Tool Result')).toEqual([{ op: 'remove', id: 2 }]);
});

test('ending with a User block or a Note, only that block is newest: the answer before it is compacted', () => {
  expect(lean('User', ['Thinking', { tokens: 50 }], call('bun test'), 'Tool Result', 'User')).toEqual([{ op: 'remove', id: 2 }, compact(3, 4)]);
  expect(lean('User', 'Thinking', call('bun test'), 'Tool Result', ['Note', { origin: 'user' }])).toEqual([compact(2, 3, 4)]);
});

test('a Context of only the newest answer, or only an earlier Compaction Note before it: nothing to do', () => {
  expect(lean('Thinking', call('ls'), 'Tool Result')).toEqual([]);
  expect(lean('User', ['Note', { origin: 'compaction' }], 'Thinking', call('bun test'), 'Tool Result')).toEqual([]);
});

test('only an earlier Compaction Note left: nothing to compact again', () => {
  const context = blocks('User', ['Note', { origin: 'compaction' }], 'User');
  expect(leanCompact({ window: 100, used: 60, blocks: context })).toEqual([]);
});

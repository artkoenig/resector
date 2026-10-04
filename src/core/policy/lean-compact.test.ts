import { expect, test } from 'bun:test';
import type { Kind } from '../log/events';
import type { PolicyBlock } from './policy';
import leanCompact, { INSTRUCTION, LEAD } from './lean-compact';

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
const lead: Spec = ['Note', { origin: 'policy', content: LEAD }];
const compact = (...sources: number[]) => ({ op: 'compact' as const, sources, instruction: INSTRUCTION });

test('below half the window nothing happens', () => {
  expect(leanCompact({ window: 100, used: 49, blocks: blocks('User', 'Thinking', 'Assistant', 'User') })).toEqual([]);
});

test('from half the window on, the work is compacted, the user\'s messages stay; the newest block stays', () => {
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

// The operations for one Tool Pair and other work (so a read is removed, not compacted) between two User blocks.
const opsFor = (command: string) => leanCompact({ window: 100, used: 60, blocks: blocks('User', call(command), 'Tool Result', 'Assistant', 'User') });

test('read-only commands, alone or chained, with quoted arguments and output sent to stderr or /dev/null, are reads', () => {
  const commands = ['ls', 'tree', 'cat a', 'head a', 'tail a', 'wc a', 'grep x a', 'rg x', 'find .', 'sed -n 1p a', 'git status', 'git diff', 'git log',
    'git show HEAD', 'pwd', 'cd src', 'stat a', 'file a', 'echo hi', 'ls | wc -l', 'ls; pwd', 'ls\npwd', 'ls || pwd', "grep 'a|b' x", 'grep "ab|c" x',
    'grep "a b" x', "grep '$(x)' x", 'ls>&2', 'ls >&2', 'ls 2>&1', 'ls>/dev/null', 'ls > /dev/null', 'ls 2>/dev/null'];
  for (const command of commands) expect(opsFor(command), command).toEqual([{ op: 'remove', id: 2 }, compact(4)]);
});

test('only reads and short Thinking since the last Compaction: they are compacted with its Note, not removed', () => {
  const context = blocks('User', lead, ['Note', { origin: 'compaction' }], call('cat a'), 'Tool Result', ['Thinking', { tokens: 50 }], call('ls'), 'Tool Result');
  expect(leanCompact({ window: 100, used: 60, blocks: context })).toEqual([compact(3, 4, 5, 6)]);
  expect(leanCompact({ window: 100, used: 60, blocks: blocks('System', 'User', call('cat a'), 'Tool Result', 'User') })).toEqual([compact(3, 4)]);
});

test('a command that writes or runs something is not a read', () => {
  const commands = ['sed -i s/a/b/ x', 'sed -n -i s/a/b/ x', 'sed -n -nEi p x', 'sed -n --in-place p x', 'find . -delete', 'find . -delete -name x',
    'find . -exec rm {} +', 'git diff --output=x', 'git diff --output x', 'git log --output', 'rg --pre=cat x', 'rg --pre cat x', 'rg x --pre',
    'cat x > y', 'echo "$(rm x)"', 'echo "`rm x`"', 'echo `rm x`', 'ls && rm x', "'x'cat f"];
  for (const command of commands) expect(opsFor(command), command).toEqual([compact(2, 3, 4)]);
});

test('a Tool Pair the user answered (a Question) or a Tool Call without result is not a read', () => {
  expect(leanCompact({ window: 100, used: 60, blocks: blocks('User', call('ls'), ['Tool Result', { origin: 'user' }], 'Assistant', 'User') })).toEqual([compact(2, 3, 4)]);
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

test('the newest Tool Pair stays as a whole', () => {
  expect(leanCompact({ window: 100, used: 60, blocks: blocks('User', 'Assistant', call('ls'), 'Tool Result') })).toEqual([compact(2)]);
});

test('only the user\'s messages and an earlier Compaction Note left: nothing to compact', () => {
  const context = blocks('User', lead, ['Note', { origin: 'compaction' }], 'User', 'User');
  expect(leanCompact({ window: 100, used: 60, blocks: context })).toEqual([]);
});


test('a lead right before the Note of a Compaction, also below half the window', () => {
  const context = blocks('System', 'User', ['Note', { origin: 'compaction' }], 'User');
  expect(leanCompact({ window: 100, used: 0, blocks: context })).toEqual([{ op: 'note', after: 2, content: LEAD }]);
  expect(leanCompact({ window: 100, used: 0, blocks: blocks('System', 'User', lead, ['Note', { origin: 'compaction' }], 'User') })).toEqual([]);
});

test('a lead not right before the first Note of a Compaction goes, and one is added there', () => {
  const after = blocks('System', ['Note', { origin: 'compaction' }], lead, 'User');
  expect(leanCompact({ window: 100, used: 0, blocks: after })).toEqual([{ op: 'remove', id: 3 }, { op: 'note', after: 1, content: LEAD }]);
  expect(leanCompact({ window: 100, used: 0, blocks: blocks('System', lead, 'User') })).toEqual([{ op: 'remove', id: 2 }]);
});

test('a Note of the same text by someone else, or of another text by the policy, is no lead', () => {
  const context = blocks('System', ['Note', { origin: 'file', content: LEAD }], ['Note', { origin: 'compaction' }], 'User');
  expect(leanCompact({ window: 100, used: 0, blocks: context })).toEqual([{ op: 'note', after: 2, content: LEAD }]);
  expect(leanCompact({ window: 100, used: 0, blocks: blocks('System', ['Note', { origin: 'policy' }], 'User') })).toEqual([]);
});

test('the lead is neither work nor compacted', () => {
  const context = blocks('System', 'User', lead, ['Note', { origin: 'compaction' }], 'User', 'User');
  expect(leanCompact({ window: 100, used: 60, blocks: context })).toEqual([]);
  const work = blocks('System', 'User', lead, ['Note', { origin: 'compaction' }], 'Assistant', 'User');
  expect(leanCompact({ window: 100, used: 60, blocks: work })).toEqual([compact(4, 5)]);
});

test('the lead tells the model the Note is its own earlier work in this session, to continue with its Next steps', () => {
  expect(LEAD).toBe('The summary below is of your own earlier work in this session, not a new task. Build on it, do not redo what is under Done; continue with Next steps.');
});

test('the instruction asks for the structure the lead refers to', () => {
  expect(INSTRUCTION).toContain("The user's messages are not among these blocks");
  expect(INSTRUCTION.split('\n').slice(1)).toEqual(['## Goal', '## Facts', '## Decisions', '## Done', '## Dead ends', '## Next steps']);
});

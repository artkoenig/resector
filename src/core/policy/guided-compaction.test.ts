import { expect, test } from 'bun:test';
import type { Kind } from '../log/events';
import type { PolicyBlock } from './policy';
import guidedCompaction, { INSTRUCTION, keepOf } from './guided-compaction';
import { LEAD } from './lean-compact';

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
// A Note of guided-compaction, made after the blocks before it: its id is the highest.
const guided = (keep: string, id = 99): Spec => ['Note', { origin: 'compaction', content: `## Facts\nx\n## Next steps\ntest\n## Keep\n${keep}`, id }];
const compact = (...sources: number[]) => ({ op: 'compact' as const, sources, instruction: INSTRUCTION, inContext: true });

test('below half the window nothing happens, nor in an empty Context', () => {
  expect(guidedCompaction({ window: 100, used: 49, blocks: blocks('User', call('cat a'), 'Tool Result', 'Assistant', 'User') })).toEqual([]);
  expect(guidedCompaction({ window: 100, used: 90, blocks: [] })).toEqual([]);
});

test('from half the window on, the work is compacted in the Context, without the reads and the first User message; the newest block stays', () => {
  const context = blocks('System', 'User', call('cat a'), 'Tool Result', ['Thinking', { tokens: 50 }], call('bun test'), 'Tool Result', 'Assistant', 'User');
  expect(guidedCompaction({ window: 100, used: 50, blocks: context })).toEqual([compact(5, 6, 7, 8)]);
});

test('the instruction asks for the lean-compact sections but Goal, and the files to keep', () => {
  expect(INSTRUCTION.split('\n').slice(1)).toEqual(['## Facts', '## Decisions', '## Done', '## Dead ends', '## Next steps', '## Keep']);
});

test('after the Compaction, the reads older than its Note go unless they name a kept path; the lead first', () => {
  const context = blocks('User', call('cat src/a.ts'), 'Tool Result', call('sed -n 1,9p src/b.ts'), 'Tool Result', guided('- `src/b.ts`'), 'User');
  expect(guidedCompaction({ window: 100, used: 10, blocks: context })).toEqual([{ op: 'note', after: 5, content: LEAD }]);
  const led = blocks('User', call('cat src/a.ts'), 'Tool Result', call('sed -n 1,9p src/b.ts'), 'Tool Result', lead, guided('- `src/b.ts`'), 'User');
  expect(guidedCompaction({ window: 100, used: 10, blocks: led })).toEqual([{ op: 'remove', id: 2 }]);
});

test('the reads it kept are no new work: no Compaction again until there is some', () => {
  const kept = blocks('User', call('cat src/a.ts'), 'Tool Result', lead, guided('src/a.ts'), 'User');
  expect(guidedCompaction({ window: 100, used: 90, blocks: kept })).toEqual([]);
  const worked = blocks('User', call('cat src/a.ts'), 'Tool Result', lead, guided('src/a.ts'), 'User', ['Assistant', { id: 100 }], ['User', { id: 101 }]);
  expect(guidedCompaction({ window: 100, used: 90, blocks: worked })).toEqual([compact(99, 6, 100)]);
  // A read since is new: the next Note may keep it.
  const read = blocks('User', call('cat src/a.ts'), 'Tool Result', lead, guided('src/a.ts'), 'User', ['Tool Call', { id: 100, content: 'cat src/c.ts', pair: 101 }], ['Tool Result', { id: 101, pair: 100 }], ['User', { id: 102 }]);
  expect(guidedCompaction({ window: 100, used: 90, blocks: read })).toEqual([compact(99, 6)]);
});

test('without a Note with Keep, reads count as new work', () => {
  const context = blocks('User', lead, ['Note', { origin: 'compaction', content: '## Goal\nx' }], call('cat a'), 'Tool Result', 'User');
  expect(guidedCompaction({ window: 100, used: 90, blocks: context })).toEqual([compact(3)]);
});

test('of the reads naming a kept path, only the newest stays: the older ones show the file before its edits', () => {
  const context = blocks('User', call('cat src/a.ts'), 'Tool Result', call('cat src/b.ts'), 'Tool Result', call('sed -n 1,9p src/a.ts'), 'Tool Result', lead, guided('src/a.ts\nsrc/b.ts'), 'User');
  expect(guidedCompaction({ window: 100, used: 10, blocks: context })).toEqual([{ op: 'remove', id: 2 }]);
});

test('a read after the Note is not removed, nor is the newest Tool Pair', () => {
  const context = blocks(lead, guided(''), ['Tool Call', { id: 100, content: 'cat a', pair: 101 }], ['Tool Result', { id: 101, pair: 100 }]);
  expect(guidedCompaction({ window: 100, used: 10, blocks: context })).toEqual([]);
  const later = blocks(lead, guided(''), ['Tool Call', { id: 100, content: 'cat a', pair: 101 }], ['Tool Result', { id: 101, pair: 100 }], ['User', { id: 102 }]);
  expect(guidedCompaction({ window: 100, used: 10, blocks: later })).toEqual([]);
  // Left out of the Compaction, so older than its Note.
  expect(guidedCompaction({ window: 100, used: 10, blocks: blocks('User', lead, guided(''), call('cat a'), 'Tool Result') })).toEqual([]);
});

test('a Note without Keep (the user\'s Compaction, another policy\'s) removes no reads, nor does a Keep outside a Compaction', () => {
  const context = blocks('User', call('cat a'), 'Tool Result', lead, ['Note', { origin: 'compaction', content: '## Goal\nx', id: 99 }], ['User', { content: '## Keep\nb', id: 100 }]);
  expect(guidedCompaction({ window: 100, used: 10, blocks: context })).toEqual([]);
});

test('the newest Note with Keep guides, wherever it is in the Context', () => {
  const context = blocks('User', call('cat src/a.ts'), 'Tool Result', call('cat src/b.ts'), 'Tool Result', lead, guided('src/b.ts', 50), guided('src/a.ts', 99), guided('src/b.ts', 60), 'User');
  expect(guidedCompaction({ window: 100, used: 10, blocks: context })).toEqual([{ op: 'remove', id: 4 }]);
});

test('Keep: paths one per line, list marks and backticks stripped; none for an empty or "none" section, null without one', () => {
  expect(keepOf('## Goal\nx\n## Keep\n- `src/a.ts`\n* b.ts\n1. c/d.md\n\n## Other\ne')).toEqual(['src/a.ts', 'b.ts', 'c/d.md']);
  expect(keepOf('## Keep\n(none)')).toEqual([]);
  expect(keepOf('## Keep')).toEqual([]);
  expect(keepOf('## Goal\nx')).toBeNull();
  expect(keepOf('##  Keep (to change)\n  - e.ts\n10. f.ts\n-  g.ts  \nnotes - old.md\nnone.ts\nsrc/none')).toEqual(['e.ts', 'f.ts', 'g.ts', 'notes - old.md', 'none.ts', 'src/none']);
  for (const none of ['none', 'None.', '(none)']) expect(keepOf(`## Keep\n${none}`)).toEqual([]);
  // A heading starts a line; text before the first one is no section.
  expect(keepOf('## Facts\nthe heading ## Keep\nx')).toBeNull();
  expect(keepOf('To Keep\na\n## Facts\nb')).toBeNull();
});

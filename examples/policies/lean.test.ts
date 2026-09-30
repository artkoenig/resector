import { expect, test } from 'bun:test';
import type { Kind } from '../../src/core/log/events';
import type { PolicyBlock } from '../../src/core/policy/policy';
import lean from './lean';

// Blocks with ids from 1; a Tool Result pairs with the Tool Call right before it.
const blocks = (...kinds: Kind[]): PolicyBlock[] =>
  kinds.map((kind, i) => {
    const pair = kind === 'Tool Call' && kinds[i + 1] === 'Tool Result' ? i + 2 : kind === 'Tool Result' ? i : null;
    return { id: i + 1, kind, origin: 'model', content: kind, tokens: 10, pair, pending: false };
  });
const pairs = (n: number): Kind[] => Array.from({ length: n }, () => ['Tool Call', 'Tool Result'] as Kind[]).flat();

test('all but the last 3 Tool Pairs are removed, by their Tool Call', () => {
  expect(lean({ window: 100, used: 10, blocks: blocks('User', ...pairs(5)) })).toEqual([
    { op: 'remove', id: 2 },
    { op: 'remove', id: 4 },
  ]);
});

test('a Tool Call without result or awaiting approval is not counted', () => {
  expect(lean({ window: 100, used: 10, blocks: blocks('User', ...pairs(3), 'Tool Call') })).toEqual([]);
  const pending = blocks('User', ...pairs(4)).map(b => (b.id === 2 ? { ...b, pending: true } : b));
  expect(lean({ window: 100, used: 10, blocks: pending })).toEqual([]);
});

test('from half the window on, the Thinking is compacted into one Note', () => {
  const context = blocks('User', 'Thinking', 'Assistant', 'Thinking');
  expect(lean({ window: 100, used: 49, blocks: context })).toEqual([]);
  expect(lean({ window: 100, used: 50, blocks: context })).toEqual([
    { op: 'compact', sources: [2, 4], instruction: 'Summarize the reasoning; keep decisions and open questions.' },
  ]);
});

test('a single Thinking is left as it is', () => {
  expect(lean({ window: 100, used: 90, blocks: blocks('User', 'Thinking', 'Assistant') })).toEqual([]);
});

import { expect, test } from 'bun:test';
import { commonPrefix, warmRows } from './cache';

test('the invalidation point is the first differing element', () => {
  expect(commonPrefix([1, 2, 3, 4], [1, 2, 9, 4])).toBe(2);
  expect(commonPrefix([1, 2], [1, 2, 3])).toBe(2);
  expect(commonPrefix([1, 2, 3], [1, 2])).toBe(2);
  expect(commonPrefix([], [1])).toBe(0);
  expect(commonPrefix([5], [6])).toBe(0);
  expect(commonPrefix([1, 2], [1, 2])).toBe(2);
});

test('the common prefix never exceeds the shorter sequence', () => {
  const always = () => true;
  expect(commonPrefix([1], [1, 2], always)).toBe(1);
  expect(commonPrefix([1, 2], [1], always)).toBe(1);
});

test('elements are compared with the given equality', () => {
  const byRole = (a: { role: string }, b: { role: string }) => a.role === b.role;
  expect(commonPrefix([{ role: 'system' }, { role: 'user' }], [{ role: 'system' }, { role: 'assistant' }], byRole)).toBe(1);
});

// blocks = tokens per row in Context order; a row is ● when all its tokens lie before the invalidation point.
test('rows ending at or before the cached tokens are warm, the rest cold', () => {
  expect(warmRows([10, 5, 14], 15)).toEqual([true, true, false]);
  expect(warmRows([10, 5, 14], 14)).toEqual([true, false, false]);
  expect(warmRows([10, 5, 14], 29)).toEqual([true, true, true]);
  expect(warmRows([10, 5, 14], 0)).toEqual([false, false, false]);
});

test('a row after a cold row is cold even if it has no tokens', () => {
  expect(warmRows([10, 5, 0], 12)).toEqual([true, false, false]);
});

test('a row of 0 tokens (dropped by the chat template) is warm when the row after it is (FR-48)', () => {
  expect(warmRows([10, 0, 5, 0], 12)).toEqual([true, false, false, false]);
  expect(warmRows([10, 0, 5, 0, 3], 15)).toEqual([true, true, true, false, false]);
});

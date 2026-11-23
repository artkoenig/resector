// Tests for the display helpers: cells measured in terminal cells.
import { expect, test } from 'bun:test';
import { cell, right } from './format';

test('cell pads and cuts by terminal cells, a wide emoji counting two', () => {
  expect(cell('✅ ok', 6)).toBe('✅ ok ');
  expect(cell('ab✅cd', 4)).toBe('ab… ');
  expect(cell('abcdef', 4)).toBe('abc…');
  expect(cell('abc', 4)).toBe('abc ');
});

test('right pads by terminal cells', () => {
  expect(right('✅', 3)).toBe(' ✅');
});

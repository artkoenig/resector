// Tests for the display helpers: cells measured in terminal cells.
import { expect, test } from 'bun:test';
import { cell, fitting, right } from './format';

test('cell pads and cuts by terminal cells, a wide emoji counting two', () => {
  expect(cell('✅ ok', 6)).toBe('✅ ok ');
  expect(cell('ab✅cd', 4)).toBe('ab… ');
  expect(cell('abcdef', 4)).toBe('abc…');
  expect(cell('abc', 4)).toBe('abc ');
});

test('right pads by terminal cells', () => {
  expect(right('✅', 3)).toBe(' ✅');
});

test('fitting cuts the longest name first until the names fit, each keeping its first cell', () => {
  expect(fitting(['resector', 'main'], 20)).toEqual(['resector', 'main']);
  expect(fitting(['show-current-folder', 'main'], 12)).toEqual(['show-cu…', 'main']);
  expect(fitting(['abcdef', 'ghijkl'], 8)).toEqual(['abc…', 'ghi…']);
  expect(fitting(['abcdef', 'ghijkl'], 1)).toEqual(['a…', 'g…']);
});

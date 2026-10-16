// Color for text on a terminal.
import { expect, test } from 'bun:test';
import { palette } from './palette';

test('with color the text is wrapped in the code and a reset; without it stays as is', () => {
  expect(palette(true)('36')('$')).toBe('\x1b[36m$\x1b[0m');
  expect(palette(false)('36')('$')).toBe('$');
});

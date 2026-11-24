import { expect, test } from 'bun:test';
import { formatTokens } from './format';

test('token numbers: whole Ki as such, other thousands with a decimal, the rest as they are', () => {
  expect([0, 512, 999, 1000, 1023, 1024, 1025, 1200, 32768].map(formatTokens)).toEqual(['0', '512', '999', '1.0k', '1.0k', '1k', '1.0k', '1.2k', '32k']);
});

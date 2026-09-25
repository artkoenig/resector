import { expect, test } from 'bun:test';
import { main } from './main';

test('--version prints the package version', () => {
  expect(main(['--version'])).toEqual({ code: 0, out: 'resector 0.0.0\n' });
});

test('unknown arguments print usage and fail', () => {
  expect(main(['--bogus'])).toEqual({ code: 1, out: 'usage: resector --version\n' });
});

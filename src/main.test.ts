import { expect, test } from 'bun:test';
import { main } from './main';

const USAGE = 'usage: resector | resector --version\n';

test('--version prints the package version', () => {
  expect(main(['--version'])).toEqual({ code: 0, out: 'resector 0.0.0\n' });
});

test('unknown arguments print usage and fail', () => {
  expect(main(['--bogus'])).toEqual({ code: 1, out: USAGE });
  expect(main(['stray'])).toEqual({ code: 1, out: USAGE });
});

test('without arguments Resector starts', () => {
  expect(main([])).toBe('start');
});

test('the endpoint comes from the Model Profile, not the command line', () => {
  expect(main(['--endpoint', 'http://gpu:9000'])).toEqual({ code: 1, out: USAGE });
});

import { expect, test } from 'bun:test';
import { main } from './main';

const USAGE = 'usage: resector [--endpoint <url>] | resector --version\n';

test('--version prints the package version', () => {
  expect(main(['--version'])).toEqual({ code: 0, out: 'resector 0.0.0\n' });
});

test('unknown arguments print usage and fail', () => {
  expect(main(['--bogus'])).toEqual({ code: 1, out: USAGE });
  expect(main(['stray'])).toEqual({ code: 1, out: USAGE });
});

test('without arguments the Gate starts against the local llama.cpp server', () => {
  expect(main([])).toEqual({ endpoint: 'http://localhost:8080' });
});

test('--endpoint points the Gate at another server', () => {
  expect(main(['--endpoint', 'http://gpu:9000'])).toEqual({ endpoint: 'http://gpu:9000' });
});

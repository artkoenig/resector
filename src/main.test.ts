import { expect, test } from 'bun:test';
import { main } from './main';

const USAGE = 'usage: resector [-c [id]] | resector --export-fixture [id] | resector --version\n';

test('--version prints the package version', () => {
  expect(main(['--version'])).toEqual({ code: 0, out: 'resector 0.0.0\n' });
});

test('unknown arguments print usage and fail', () => {
  expect(main(['--bogus'])).toEqual({ code: 1, out: USAGE });
  expect(main(['stray'])).toEqual({ code: 1, out: USAGE });
  expect(main(['-c', 'a', 'b'])).toEqual({ code: 1, out: USAGE });
});

test('without arguments Resector starts a new session', () => {
  expect(main([])).toEqual({ start: {} });
});

test('-c resumes the last session, -c <id> a given one (FR-32)', () => {
  expect(main(['-c'])).toEqual({ start: { resume: true } });
  expect(main(['-c', 'ses_a'])).toEqual({ start: { resume: 'ses_a' } });
  expect(main(['--continue', 'ses_a'])).toEqual({ start: { resume: 'ses_a' } });
});

test('--export-fixture exports the last or a given Session Log', () => {
  expect(main(['--export-fixture'])).toEqual({ exportFixture: true });
  expect(main(['--export-fixture', 'ses_a'])).toEqual({ exportFixture: 'ses_a' });
});

test('the endpoint comes from the Model Profile, not the command line', () => {
  expect(main(['--endpoint', 'http://gpu:9000'])).toEqual({ code: 1, out: USAGE });
});

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

test('-c resumes the last session, -c <id> a given one', () => {
  expect(main(['-c'])).toEqual({ start: { resume: true } });
  expect(main(['-c', 'ses_a'])).toEqual({ start: { resume: 'ses_a' } });
  expect(main(['--continue', 'ses_a'])).toEqual({ start: { resume: 'ses_a' } });
});

test('--export-fixture prints the last or a given Session Log', () => {
  const exportLog = (ref: true | string) => `log of ${ref}\n`;
  expect(main(['--export-fixture'], exportLog)).toEqual({ code: 0, out: 'log of true\n' });
  expect(main(['--export-fixture', 'ses_a'], exportLog)).toEqual({ code: 0, out: 'log of ses_a\n' });
  const missing = () => {
    throw new Error('no session in this project');
  };
  expect(main(['--export-fixture'], missing)).toEqual({ code: 1, out: 'resector: no session in this project\n' });
});

test('the endpoint comes from the Model Profile, not the command line', () => {
  expect(main(['--endpoint', 'http://gpu:9000'])).toEqual({ code: 1, out: USAGE });
});

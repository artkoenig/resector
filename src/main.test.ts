import { expect, test } from 'bun:test';
import pkg from '../package.json';
import { main } from './main';

const USAGE =
  'usage: resector [-c [id]] | resector -p <prompt> [options] | resector --export-fixture [id] | resector --version\n' +
  'options with -p: -m <profile> --policy <name|off> --thinking <off|on|level> --tools <list|none> --show <list|all> --max-turns <n> -w --auto-approve\n';

test('--version prints the package version', () => {
  expect(main(['--version'])).toEqual({ code: 0, out: `resector ${pkg.version}\n` });
});

test('unknown arguments print usage and fail', () => {
  expect(main(['--bogus'])).toEqual({ code: 2, out: USAGE });
  expect(main(['stray'])).toEqual({ code: 2, out: USAGE });
  expect(main(['-c', 'a', 'b'])).toEqual({ code: 2, out: USAGE });
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
  expect(main(['--endpoint', 'http://gpu:9000'])).toEqual({ code: 2, out: USAGE });
});

test('-p runs a prompt without the TUI; with -c or a stray argument it is a usage error', () => {
  expect(main(['-p', 'list the files'])).toEqual({ run: { prompt: 'list the files', flags: {} } });
  expect(main(['--prompt', 'hi'])).toEqual({ run: { prompt: 'hi', flags: {} } });
  expect(main(['-p', 'hi', '-c'])).toEqual({ code: 2, out: USAGE });
  expect(main(['-p', 'hi', 'stray'])).toEqual({ code: 2, out: USAGE });
  expect(main(['-p'])).toEqual({ code: 2, out: USAGE });
});

test('the flags of -p are passed on; none without -p, a bad value is a usage error', () => {
  const args = ['-m', 'big', '--policy', 'off', '--thinking', 'high', '--tools', 'bash,search', '--show', 'tools,notes', '--max-turns', '7', '-w', '--auto-approve'];
  expect(main(['-p', 'hi', ...args])).toEqual({
    run: { prompt: 'hi', flags: { profile: 'big', policy: 'off', thinking: 'high', tools: ['bash', 'search'], show: ['tools', 'notes'], maxTurns: 7, worktree: true, autoApprove: true } },
  });
  expect(main(['-p', 'hi', '--tools', 'none', '--show', 'all', '--model', 'big', '--worktree'])).toEqual({
    run: { prompt: 'hi', flags: { tools: [], show: ['thinking', 'tools', 'notes', 'policy'], profile: 'big', worktree: true } },
  });
  for (const bad of [['--max-turns', '0'], ['--max-turns', 'many'], ['--show', 'tools,colors']]) expect(main(['-p', 'hi', ...bad])).toEqual({ code: 2, out: USAGE });
  for (const alone of [['-m', 'big'], ['--auto-approve'], ['-w'], ['-c', '--tools', 'none']]) expect(main(alone)).toEqual({ code: 2, out: USAGE });
});

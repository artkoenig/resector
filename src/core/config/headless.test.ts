import { expect, test } from 'bun:test';
import { readConfig } from './config';
import { SUBAGENT_ENV, headlessSettings } from './headless';

const known = { policies: ['summary-reset', 'mine'], tools: ['bash', 'question', 'websearch'], repository: true };
const config = (headless: object, rest: object = {}) =>
  readConfig([{ source: 'global', text: JSON.stringify({ profiles: { a: { backend: 'llamacpp' }, b: { backend: 'ollama' } }, defaultProfile: 'a', headless, ...rest }) }]).config;

test('flags override the headless section, which overrides nothing else', () => {
  const settings = headlessSettings(config({ profile: 'b', policy: 'mine', tools: ['bash'], maxTurns: 5, worktree: true }), { policy: 'off', tools: [] }, known);
  expect(settings).toEqual({ profile: 'b', policy: 'off', tools: [], maxTurns: 5, worktree: true, autoApprove: true });
});

test('Auto-approve is on unless the config switches it off; the flag overrides the config', () => {
  expect(headlessSettings(config({}), {}, known)).toEqual({ autoApprove: true });
  expect(headlessSettings(config({}, { autoApprove: false }), {}, known)).toEqual({ autoApprove: false });
  expect(headlessSettings(config({}, { autoApprove: false }), { autoApprove: true }, known)).toEqual({ autoApprove: true });
  expect(headlessSettings(config({}), { autoApprove: false }, known)).toEqual({ autoApprove: false });
});

test('an unknown profile, policy or tool is a usage error naming the valid ones', () => {
  expect(headlessSettings(config({ profile: 'x' }), {}, known)).toEqual({ usage: 'unknown profile x (profiles: a, b)' });
  expect(headlessSettings(config({}), { policy: 'nope' }, known)).toEqual({ usage: 'unknown policy nope (policies: summary-reset, mine, off)' });
  expect(headlessSettings(config({}), { tools: ['bash', 'web', 'grep'] }, known)).toEqual({ usage: 'unknown tools web, grep (tools: bash, question, websearch)' });
});

test('a worktree outside a git repository is a usage error, from a flag or the headless section', () => {
  const outside = { ...known, repository: false };
  expect(headlessSettings(config({}), { worktree: true }, outside)).toEqual({ usage: 'worktree: not a git repository' });
  expect(headlessSettings(config({ worktree: true }), {}, outside)).toEqual({ usage: 'worktree: not a git repository' });
});

test('the environment variable marking a Subagent', () => {
  expect(SUBAGENT_ENV).toBe('RESECTOR_SUBAGENT');
});

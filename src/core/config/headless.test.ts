import { expect, test } from 'bun:test';
import { readConfig } from './config';
import { headlessSettings } from './headless';

const known = { policies: ['summary-reset', 'mine'], tools: ['bash', 'question', 'search'], repository: true };
const config = (headless: object) =>
  readConfig([{ source: 'global', text: JSON.stringify({ profiles: { a: { backend: 'llamacpp' }, b: { backend: 'ollama' } }, defaultProfile: 'a', headless }) }]).config;

test('flags override the headless section, which overrides nothing else', () => {
  const settings = headlessSettings(config({ profile: 'b', policy: 'mine', tools: ['bash'], maxTurns: 5, worktree: true }), { policy: 'off', tools: [], autoApprove: true }, known);
  expect(settings).toEqual({ profile: 'b', policy: 'off', tools: [], maxTurns: 5, worktree: true, autoApprove: true });
  expect(headlessSettings(config({}), {}, known)).toEqual({ autoApprove: false });
});

test('an unknown profile, policy or tool is a usage error naming the valid ones', () => {
  expect(headlessSettings(config({ profile: 'x' }), {}, known)).toEqual({ usage: 'unknown profile x (profiles: a, b)' });
  expect(headlessSettings(config({}), { policy: 'nope' }, known)).toEqual({ usage: 'unknown policy nope (policies: summary-reset, mine, off)' });
  expect(headlessSettings(config({}), { tools: ['bash', 'web', 'grep'] }, known)).toEqual({ usage: 'unknown tools web, grep (tools: bash, question, search)' });
});

test('a worktree outside a git repository is a usage error, from a flag or the headless section', () => {
  const outside = { ...known, repository: false };
  expect(headlessSettings(config({}), { worktree: true }, outside)).toEqual({ usage: 'worktree: not a git repository' });
  expect(headlessSettings(config({ worktree: true }), {}, outside)).toEqual({ usage: 'worktree: not a git repository' });
});

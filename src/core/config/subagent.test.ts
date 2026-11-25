import { expect, test } from 'bun:test';
import { readConfig } from './config';
import { subagentRefusal } from './subagent';

const config = (subagent?: object) =>
  readConfig([{ source: 'global', text: JSON.stringify({ profiles: { a: { backend: 'llamacpp' }, b: { backend: 'ollama' } }, ...(subagent && { subagent }) }) }]).config;

test('two Subagents run at once unless subagent.max says otherwise', () => {
  expect(subagentRefusal(config(), 1)).toBeNull();
  expect(subagentRefusal(config(), 2)).toBe('limit reached: 2 running');
  expect(subagentRefusal(config({ profile: 'b' }), 2)).toBe('limit reached: 2 running');
  expect(subagentRefusal(config({ max: 3 }), 2)).toBeNull();
  expect(subagentRefusal(config({ max: 1 }), 1)).toBe('limit reached: 1 running');
});

test('an unknown subagent.profile refuses every start, listing the valid names', () => {
  expect(subagentRefusal(config({ profile: 'b' }), 0)).toBeNull();
  expect(subagentRefusal(config({ profile: 'constructor' }), 0)).toBe('subagent.profile: unknown profile constructor (profiles: a, b)');
});

test('a worktree of its own needs a git repository: asked for by the call or by headless.worktree', () => {
  expect(subagentRefusal(config(), 0, { worktree: true, repository: false })).toBe('worktree: not a git repository');
  expect(subagentRefusal(config(), 0, { worktree: true, repository: true })).toBeNull();
  expect(subagentRefusal(config(), 0, { repository: false })).toBeNull();
  // Where it runs left out: a git repository.
  expect(subagentRefusal({ ...config(), headless: { worktree: true } }, 0)).toBeNull();
  expect(subagentRefusal({ ...config(), headless: { worktree: true } }, 0, { repository: false })).toBe('worktree: not a git repository');
});

// Starting Subagents: the process's arguments and environment.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackground } from './background';
import { createSubagents } from './subagent';

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'resector-subagent-')));
const registry = createBackground({ dir: join(cwd, 'logs'), record: join(cwd, 'ses.background') });
afterEach(() => registry.stopAll());
const NO_REPOSITORY = { repository: false, worktrees: join(cwd, 'worktrees'), session: () => 'ses_x' };
const options = { signal: new AbortController().signal, onOutput: () => {} };

test('the process of a Subagent gets prompt, profile and flags unchanged, without a shell', async () => {
  const started: Parameters<typeof registry.start>[] = [];
  const recording = { ...registry, start: (...args: Parameters<typeof registry.start>) => (started.push(args), registry.start(['true'], args[1])) };
  const prompt = '-fix "it" $(rm x)\n`now`';
  await createSubagents({ cwd, profile: 'qwen', config: { profiles: {} }, registry: recording, ...NO_REPOSITORY }).run(prompt, { signal: new AbortController().signal, onOutput: () => {} });
  const [argv, { cwd: at, wait, env }] = started[0]!;
  expect(argv.slice(2)).toEqual([`--prompt=${prompt}`, '--model=qwen', '--auto-approve', '--show', 'tools', '--no-worktree']);
  expect({ at, wait, env }).toEqual({ at: cwd, wait: 0, env: { RESECTOR_SUBAGENT: 'start', RESECTOR_SUBAGENT_REPORTS: registry.dir } });
});

test('the Subagents run on the configured profile', async () => {
  let argv: string | string[] = [];
  const recording = { ...registry, start: (...[command, options]: Parameters<typeof registry.start>) => ((argv = command), registry.start(['true'], options)) };
  const subagents = createSubagents({ cwd, profile: 'qwen', config: { profiles: {}, subagent: { profile: 'other' } }, registry: recording, ...NO_REPOSITORY });
  await subagents.run('go', { signal: new AbortController().signal, onOutput: () => {} });
  expect(argv).toContain('--model=other');
  expect(subagents.refused(0)).toBe('subagent.profile: unknown profile other (profiles: )');
});

test('a process started from its arguments sees them as they are, and the environment added to it', async () => {
  const result = await registry.start(['sh', '-c', 'printf "%s|%s" "$1" "$ADDED"', 'sh', '$(x) "y"'], { cwd, wait: 5, signal: new AbortController().signal, env: { ADDED: 'yes' } });
  expect(result.output).toBe('$(x) "y"|yes');
});

const gitIn = (root: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root }).stdout.toString().trim();
function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resector-subagent-repo-')));
  gitIn(root, 'init', '-q', '-b', 'main');
  gitIn(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first');
  return root;
}
// Records what would be started, and starts `true` instead.
function recorded() {
  const started: Parameters<typeof registry.start>[] = [];
  return { started, recording: { ...registry, start: (...args: Parameters<typeof registry.start>) => (started.push(args), registry.start(['true'], args[1])) } };
}

test('with worktree the parent makes the worktree from its HEAD and hands the Session id over; the result names it', async () => {
  const root = repository();
  const worktrees = join(cwd, 'data', 'worktrees');
  const { started, recording } = recorded();
  const subagents = createSubagents({ cwd: root, profile: 'qwen', config: { profiles: {} }, registry: recording, repository: true, worktrees, session: () => 'ses_child' });
  const result = await subagents.run('fix', { ...options, worktree: true });
  const path = join(worktrees, 'ses_child');
  expect(result.background?.worktree).toEqual({ path, branch: 'resector/ses_child', base: gitIn(root, 'rev-parse', 'HEAD') });
  expect(gitIn(path, 'branch', '--show-current')).toBe('resector/ses_child');
  const [argv, { cwd: at, env }] = started[0]!;
  expect(argv.slice(2)).toEqual(['--prompt=fix', '--model=qwen', '--auto-approve', '--show', 'tools', '--worktree']);
  expect({ at, env }).toEqual({ at: root, env: { RESECTOR_SUBAGENT: 'start', RESECTOR_SUBAGENT_REPORTS: registry.dir, RESECTOR_SUBAGENT_SESSION: 'ses_child' } });
});

test('headless.worktree gives every Subagent a worktree; without either it runs where its parent does', async () => {
  const root = repository();
  const worktrees = join(cwd, 'data2', 'worktrees');
  const { started, recording } = recorded();
  const at = { cwd: root, profile: 'qwen', registry: recording, repository: true, worktrees, session: () => 'ses_child' };
  const plain = createSubagents({ ...at, config: { profiles: {} } });
  expect([plain.worktree(), plain.worktree(true)]).toEqual([false, true]);
  expect((await plain.run('look', options)).background?.worktree).toBeUndefined();
  // The parent's decision holds: the Subagent's own config does not make one.
  expect(started[0]![0]).toContain('--no-worktree');
  expect(existsSync(worktrees)).toBe(false);
  expect(createSubagents({ ...at, config: { profiles: {}, headless: { worktree: true } } }).worktree()).toBe(true);
});

test('outside a git repository a call with worktree is refused; a worktree that cannot be made fails the call, nothing is started', async () => {
  const { started, recording } = recorded();
  const at = { cwd, profile: 'qwen', config: { profiles: {} }, registry: recording, worktrees: join(cwd, 'data3', 'worktrees'), session: () => 'ses_child' };
  expect(createSubagents({ ...at, repository: false }).refused(0, true)).toBe('worktree: not a git repository');
  expect(createSubagents({ ...at, repository: false }).refused(0)).toBeNull();
  const result = await createSubagents({ ...at, repository: true }).run('fix', { ...options, worktree: true });
  expect(result).toMatchObject({ exit: 1, stopped: null });
  expect(result.output).toStartWith('worktree: ');
  expect(started).toEqual([]);
});

test('a start that yields no Background Process leaves no worktree and no branch', async () => {
  const root = repository();
  const worktrees = join(cwd, 'data4', 'worktrees');
  const none = { ...registry, start: async () => ({ output: '', exit: null, stopped: 'killed' as const }) };
  const subagents = createSubagents({ cwd: root, profile: 'qwen', config: { profiles: {} }, registry: none, repository: true, worktrees, session: () => 'ses_child' });
  expect((await subagents.run('fix', { ...options, worktree: true })).background).toBeUndefined();
  expect(existsSync(join(worktrees, 'ses_child'))).toBe(false);
  expect(gitIn(root, 'branch', '--list', 'resector/ses_child')).toBe('');
});

import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorktree, isRepository, listBranches, status, switchBranch, watchHead } from './git';

// A repository with one commit on main.
function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resector-git-')));
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return root;
}
const gitIn = (root: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root }).stdout.toString().trim();

test('a directory is a repository only inside a git work tree', () => {
  expect(isRepository(realpathSync(mkdtempSync(join(tmpdir(), 'resector-plain-'))))).toBe(false);
  expect(isRepository(repository())).toBe(true);
});

test('the branches: the current one and all local ones; switching goes to an existing branch only', () => {
  const root = repository();
  gitIn(root, 'branch', 'feature/x');
  expect(listBranches(root)).toEqual({ current: 'main', all: ['feature/x', 'main'], elsewhere: {} });
  switchBranch(root, 'feature/x');
  expect(listBranches(root).current).toBe('feature/x');
  expect(() => switchBranch(root, 'nope')).toThrow('no branch nope');
});

test('switching with conflicting changes fails with git message', () => {
  const root = repository();
  gitIn(root, 'switch', '-q', '-c', 'other');
  writeFileSync(join(root, 'a.txt'), 'other\n');
  gitIn(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'other');
  gitIn(root, 'switch', '-q', 'main');
  writeFileSync(join(root, 'a.txt'), 'dirty\n');
  expect(() => switchBranch(root, 'other')).toThrow('error:');
  expect(listBranches(root).current).toBe('main');
});

test('the status: dirty with uncommitted changes, clean without', () => {
  const root = repository();
  expect(status(root)).toBe(false);
  writeFileSync(join(root, 'a.txt'), 'dirty\n');
  expect(status(root)).toBe(true);
  gitIn(root, 'add', '.');
  expect(status(root)).toBe(true);
  gitIn(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'dirty');
  expect(status(root)).toBe(false);
});

test("a session's worktree: created on its own branch, ignored by the project, reused and recreated", () => {
  const root = repository();
  const path = ensureWorktree(root, 'ses_1');
  expect(path).toBe(join(root, '.resector/worktrees/ses_1'));
  expect(listBranches(path).current).toBe('resector/ses_1');
  expect(existsSync(join(path, 'a.txt'))).toBe(true);
  expect(gitIn(root, 'status', '--porcelain')).toBe('');
  writeFileSync(join(path, 'b.txt'), 'b\n');
  expect(ensureWorktree(root, 'ses_1')).toBe(path);
  expect(existsSync(join(path, 'b.txt'))).toBe(true);
  rmSync(join(root, '.resector/worktrees/ses_1'), { recursive: true });
  expect(listBranches(ensureWorktree(root, 'ses_1')).current).toBe('resector/ses_1');
});

test('watching HEAD: a branch switch outside is reported until stopped', async () => {
  const root = repository();
  gitIn(root, 'branch', 'other');
  let changes = 0;
  const stop = watchHead(root, () => changes++);
  gitIn(root, 'switch', '-q', 'other');
  await Bun.sleep(200);
  expect(changes).toBeGreaterThan(0);
  stop();
  const seen = changes;
  gitIn(root, 'switch', '-q', 'main');
  await Bun.sleep(200);
  expect(changes).toBe(seen);
});

test('branches checked out in another worktree are marked with its directory', () => {
  const root = repository();
  const path = ensureWorktree(root, 'ses_3');
  expect(listBranches(root).elsewhere).toEqual({ 'resector/ses_3': path });
  expect(listBranches(path).elsewhere).toEqual({ main: root });
  expect(() => switchBranch(path, 'main')).toThrow('already used by worktree');
});

test('started in a subdirectory, the session runs in the same subdirectory of its worktree', () => {
  const root = repository();
  mkdirSync(join(root, 'pkg'));
  writeFileSync(join(root, 'pkg/p.txt'), '');
  gitIn(root, 'add', '.');
  gitIn(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'pkg');
  expect(ensureWorktree(join(root, 'pkg'), 'ses_2')).toBe(join(root, 'pkg/.resector/worktrees/ses_2/pkg'));
});

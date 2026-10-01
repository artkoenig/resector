import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorktree, isRepository, locateCheckout, mainCheckout, topLevel, listBranches, removeWorktree, status, switchBranch, watchHead, worktreeDirty } from './git';

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
// Where the Session Worktrees go: the Project Home's data root, outside the repository.
const worktreesDir = () => join(realpathSync(mkdtempSync(join(tmpdir(), 'resector-data-'))), 'worktrees');
const commit = (dir: string, message: string) => gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', message);

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
  commit(root, 'dirty');
  expect(status(root)).toBe(false);
});

test("a session's worktree: created on its own branch outside the project, reused and recreated", () => {
  const root = repository();
  const worktrees = worktreesDir();
  const path = ensureWorktree(root, worktrees, 'ses_1');
  expect(path).toBe(join(worktrees, 'ses_1'));
  expect(listBranches(path).current).toBe('resector/ses_1');
  expect(existsSync(join(path, 'a.txt'))).toBe(true);
  expect(gitIn(root, 'status', '--porcelain', '--ignored')).toBe('');
  expect(existsSync(join(worktrees, '.gitignore'))).toBe(false);
  writeFileSync(join(path, 'b.txt'), 'b\n');
  expect(ensureWorktree(root, worktrees, 'ses_1')).toBe(path);
  expect(existsSync(join(path, 'b.txt'))).toBe(true);
  // Deleted by hand: the stale entry is pruned, the worktree created anew on its branch.
  rmSync(path, { recursive: true });
  expect(listBranches(ensureWorktree(root, worktrees, 'ses_1')).current).toBe('resector/ses_1');
});

test('removing a clean worktree deletes its branch when merged', () => {
  const root = repository();
  const worktrees = worktreesDir();
  const path = ensureWorktree(root, worktrees, 'ses_1');
  expect(worktreeDirty(worktrees, 'ses_1')).toBe(false);
  expect(removeWorktree(root, worktrees, 'ses_1')).toEqual({ branch: 'resector/ses_1', kept: false });
  expect(existsSync(path)).toBe(false);
  expect(listBranches(root).all).toEqual(['main']);
  expect(gitIn(root, 'worktree', 'list')).not.toContain('ses_1');
});

test('a worktree with uncommitted changes is removed only with force; an unmerged branch is kept', () => {
  const root = repository();
  const worktrees = worktreesDir();
  const path = ensureWorktree(root, worktrees, 'ses_1');
  writeFileSync(join(path, 'a.txt'), 'changed\n');
  commit(path, 'unmerged');
  writeFileSync(join(path, 'b.txt'), 'b\n');
  expect(worktreeDirty(worktrees, 'ses_1')).toBe(true);
  expect(() => removeWorktree(root, worktrees, 'ses_1')).toThrow('--force');
  expect(existsSync(join(path, 'b.txt'))).toBe(true);
  expect(removeWorktree(root, worktrees, 'ses_1', true)).toEqual({ branch: 'resector/ses_1', kept: true });
  expect(existsSync(path)).toBe(false);
  expect(listBranches(root).all).toEqual(['main', 'resector/ses_1']);
});

test('a session without worktree or branch has nothing to remove; a worktree deleted by hand leaves its branch', () => {
  const root = repository();
  const worktrees = worktreesDir();
  expect(worktreeDirty(worktrees, 'ses_1')).toBe(false);
  expect(removeWorktree(root, worktrees, 'ses_1')).toBeNull();
  rmSync(ensureWorktree(root, worktrees, 'ses_2'), { recursive: true });
  expect(removeWorktree(root, worktrees, 'ses_2')).toEqual({ branch: 'resector/ses_2', kept: false });
  expect(listBranches(root).all).toEqual(['main']);
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
  const path = ensureWorktree(root, worktreesDir(), 'ses_3');
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
  const worktrees = worktreesDir();
  expect(ensureWorktree(join(root, 'pkg'), worktrees, 'ses_2')).toBe(join(worktrees, 'ses_2/pkg'));
  expect(existsSync(join(root, 'pkg/.resector'))).toBe(false);
});

test("a session's checkout now: its real path, its top level when only a subdirectory is gone, none when gone", () => {
  const root = repository();
  const project = mainCheckout(root);
  mkdirSync(join(root, 'sub'));
  const link = join(realpathSync(mkdtempSync(join(tmpdir(), 'resector-link-'))), 'repo');
  Bun.spawnSync(['ln', '-s', root, link]);
  expect(locateCheckout(join(link, 'sub'), project)).toBe(join(root, 'sub'));
  expect(locateCheckout(join(root, 'sub/gone'), project)).toBe(root);
  expect(locateCheckout(join(root, 'sub/gone'), mainCheckout(repository()))).toBeNull();
  expect(locateCheckout(join(root, 'sub/gone'), null)).toBeNull();
  expect(locateCheckout('/gone/checkout', project)).toBeNull();
  expect(topLevel(join(root, 'sub'))).toBe(root);
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'resector-plain-')));
  expect(topLevel(plain)).toBe(plain);
});

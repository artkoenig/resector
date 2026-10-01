// Git in the project: its branches, switching the branch, and a session's own worktree.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// current: null on a detached HEAD. elsewhere: the branches checked out in another worktree, with its directory;
// git refuses to switch to them.
export type Branches = { current: string | null; all: string[]; elsewhere: Record<string, string> };

function git(root: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr.trim().split('\n')[0] || `git ${args[0]} failed`);
  return run.stdout.trim();
}

// The main worktree, listed first by git: the same from every worktree. A submodule's is listed as its git dir,
// whose top level is the submodule's checkout; a bare repository has none and stays itself. GIT_DIR and friends
// from a calling hook must not point elsewhere. Null outside a repository.
export function mainCheckout(dir: string): string | null {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const out = (cwd: string, ...args: string[]) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    return run.status === 0 ? run.stdout.trim() : null;
  };
  const main = out(dir, 'worktree', 'list', '--porcelain')?.match(/^worktree (.+)$/m)?.[1];
  return main ? (out(main, 'rev-parse', '--show-toplevel') ?? main) : null;
}

// The checkout's top level, where its instructions live; the directory itself outside git.
export function topLevel(dir: string): string {
  const run = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : dir;
}

// Where a session started in `started` runs now, as a real path: there, or the top level of its checkout when only a
// subdirectory is gone and that checkout still belongs to the Project (its main checkout `project`); null when gone.
export function locateCheckout(started: string, project: string | null): string | null {
  if (existsSync(started)) return realpathSync(started);
  let up = dirname(started);
  while (!existsSync(up)) up = dirname(up);
  const top = topLevel(up);
  return project && mainCheckout(top) === project ? realpathSync(top) : null;
}

export function isRepository(root: string): boolean {
  return spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).stdout.trim() === 'true';
}

export function listBranches(root: string): Branches {
  const all = git(root, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
  return { current: git(root, 'branch', '--show-current') || null, all, elsewhere: otherWorktrees(root) };
}

function otherWorktrees(root: string): Record<string, string> {
  const own = git(root, 'rev-parse', '--show-toplevel');
  const elsewhere: Record<string, string> = {};
  for (const block of git(root, 'worktree', 'list', '--porcelain').split('\n\n')) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (path && branch && path !== own) elsewhere[branch] = path;
  }
  return elsewhere;
}

// Whether the working tree has uncommitted changes.
export function status(root: string): boolean {
  return git(root, 'status', '--porcelain') !== '';
}

// Only an existing local branch: git would otherwise create one from a remote of the same name.
export function switchBranch(root: string, name: string) {
  if (!listBranches(root).all.includes(name)) throw new Error(`no branch ${name}`);
  git(root, 'switch', '--quiet', name);
}

// Calls onChange when HEAD changes, whoever switched the branch (the model's bash, another terminal); returns the stop.
// Git replaces HEAD by renaming HEAD.lock, so the directory is watched.
export function watchHead(root: string, onChange: () => void): () => void {
  const watcher = watch(git(root, 'rev-parse', '--absolute-git-dir'), (_, file) => file === 'HEAD' && onChange());
  return () => watcher.close();
}

export const worktreeBranch = (session: string) => `resector/${session}`;

const hasBranch = (root: string, branch: string) =>
  spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root }).status === 0;

// The session's worktree under worktrees/<session> (the Project Home's data root, outside the repository) on branch
// `resector/<session>`, created from HEAD the first time and reused afterwards; returns the directory the session
// runs in (the project's subdirectory in it). Entries of worktrees deleted by hand are pruned first.
export function ensureWorktree(root: string, worktrees: string, session: string): string {
  const path = join(worktrees, session);
  const prefix = git(root, 'rev-parse', '--show-prefix');
  git(root, 'worktree', 'prune');
  if (!existsSync(join(path, '.git'))) {
    mkdirSync(worktrees, { recursive: true });
    const branch = worktreeBranch(session);
    git(root, 'worktree', 'add', '--quiet', ...(hasBranch(root, branch) ? [path, branch] : ['-b', branch, path]));
  }
  return resolve(path, prefix);
}

// Whether the session's worktree has uncommitted changes; false without one.
export function worktreeDirty(worktrees: string, session: string): boolean {
  const path = join(worktrees, session);
  return existsSync(join(path, '.git')) && status(path);
}

// Removes the session's worktree (with force also its uncommitted changes, which git refuses otherwise) and its
// branch only if merged (kept: true otherwise). Null when the session has neither.
export function removeWorktree(root: string, worktrees: string, session: string, force = false): { branch: string; kept: boolean } | null {
  const path = join(worktrees, session);
  const branch = worktreeBranch(session);
  git(root, 'worktree', 'prune');
  if (existsSync(join(path, '.git'))) git(root, 'worktree', 'remove', ...(force ? ['--force'] : []), path);
  if (!hasBranch(root, branch)) return null;
  const kept = spawnSync('git', ['branch', '-d', branch], { cwd: root }).status !== 0;
  return { branch, kept };
}

// Git in the project: its branches, switching the branch, and a session's own worktree.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

// The session's worktree under `.resector/worktrees/<session>` on branch `resector/<session>`, created from HEAD the
// first time and reused afterwards; returns the directory the session runs in (the project's subdirectory in it).
export function ensureWorktree(root: string, session: string): string {
  const dir = join(root, '.resector/worktrees');
  const path = join(dir, session);
  const prefix = git(root, 'rev-parse', '--show-prefix');
  if (!existsSync(join(path, '.git'))) {
    mkdirSync(dir, { recursive: true });
    // Ignored in the project itself, without touching its .gitignore.
    writeFileSync(join(dir, '.gitignore'), '*\n');
    git(root, 'worktree', 'prune');
    const branch = worktreeBranch(session);
    const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root }).status === 0;
    git(root, 'worktree', 'add', '--quiet', ...(exists ? [path, branch] : ['-b', branch, path]));
  }
  return resolve(path, prefix);
}

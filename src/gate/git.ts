// Git at the Gate: the branch where the session runs, the environment Note following it, /git:branch and /git:worktree.
import { createSignal, onCleanup } from 'solid-js';
import { refreshEnvironment } from '../core/notes/environment';
import { inWorktree } from '../core/session/session';
import { errorText } from './text';
import type { Kernel } from './kernel';
import type { Branches, Git, Project, Status } from './types';

export type GitSlice = ReturnType<typeof createGit>;

export function createGit(k: Kernel, git: Git | null, project: Project, root: string) {
  const { events, setStatus } = k;
  // The git branch where the session runs, as of the last look: tool calls may switch it too.
  const branchesNow = (): Branches => {
    try {
      return git?.branches() ?? { current: null, all: [], elsewhere: {} };
    } catch {
      return { current: null, all: [], elsewhere: {} };
    }
  };
  const branchNow = () => branchesNow().current;
  const [branch, setBranch] = createSignal(branchNow());
  // The working tree's dirtiness, as of the last look: tool calls may change it too.
  const dirtyNow = () => {
    try {
      return git?.status() ?? false;
    } catch {
      return false;
    }
  };
  const [dirty, setDirty] = createSignal(dirtyNow());
  const lookAgain = () => {
    setBranch(branchNow());
    setDirty(dirtyNow());
  };
  // Switched or dirtied outside the Gate too (another terminal): the header follows.
  const unwatch = git?.watch(lookAgain);
  if (unwatch) onCleanup(unwatch);
  // The environment Note, refreshed when the environment changed.
  function refresh() {
    lookAgain();
    const edit = refreshEnvironment(events(), k.context(), project.environment());
    if (edit) k.append(edit);
  }
  refresh();

  // /git:branch <name> switches to an existing branch where the session runs; alone it shows the current one.
  function switchBranch(name: string) {
    const { current, all } = git!.branches();
    if (!name) return setStatus({ text: `branch ${current ?? '(detached)'} · /git:branch ${all.filter(b => b !== current).join(' ')}`, tone: 'info' });
    if (!k.idle()) return setStatus({ text: 'busy – switch the branch at the Gate', tone: 'info' });
    try {
      git!.switchBranch(name);
    } catch (e) {
      return setStatus({ text: `git: ${errorText(e)}`, tone: 'error' });
    }
    refresh();
    setStatus({ text: `switched to branch ${name}`, tone: 'ok' });
  }
  // /git:worktree on runs the session in its own worktree, off in the project again; the worktree stays for the
  // next on. Alone it says where the session runs.
  function switchWorktree(value: string) {
    const refusal = worktreeRefusal(value);
    if (refusal) return setStatus(refusal);
    try {
      const dir = git!.worktree(value === 'on');
      k.append({ type: 'WorktreeSet', on: value === 'on' });
      git!.reopen({ text: value === 'on' ? `worktree on – session runs in ${dir}` : `worktree off – session runs in ${dir}, worktree kept`, tone: 'ok' });
    } catch (e) {
      setStatus({ text: `git: ${errorText(e)}`, tone: 'error' });
    }
  }
  // Why /git:worktree <value> does not switch: no value, an unknown one, already so, or busy; null when it switches.
  function worktreeRefusal(value: string): Status | null {
    const now = inWorktree(events()) ? 'on' : 'off';
    if (!value) return { text: `worktree ${now} · runs in ${root} · /git:worktree ${now === 'on' ? 'off' : 'on'}`, tone: 'info' };
    if (!['on', 'off'].includes(value)) return { text: `unknown value ${value}: /git:worktree on off`, tone: 'error' };
    if (value === now) return { text: `worktree already ${value}`, tone: 'info' };
    if (!k.idle()) return { text: 'busy – switch the worktree at the Gate', tone: 'info' };
    return null;
  }

  return {
    branch,
    dirty,
    // A tool call may have switched the branch or dirtied the tree.
    lookAgain,
    // All branches with the other worktree holding one.
    branches: () => {
      const { all, elsewhere } = branchesNow();
      return all.map(name => ({ name, elsewhere: elsewhere[name] ?? null }));
    },
    worktree: () => inWorktree(events()),
    refresh, switchBranch, switchWorktree,
  };
}

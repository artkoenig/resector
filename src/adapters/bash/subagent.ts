// Starts Subagents: `resector -p` as a Background Process, its argv without a shell so the prompt needs no quoting.
import { join } from 'node:path';
import type { Config } from '../../core/config/config';
import { SUBAGENT_ENV, SUBAGENT_SESSION_ENV } from '../../core/config/headless';
import { inWorktree, subagentRefusal } from '../../core/config/subagent';
import type { SubagentWorktree } from '../../core/log/events';
import type { RunResult } from '../../core/tools/call';
import type { Subagents } from '../../gate/ports';
import { ensureWorktree, head, settleWorktree, worktreeBranch } from '../git/git';
import { GRACE, type Background } from './background';
import { REPORTS_ENV } from './report';

const MAIN = join(import.meta.dir, '..', '..', 'main.ts');

export type SubagentsOptions = {
  // Where the parent Session runs.
  cwd: string;
  // Its Model Profile, the Subagents' unless the config names one.
  profile: string;
  config: Pick<Config, 'profiles' | 'subagent' | 'headless'>;
  registry: Background;
  // Whether cwd is in a git repository; worktrees: where Session Worktrees live.
  repository: boolean;
  worktrees: string;
  // An id no Session has yet, for a Subagent's.
  session: () => string;
};

// The result comes at once.
export function createSubagents({ cwd, profile, config, registry, repository, worktrees, session }: SubagentsOptions): Subagents {
  // `=`: a prompt or name starting with - is no flag.
  const argv = (prompt: string) => [process.execPath, MAIN, `--prompt=${prompt}`, `--model=${config.subagent?.profile ?? profile}`, '--auto-approve', '--show', 'tools'];
  // Its grace exceeds the one it gives its own Background Processes: killed sooner, it would leave them running.
  // The Session id is picked here, so the parent's log names it whatever becomes of the process.
  async function start(command: string[], signal: AbortSignal, id: string): Promise<RunResult> {
    const env = { [SUBAGENT_ENV]: 'start', [REPORTS_ENV]: registry.dir, [SUBAGENT_SESSION_ENV]: id };
    const result = await registry.start(command, { cwd, wait: 0, signal, env, grace: 2 * GRACE });
    return result.background ? { ...result, background: { ...result.background, session: id } } : result;
  }
  // The worktree is made here, from the HEAD of where the parent runs, so the result can name it; the Subagent's
  // Session gets the id picked for it and finds its worktree there.
  async function startInWorktree(prompt: string, signal: AbortSignal) {
    const id = session();
    let worktree: SubagentWorktree;
    try {
      worktree = { path: join(worktrees, id), branch: worktreeBranch(id), base: head(cwd) };
      ensureWorktree(cwd, worktrees, id);
    } catch (e) {
      return { output: `worktree: ${e instanceof Error ? e.message : String(e)}`, exit: 1, stopped: null };
    }
    // Nothing runs in it: no exit would remove it later.
    const discard = () => {
      try {
        settleWorktree(cwd, worktree);
      } catch {}
    };
    try {
      const result = await start([...argv(prompt), '--worktree'], signal, id);
      if (result.background) return { ...result, background: { ...result.background, worktree } };
      discard();
      return result;
    } catch (e) {
      discard();
      throw e;
    }
  }
  return {
    timeout: 0,
    refused: (running, worktree) => subagentRefusal(config, running, { worktree, repository }),
    worktree: asked => inWorktree(config, asked),
    // --no-worktree: the decision is the parent's, the Subagent's own config makes none.
    run: (prompt, { signal, worktree }) => (worktree ? startInWorktree(prompt, signal) : start([...argv(prompt), '--no-worktree'], signal, session())),
  };
}

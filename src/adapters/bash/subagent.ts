// Starts Subagents: `resector -p` as a Background Process, its argv without a shell so the prompt needs no quoting.
import { join } from 'node:path';
import type { Config } from '../../core/config/config';
import { SUBAGENT_ENV } from '../../core/config/headless';
import { subagentRefusal } from '../../core/config/subagent';
import type { Subagents } from '../../gate/ports';
import { GRACE, type Background } from './background';
import { REPORTS_ENV } from './report';

const MAIN = join(import.meta.dir, '..', '..', 'main.ts');

// cwd: where the parent Session runs; profile: its Model Profile, the Subagents' unless the config names one. The result comes at once.
export function createSubagents({ cwd, profile, config, registry }: { cwd: string; profile: string; config: Pick<Config, 'profiles' | 'subagent'>; registry: Background }): Subagents {
  // `=`: a prompt or name starting with - is no flag.
  const argv = (prompt: string) => [process.execPath, MAIN, `--prompt=${prompt}`, `--model=${config.subagent?.profile ?? profile}`, '--auto-approve', '--show', 'tools'];
  return {
    timeout: 0,
    refused: running => subagentRefusal(config, running),
    // Its grace exceeds the one it gives its own Background Processes: killed sooner, it would leave them running.
    run: (prompt, { signal }) => registry.start(argv(prompt), { cwd, wait: 0, signal, env: { [SUBAGENT_ENV]: 'start', [REPORTS_ENV]: registry.dir }, grace: 2 * GRACE }),
  };
}

// search runner: the query goes to ddgr (DuckDuckGo from the terminal), its JSON results are the output.
// ddgr reports a blocked or failed request on stderr and still exits 0: the output carries it to the model.
import type { Runner } from '../../core/tools/runner';
import { processRunner } from '../bash/runner';

// Results per search: few, for small context windows.
const RESULTS = 5;
// ddgr not installed: the model reads why, like a shell's "command not found".
const MISSING = { output: 'ddgr not found: install ddgr (https://github.com/jarun/ddgr) to search\n', exit: 127, stopped: null };

// timeout: seconds.
export function createSearcher({ cwd, timeout }: { cwd: string; timeout: number }): Runner {
  const ddgr = processRunner(query => ['ddgr', '--json', '--noprompt', '-n', String(RESULTS), '--', query], { cwd, timeout });
  return {
    timeout,
    run: (query, options) =>
      ddgr.run(query, options).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return MISSING;
        throw e;
      }),
  };
}

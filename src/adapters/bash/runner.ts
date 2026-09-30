// bash runner: `bash -c` in the project root, stdin /dev/null, output streamed,
// killed with everything it started on abort (Esc) or timeout.
import { spawn } from 'node:child_process';
import type { Runner } from '../../gate/ports';
import type { RunResult } from '../../core/tools/call';
import type { Stopped } from '../../core/log/events';

// timeout: seconds.
export function createRunner({ cwd, timeout }: { cwd: string; timeout: number }): Runner {
  return processRunner(command => ['bash', '-c', command], { cwd, timeout });
}

// A runner starting the process `argv` gives for a Tool Call's content (e.g. the search adapter's ddgr).
export function processRunner(argv: (content: string) => string[], { cwd, timeout }: { cwd: string; timeout: number }): Runner {
  return {
    timeout,
    run: (content, { signal, onOutput }) =>
      new Promise<RunResult>((resolve, reject) => {
        const [file, ...args] = argv(content);
        // Own process group, so a kill reaches pipelines and background children too.
        const child = spawn(file!, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
        let output = '';
        let stopped: Stopped | null = null;
        const collect = (data: Buffer) => {
          output += data.toString();
          onOutput(data.toString());
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const stop = (why: Stopped) => {
          stopped ??= why;
          // The group may be gone already, between exit and close.
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {}
        };
        const kill = () => stop('killed');
        const timer = setTimeout(() => stop('timeout'), timeout * 1000);
        if (signal.aborted) kill();
        else signal.addEventListener('abort', kill, { once: true });
        child.on('error', reject);
        child.on('close', code => {
          clearTimeout(timer);
          signal.removeEventListener('abort', kill);
          resolve({ output, exit: stopped ? null : code, stopped });
        });
      }),
  };
}

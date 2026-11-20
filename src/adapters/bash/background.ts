// Background Processes of one opened Session: bash calls started with `background: true`, their output in a log file,
// running in their own process group until it is empty (bash may exit long before the server it forked) or stopAll.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { BackgroundEnd } from '../../core/log/events';
import type { RunResult } from '../../core/tools/call';

// How often a process group is checked for members (ms).
const POLL = 100;
// SIGTERM, then SIGKILL after this (ms).
const GRACE = 2000;

// signal: what killed the leader; stopped: ended by stopAll.
type Entry = { exit: number | null; signal: string | null; leaderDone: boolean; stopped: boolean; gone: Promise<void> };
export type Background = ReturnType<typeof createBackground>;

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {}
};

const endOf = (e: Entry): BackgroundEnd => (e.stopped ? { signal: 'session ended' } : e.exit !== null ? { exit: e.exit } : { signal: e.signal ?? 'SIGKILL' });

// dir: where the logs go (`<pid>.log`), made at the first start.
export function createBackground({ dir }: { dir: string }) {
  const running = new Map<number, Entry>();
  const listeners = new Set<(pid: number, end: BackgroundEnd) => void>();
  let next = 0;

  // wait: seconds until the result, unless it ends sooner; signal: aborts the wait, killing it.
  function start(command: string, { cwd, wait, signal }: { cwd: string; wait: number; signal: AbortSignal }): Promise<RunResult> {
    mkdirSync(dir, { recursive: true });
    const pending = join(dir, `starting-${process.pid}-${next++}.log`);
    const fd = openSync(pending, 'a');
    // Own process group (setsid): a kill reaches everything it starts; the log file holds the output, no pipes.
    const child = spawn('bash', ['-c', command], { cwd, stdio: ['ignore', fd, fd], detached: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
    closeSync(fd);
    child.unref();
    const pid = child.pid!;
    const log = join(dir, `${pid}.log`);
    renameSync(pending, log);
    const entry: Entry = { exit: null, signal: null, leaderDone: false, stopped: false, gone: Promise.resolve() };
    child.on('exit', (code, signal) => {
      entry.exit = code;
      entry.signal = signal;
      entry.leaderDone = true;
    });
    entry.gone = new Promise(resolve => {
      const timer = setInterval(() => {
        if (!entry.leaderDone || groupAlive(pid)) return;
        clearInterval(timer);
        running.delete(pid);
        listeners.forEach(l => l(pid, endOf(entry)));
        resolve();
      }, POLL);
    });
    running.set(pid, entry);
    const output = () => readFileSync(log, 'utf8');
    return new Promise(resolve => {
      const done = (result: RunResult) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = () => {
        signalGroup(pid, 'SIGKILL');
        void entry.gone.then(() => done({ output: output(), exit: null, stopped: 'killed' }));
      };
      const timer = setTimeout(() => done({ output: output(), exit: null, stopped: null, background: { pid, log } }), wait * 1000);
      void entry.gone.then(() => signal.aborted || done({ output: output(), exit: entry.exit, stopped: null }));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  // SIGTERM to every group, SIGKILL to what is left after the grace period.
  async function stopAll(): Promise<void> {
    const entries = [...running];
    if (!entries.length) return;
    entries.forEach(([pid, e]) => {
      e.stopped = true;
      signalGroup(pid, 'SIGTERM');
    });
    const all = Promise.all(entries.map(([, e]) => e.gone));
    let timer: Timer | undefined;
    const grace = new Promise<'late'>(resolve => (timer = setTimeout(() => resolve('late'), GRACE)));
    if ((await Promise.race([all, grace])) === 'late') entries.forEach(([pid]) => signalGroup(pid, 'SIGKILL'));
    clearTimeout(timer);
    await all;
  }

  return {
    start,
    stopAll,
    // pids of the groups not yet empty.
    running: () => [...running.keys()],
    // Once per Background Process, when its group is empty; also for a run that ended within its wait.
    onExit(listener: (pid: number, end: BackgroundEnd) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

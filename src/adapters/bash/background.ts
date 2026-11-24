// Background Processes of one opened Session: bash calls started with `background: true` and Subagents, their output in a log file,
// running in their own process group until it is empty (bash may exit long before the server it forked), stop or stopAll.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BackgroundEnd } from '../../core/log/events';
import type { RunResult } from '../../core/tools/call';

// How often a process group is checked for members (ms).
const POLL = 100;
// SIGTERM, then SIGKILL after this (ms).
const GRACE = 2000;

// signal: what killed the leader; stopped: who ended it, the user (stop) or the session's end (stopAll).
type Stopper = 'user' | 'session ended';
type Entry = { exit: number | null; signal: string | null; leaderDone: boolean; stopped: Stopper | null; gone: Promise<void> };
export type Background = ReturnType<typeof createBackground>;
// A running Background Process in the Session's record: its group, and when its leader started (the pid-reuse guard).
type Recorded = { pid: number; started: string | null };

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

const endOf = (e: Entry): BackgroundEnd => (e.stopped ? { signal: e.stopped } : e.exit !== null ? { exit: e.exit } : { signal: e.signal ?? 'SIGKILL' });

// When process `pid` started, as `ps` tells it (to the second); null when there is none.
export function startTime(pid: number): string | null {
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return ps.stdout?.trim() || null;
}

// A record as written by a resector that did not stop its Background Processes (crash, SIGKILL): kills the groups it
// lists and drops it. A pid whose process started at another time was reused: not ours, left alone. While a group has
// members its id is not reused, so with the leader gone the kill reaches only ours.
// Returns every pid listed, also of groups already gone: none of them runs any more.
export function reapOrphans(record: string): number[] {
  let listed: Recorded[];
  try {
    listed = JSON.parse(readFileSync(record, 'utf8'));
  } catch {
    listed = [];
  }
  for (const { pid, started } of listed) {
    const now = startTime(pid);
    if (now === null || now === started) signalGroup(pid, 'SIGKILL');
  }
  rmSync(record, { force: true });
  return listed.map(r => r.pid);
}

// dir: where the logs go (`<pid>.log`), made at the first start; record: the file listing what runs, for the next
// start to reap after a crash.
export function createBackground({ dir, record }: { dir: string; record: string }) {
  const running = new Map<number, Entry>();
  const recorded = new Map<number, Recorded>();
  const writeRecord = () => {
    if (!recorded.size) return rmSync(record, { force: true });
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, JSON.stringify([...recorded.values()]));
  };
  const listeners = new Set<(pid: number, end: BackgroundEnd) => void>();
  let next = 0;

  // command: run by bash, or a process's argv; env: added to its environment.
  // wait: seconds until the result, unless it ends sooner; signal: aborts the wait, killing it.
  function start(command: string | string[], { cwd, wait, signal, env }: { cwd: string; wait: number; signal: AbortSignal; env?: Record<string, string> }): Promise<RunResult> {
    const [file, ...args] = typeof command === 'string' ? ['bash', '-c', command] : command;
    mkdirSync(dir, { recursive: true });
    const pending = join(dir, `starting-${process.pid}-${next++}.log`);
    const fd = openSync(pending, 'a');
    // Own process group (setsid): a kill reaches everything it starts; the log file holds the output, no pipes.
    const child = spawn(file!, args, { cwd, stdio: ['ignore', fd, fd], detached: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env } });
    closeSync(fd);
    child.unref();
    const pid = child.pid!;
    const log = join(dir, `${pid}.log`);
    renameSync(pending, log);
    const entry: Entry = { exit: null, signal: null, leaderDone: false, stopped: null, gone: Promise.resolve() };
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
        recorded.delete(pid);
        writeRecord();
        listeners.forEach(l => l(pid, endOf(entry)));
        resolve();
      }, POLL);
    });
    running.set(pid, entry);
    recorded.set(pid, { pid, started: startTime(pid) });
    writeRecord();
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

  // SIGTERM to every group, SIGKILL to what is left after the grace period. Who stopped one first stays its ending.
  async function end(entries: [number, Entry][], by: Stopper): Promise<void> {
    if (!entries.length) return;
    entries.forEach(([pid, e]) => {
      e.stopped ??= by;
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
    // The user stops one; nothing when none runs under `pid`.
    stop: (pid: number) => end([...running].filter(([p]) => p === pid), 'user'),
    stopAll: () => end([...running], 'session ended'),
    // pids of the groups not yet empty.
    running: () => [...running.keys()],
    // A log as written so far; null when it is gone (the Session deleted).
    log(path: string): string | null {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    // Once per Background Process, when its group is empty; also for a run that ended within its wait.
    onExit(listener: (pid: number, end: BackgroundEnd) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

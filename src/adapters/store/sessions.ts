// Session store (FR-32–FR-36): the project's Session Logs in one directory, `<id>.jsonl` plus `<id>.lock`
// holding the pid of the process that has the session open.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEvent, SessionLog } from '../../core/log/events';
import { summarize, type SessionSummary } from '../../core/session/summary';
import { createSessionLog } from './session-log';

export type StoredSession = SessionSummary & { id: string; updated: Date; locked: boolean; events: SessionEvent[] };
export type OpenSession = { id: string; events: SessionEvent[]; log: SessionLog & { path: string }; release: () => void };
export type SessionStore = ReturnType<typeof openSessionStore>;

const newId = () => `ses_${Date.now().toString(36)}`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function openSessionStore(dir: string, { id = newId } = {}) {
  const logPath = (id: string) => join(dir, `${id}.jsonl`);
  const lockPath = (id: string) => join(dir, `${id}.lock`);
  const read = (id: string): SessionEvent[] =>
    readFileSync(logPath(id), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

  // Locked = held by another live process; a lock of a dead process is stale.
  function lockedByOther(id: string): boolean {
    if (!existsSync(lockPath(id))) return false;
    const pid = Number(readFileSync(lockPath(id), 'utf8'));
    return pid !== process.pid && alive(pid);
  }
  function refuseLocked(id: string) {
    if (lockedByOther(id)) throw new Error(`session ${id} is open in another resector instance`);
  }
  function lock(id: string): OpenSession {
    refuseLocked(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockPath(id), String(process.pid));
    const events = existsSync(logPath(id)) ? read(id) : [];
    return { id, events, log: createSessionLog(dir, id), release: () => rmSync(lockPath(id), { force: true }) };
  }

  const exists = (id: string) => {
    if (!existsSync(logPath(id))) throw new Error(`no session ${id}`);
  };
  // The session to resume or export: true = the newest one (FR-32).
  function pick(id: true | string): string {
    if (id !== true) return id;
    const newest = store.list()[0];
    if (!newest) throw new Error('no session in this project');
    return newest.id;
  }

  const store = {
    list(): StoredSession[] {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const id = f.slice(0, -'.jsonl'.length);
          const events = read(id);
          return { id, ...summarize(events), updated: statSync(logPath(id)).mtime, locked: lockedByOther(id), events };
        })
        .sort((a, b) => b.updated.getTime() - a.updated.getTime());
    },
    create: () => lock(id()),
    open(which: true | string): OpenSession {
      const id = pick(which);
      exists(id);
      return lock(id);
    },
    exportLog(which: true | string): string {
      const id = pick(which);
      exists(id);
      return readFileSync(logPath(id), 'utf8');
    },
    // For a session not open here, e.g. a rename in /sessions.
    append(id: string, event: SessionEvent) {
      refuseLocked(id);
      appendFileSync(logPath(id), JSON.stringify(event) + '\n');
    },
    delete(id: string) {
      refuseLocked(id);
      rmSync(logPath(id), { force: true });
      rmSync(lockPath(id), { force: true });
    },
  };
  return store;
}

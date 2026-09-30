// Session store: the project's Session Logs in one directory, `<id>.jsonl` plus `<id>.lock`
// holding the pid of the process that has the session open.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeLog, encodeEvent } from '../../core/log/codec';
import type { SessionEvent, SessionLog } from '../../core/log/events';
import { summarize, type SessionRef, type SessionSummary } from '../../core/session/session';
import { createSessionLog, projectSessionsDir } from './session-log';

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
  const read = (id: string): SessionEvent[] => decodeLog(readFileSync(logPath(id), 'utf8'));

  // Locked = held by another live process; a lock of a dead process is stale.
  function lockedByOther(id: string): boolean {
    if (!existsSync(lockPath(id))) return false;
    const pid = Number(readFileSync(lockPath(id), 'utf8'));
    return pid !== process.pid && alive(pid);
  }
  function refuseLocked(id: string) {
    if (lockedByOther(id)) throw new Error(`session ${id} is open in another resector instance`);
  }
  // Created exclusively, so two instances starting at once cannot both hold it; a stale lock is replaced.
  function takeLock(id: string) {
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(lockPath(id), String(process.pid), { flag: 'wx' });
    } catch {
      refuseLocked(id);
      rmSync(lockPath(id), { force: true });
      writeFileSync(lockPath(id), String(process.pid), { flag: 'wx' });
    }
  }
  function lock(id: string): OpenSession {
    takeLock(id);
    // Ctrl+C exits without the UI's quit: the lock goes with the process.
    const release = () => {
      process.off('exit', release);
      rmSync(lockPath(id), { force: true });
    };
    process.on('exit', release);
    const events = existsSync(logPath(id)) ? read(id) : [];
    return { id, events, log: createSessionLog(dir, id), release };
  }

  // The id of an existing session.
  function resolve(ref: SessionRef): string {
    const id = ref === true ? store.list()[0]?.id : ref;
    if (!id) throw new Error('no session in this project');
    if (!existsSync(logPath(id))) throw new Error(`no session ${id}`);
    return id;
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
    open: (ref: SessionRef): OpenSession => lock(resolve(ref)),
    read: (id: string) => read(resolve(id)),
    exportLog: (ref: SessionRef): string => readFileSync(logPath(resolve(ref)), 'utf8'),
    // For a session not open here, e.g. a rename in /sessions.
    append(id: string, event: SessionEvent) {
      refuseLocked(id);
      appendFileSync(logPath(id), encodeEvent(event));
    },
    delete(id: string) {
      refuseLocked(id);
      rmSync(logPath(id), { force: true });
      rmSync(lockPath(id), { force: true });
    },
  };
  return store;
}

export const projectSessionStore = (home: string, projectRoot: string) => openSessionStore(projectSessionsDir(home, projectRoot));

import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession } from '../../core/session/summary';
import { openSessionStore } from './sessions';

const dir = () => mkdtempSync(join(tmpdir(), 'resector-sessions-'));
const sleeper = Bun.spawn(['sleep', '30']);
afterAll(() => sleeper.kill());

function stored(root: string, id: string, minutesAgo: number, title = id) {
  const path = join(root, `${id}.jsonl`);
  const events = [...newSession('qwen', 'sys'), { type: 'BlockAdded', id: 2, kind: 'User', origin: 'user', content: title }];
  writeFileSync(path, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const t = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(path, t, t);
}

test('sessions are listed newest first with their summary and lock state (FR-33)', () => {
  const root = dir();
  stored(root, 'ses_old', 60);
  stored(root, 'ses_new', 1);
  writeFileSync(join(root, 'ses_old.lock'), String(sleeper.pid));
  const list = openSessionStore(root).list();
  expect(list.map(s => [s.id, s.title, s.locked])).toEqual([
    ['ses_new', 'ses_new', false],
    ['ses_old', 'ses_old', true],
  ]);
  expect(list[0]!.updated.getTime()).toBeGreaterThan(list[1]!.updated.getTime());
  expect(list[0]!.events).toHaveLength(3);
});

test('a missing sessions directory lists nothing', () => {
  expect(openSessionStore(join(dir(), 'none')).list()).toEqual([]);
});

test('a created session is locked by this process and appends its events', () => {
  const root = join(dir(), 'new');
  const session = openSessionStore(root, { id: () => 'ses_a' }).create();
  newSession('qwen', 'sys').forEach(session.log.append);
  expect(session.id).toBe('ses_a');
  expect(readFileSync(join(root, 'ses_a.lock'), 'utf8')).toBe(String(process.pid));
  expect(openSessionStore(root).list().map(s => [s.id, s.locked, s.events.length])).toEqual([['ses_a', false, 2]]);
  session.release();
  expect(existsSync(join(root, 'ses_a.lock'))).toBe(false);
});

test('opening a session replays its events; one locked by another live process is refused (FR-36)', () => {
  const root = dir();
  stored(root, 'ses_a', 1, 'hello');
  const store = openSessionStore(root);
  const session = store.open('ses_a');
  expect(session.events.at(-1)).toMatchObject({ content: 'hello' });
  session.release();
  writeFileSync(join(root, 'ses_a.lock'), String(sleeper.pid));
  expect(() => store.open('ses_a')).toThrow('session ses_a is open in another resector instance');
  expect(() => store.delete('ses_a')).toThrow('session ses_a is open in another resector instance');
  expect(() => store.append('ses_a', { type: 'SessionRenamed', title: 'x' })).toThrow('session ses_a is open in another resector instance');
});

test('a stale lock of a dead process is taken over', async () => {
  const root = dir();
  stored(root, 'ses_a', 1);
  const dead = Bun.spawn(['true']);
  await dead.exited;
  writeFileSync(join(root, 'ses_a.lock'), String(dead.pid));
  expect(openSessionStore(root).list()[0]!.locked).toBe(false);
  openSessionStore(root).open('ses_a');
  expect(readFileSync(join(root, 'ses_a.lock'), 'utf8')).toBe(String(process.pid));
});

test('an unknown session cannot be opened', () => {
  expect(() => openSessionStore(dir()).open('ses_x')).toThrow('no session ses_x');
});

test('delete removes the session file and its lock; append writes to an unlocked session', () => {
  const root = dir();
  stored(root, 'ses_a', 1);
  stored(root, 'ses_b', 2);
  const store = openSessionStore(root);
  store.append('ses_b', { type: 'SessionRenamed', title: 'renamed' });
  expect(store.list().find(s => s.id === 'ses_b')!.title).toBe('renamed');
  store.open('ses_a');
  store.delete('ses_a');
  expect(existsSync(join(root, 'ses_a.jsonl'))).toBe(false);
  expect(existsSync(join(root, 'ses_a.lock'))).toBe(false);
  expect(store.list().map(s => s.id)).toEqual(['ses_b']);
});

test('a fixture export is the Session Log of the last or a given session', () => {
  const root = dir();
  stored(root, 'ses_old', 60, 'old');
  stored(root, 'ses_new', 1, 'new');
  const store = openSessionStore(root);
  expect(store.exportLog(true)).toBe(readFileSync(join(root, 'ses_new.jsonl'), 'utf8'));
  expect(store.exportLog('ses_old')).toContain('"content":"old"');
  expect(() => store.exportLog('ses_x')).toThrow('no session ses_x');
  expect(() => openSessionStore(dir()).exportLog(true)).toThrow('no session in this project');
});

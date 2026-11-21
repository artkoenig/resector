import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackground, reapOrphans, startTime } from './background';

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'resector-bg-')));
const dir = join(cwd, 'logs');
const registries: ReturnType<typeof createBackground>[] = [];
const record = join(cwd, 'ses.background');
const registry = () => {
  const r = createBackground({ dir, record });
  registries.push(r);
  return r;
};
const start = (command: string, { wait = 0.3, signal = new AbortController().signal } = {}) => registry().start(command, { cwd, wait, signal });
const alive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
afterEach(async () => {
  await Promise.all(registries.splice(0).map(r => r.stopAll()));
});

test('a command still running after the wait keeps running: its output so far, pid and log file', async () => {
  const started = Date.now();
  const result = await start('echo ready; sleep 30', { wait: 0.3 });
  expect(Date.now() - started).toBeLessThan(1500);
  const pid = result.background!.pid;
  expect(result).toEqual({ output: 'ready\n', exit: null, stopped: null, background: { pid, log: join(dir, `${pid}.log`) } });
  expect(alive(pid)).toBe(true);
  expect(readFileSync(result.background!.log, 'utf8')).toBe('ready\n');
});

test('a command ending within the wait is an ordinary result, its log kept', async () => {
  const started = Date.now();
  const result = await start('pwd; echo err >&2; exit 3', { wait: 5 });
  expect(Date.now() - started).toBeLessThan(1500);
  expect(result).toEqual({ output: `${cwd}\nerr\n`, exit: 3, stopped: null });
});

test('aborting during the wait kills it', async () => {
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 100);
  const result = await start('echo partial; sleep 30', { wait: 5, signal: abort.signal });
  expect(result).toEqual({ output: 'partial\n', exit: null, stopped: 'killed' });
});

test('it has exited only when its process group is empty, not when bash exits', async () => {
  const r = registry();
  const exits: [number, unknown][] = [];
  r.onExit((pid, end) => exits.push([pid, end]));
  // bash ends at once; the server it forked keeps the group.
  const result = await r.start('(sleep 0.6; echo served) & exit 0', { cwd, wait: 0.2, signal: new AbortController().signal });
  const pid = result.background!.pid;
  await Bun.sleep(200);
  expect(exits).toEqual([]);
  expect(r.running()).toEqual([pid]);
  while (!exits.length) await Bun.sleep(20);
  expect(exits).toEqual([[pid, { exit: 0 }]]);
  expect(r.running()).toEqual([]);
  expect(readFileSync(result.background!.log, 'utf8')).toBe('served\n');
});

test('a Background Process killed by a signal ends with its name', async () => {
  const r = registry();
  const ends: unknown[] = [];
  r.onExit((_, end) => ends.push(end));
  const pid = (await r.start('sleep 30', { cwd, wait: 0.1, signal: new AbortController().signal })).background!.pid;
  process.kill(-pid, 'SIGTERM');
  while (!ends.length) await Bun.sleep(20);
  expect(ends).toEqual([{ signal: 'SIGTERM' }]);
});

test('stopAll ends every Background Process with SIGTERM, SIGKILL for those ignoring it', async () => {
  const r = registry();
  const signal = new AbortController().signal;
  const polite = (await r.start('sleep 30', { cwd, wait: 0.1, signal })).background!.pid;
  const stubborn = (await r.start("trap '' TERM; echo trapped; while :; do sleep 0.05; done", { cwd, wait: 0.2, signal })).background!.pid;
  const ends: unknown[] = [];
  r.onExit((_, end) => ends.push(end));
  const started = Date.now();
  await r.stopAll();
  expect(ends).toEqual([{ signal: 'session ended' }, { signal: 'session ended' }]);
  expect(Date.now() - started).toBeGreaterThan(1500);
  expect(Date.now() - started).toBeLessThan(4000);
  expect([alive(polite), alive(stubborn)]).toEqual([false, false]);
  expect(r.running()).toEqual([]);
});

test('stopAll with nothing running returns at once; the log dir is made only when needed', async () => {
  const other = join(cwd, 'none');
  const started = Date.now();
  await createBackground({ dir: other, record }).stopAll();
  expect(Date.now() - started).toBeLessThan(100);
  expect(existsSync(other)).toBe(false);
});

test('log reads a log as written so far; null once it is gone', async () => {
  const r = registry();
  const result = await r.start('echo one; sleep 0.4; echo two; sleep 5', { cwd, wait: 0.2, signal: new AbortController().signal });
  const log = result.background!.log;
  expect(r.log(log)).toBe('one\n');
  await Bun.sleep(400);
  expect(r.log(log)).toBe('one\ntwo\n');
  expect(r.log(join(dir, 'gone.log'))).toBeNull();
});

test('stop ends one Background Process as the user’s doing: SIGTERM, SIGKILL when it ignores that; the others keep running', async () => {
  const r = registry();
  const signal = new AbortController().signal;
  const other = (await r.start('sleep 30', { cwd, wait: 0.1, signal })).background!.pid;
  const polite = (await r.start('sleep 30', { cwd, wait: 0.1, signal })).background!.pid;
  const stubborn = (await r.start("trap '' TERM; echo trapped; while :; do sleep 0.05; done", { cwd, wait: 0.2, signal })).background!.pid;
  const ends: [number, unknown][] = [];
  r.onExit((pid, end) => ends.push([pid, end]));
  const started = Date.now();
  await r.stop(polite);
  expect(Date.now() - started).toBeLessThan(1000);
  await r.stop(stubborn);
  expect(Date.now() - started).toBeGreaterThan(1500);
  expect(ends).toEqual([[polite, { signal: 'user' }], [stubborn, { signal: 'user' }]]);
  expect([alive(polite), alive(stubborn), alive(other)]).toEqual([false, false, true]);
  expect(r.running()).toEqual([other]);
  // Nothing runs under that pid any more.
  await r.stop(polite);
});

test('a Background Process the user stopped stays the user’s when the session ends within the grace period', async () => {
  const r = registry();
  const pid = (await r.start("trap '' TERM; while :; do sleep 0.05; done", { cwd, wait: 0.2, signal: new AbortController().signal })).background!.pid;
  const ends: unknown[] = [];
  r.onExit((_, end) => ends.push(end));
  void r.stop(pid);
  await r.stopAll();
  expect(ends).toEqual([{ signal: 'user' }]);
});

test('the record lists the running Background Processes; it is gone when none runs', async () => {
  const r = registry();
  const signal = new AbortController().signal;
  const one = (await r.start('sleep 30', { cwd, wait: 0.1, signal })).background!.pid;
  const two = (await r.start('sleep 30', { cwd, wait: 0.1, signal })).background!.pid;
  expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual([{ pid: one, started: startTime(one) }, { pid: two, started: startTime(two) }]);
  expect(startTime(one)).toBeString();
  process.kill(-one, 'SIGKILL');
  while (r.running().length > 1) await Bun.sleep(20);
  expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual([{ pid: two, started: startTime(two) }]);
  await r.stopAll();
  expect(existsSync(record)).toBe(false);
});

// A process group as a crashed resector left it.
const orphan = () => {
  const child = spawn('bash', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid!;
};
const gone = async (pid: number) => {
  while (alive(pid)) await Bun.sleep(20);
};

test('reaping kills the groups a record lists and drops the record', async () => {
  const pid = orphan();
  writeFileSync(record, JSON.stringify([{ pid, started: startTime(pid) }]));
  expect(reapOrphans(record)).toEqual([pid]);
  await gone(pid);
  expect(existsSync(record)).toBe(false);
});

test('reaping reports a group already gone', async () => {
  const pid = orphan();
  const started = startTime(pid);
  process.kill(-pid, 'SIGKILL');
  await gone(pid);
  writeFileSync(record, JSON.stringify([{ pid, started }]));
  expect(reapOrphans(record)).toEqual([pid]);
});

test('reaping leaves a process alone that reuses the pid, and still reports the record', async () => {
  const pid = orphan();
  try {
    writeFileSync(record, JSON.stringify([{ pid, started: 'Mon Jan  1 00:00:00 2024' }]));
    expect(reapOrphans(record)).toEqual([pid]);
    await Bun.sleep(100);
    expect(alive(pid)).toBe(true);
    expect(existsSync(record)).toBe(false);
  } finally {
    process.kill(-pid, 'SIGKILL');
  }
});

test('reaping the members left of a group whose leader is gone', async () => {
  const child = spawn('bash', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' });
  const pid = child.pid!;
  const started = startTime(pid);
  await new Promise(resolve => child.on('exit', resolve));
  expect(alive(pid)).toBe(true);
  writeFileSync(record, JSON.stringify([{ pid, started }]));
  expect(reapOrphans(record)).toEqual([pid]);
  await gone(pid);
});

test('reaping without a record does nothing', () => {
  expect(reapOrphans(join(cwd, 'none.background'))).toEqual([]);
});

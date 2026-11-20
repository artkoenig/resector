import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackground } from './background';

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'resector-bg-')));
const dir = join(cwd, 'logs');
const registries: ReturnType<typeof createBackground>[] = [];
const registry = () => {
  const r = createBackground({ dir });
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
  const exits: [number, number | null][] = [];
  r.onExit((pid, exit) => exits.push([pid, exit]));
  // bash ends at once; the server it forked keeps the group.
  const result = await r.start('(sleep 0.6; echo served) & exit 0', { cwd, wait: 0.2, signal: new AbortController().signal });
  const pid = result.background!.pid;
  await Bun.sleep(200);
  expect(exits).toEqual([]);
  expect(r.running()).toEqual([pid]);
  while (!exits.length) await Bun.sleep(20);
  expect(exits).toEqual([[pid, 0]]);
  expect(r.running()).toEqual([]);
  expect(readFileSync(result.background!.log, 'utf8')).toBe('served\n');
});

test('stopAll ends every Background Process with SIGTERM, SIGKILL for those ignoring it', async () => {
  const r = registry();
  const signal = new AbortController().signal;
  const polite = (await r.start('sleep 30', { cwd, wait: 0.1, signal })).background!.pid;
  const stubborn = (await r.start("trap '' TERM; echo trapped; while :; do sleep 0.05; done", { cwd, wait: 0.2, signal })).background!.pid;
  const started = Date.now();
  await r.stopAll();
  expect(Date.now() - started).toBeGreaterThan(1500);
  expect(Date.now() - started).toBeLessThan(4000);
  expect([alive(polite), alive(stubborn)]).toEqual([false, false]);
  expect(r.running()).toEqual([]);
});

test('stopAll with nothing running returns at once; the log dir is made only when needed', async () => {
  const other = join(cwd, 'none');
  const started = Date.now();
  await createBackground({ dir: other }).stopAll();
  expect(Date.now() - started).toBeLessThan(100);
  expect(existsSync(other)).toBe(false);
});

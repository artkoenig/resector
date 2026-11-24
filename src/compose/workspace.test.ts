// Opening sessions without a view: what is logged, the policy they start with, where they run.
import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { startTime } from '../adapters/bash/background';
import { configPaths } from '../adapters/fs/config';
import { projectSessionsDir } from '../adapters/store/session-log';
import { openSessionStore } from '../adapters/store/sessions';
import type { SessionEvent } from '../core/log/events';
import { newSession } from '../core/session/session';
import { openWorkspace, type OpenWith } from './workspace';

let fake: ReturnType<typeof startFakeLlamaCpp>;
const released: (() => void)[] = [];
afterEach(() => {
  released.splice(0).forEach(r => r());
  fake.stop();
});

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const config = (url: string, extra = '') => `{
  "profiles": { "local": { "backend": "llamacpp", "endpoint": "${url}", "window": 2048 } },
  "defaultProfile": "local" ${extra}
}`;

// A workspace on a fresh project and config. sessions: logs already written; files: other files of the session store;
// git: a repository with one commit.
type Setup = { extra?: string; sessions?: Record<string, SessionEvent[]>; files?: Record<string, string>; git?: boolean };
async function workspace({ extra = '', sessions = {}, files = {}, git = false }: Setup = {}) {
  fake = startFakeLlamaCpp({ nCtx: 4096, model: 'qwen3-8b.gguf' });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resector-compose-')));
  const project = join(root, 'project');
  mkdirSync(project);
  if (git) {
    put(join(project, 'a.txt'), 'a\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']]) Bun.spawnSync(['git', ...args], { cwd: project });
  }
  const paths = configPaths({ home: join(root, 'home'), cwd: project, env: {} });
  put(paths.global, config(fake.url, extra));
  const sessionsDir = projectSessionsDir(paths);
  for (const [id, events] of Object.entries(sessions)) put(join(sessionsDir, `${id}.jsonl`), events.map(e => JSON.stringify(e) + '\n').join(''));
  for (const [name, text] of Object.entries(files)) put(join(sessionsDir, name), text);
  const store = openSessionStore(sessionsDir, { id: () => 'ses_new' });
  const ws = await openWorkspace({ paths, store, cwd: project, openFile: async () => {}, onReopen: () => {} });
  const open = async (how?: OpenWith) => {
    const opened = await ws.open(ws.config()!, how);
    released.push(opened.release);
    return opened;
  };
  const log = (id: string) => readFileSync(join(sessionsDir, `${id}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l) as SessionEvent);
  return { ws, open, log, project, paths, sessionsDir };
}

test('a new session is logged and starts with the default policy on', async () => {
  const { ws, open, log } = await workspace();
  const { id, options } = await open();
  expect(id).toBe('ses_new');
  expect(log(id)[0]).toMatchObject({ type: 'SessionCreated', profile: 'local' });
  expect(ws.policies.active()?.name).toBe('summary-reset');
  expect(options.notice).toEqual({ text: 'new session', tone: 'ok' });
});

test('a new session with an unknown defaultPolicy starts without one and says why', async () => {
  const { ws, open } = await workspace({ extra: ', "defaultPolicy": "nope"' });
  const { options } = await open();
  expect(ws.policies.active()).toBeNull();
  expect(options.notice).toEqual({ text: 'new session · defaultPolicy nope – no such policy', tone: 'warn' });
});

test('a new session starts with what it is opened with: profile, policy, thinking, tools, worktree, Auto-approve', async () => {
  const { ws, open, log, paths } = await workspace({ git: true });
  const { id, options } = await open({ start: { profile: 'local', policy: 'off', thinking: 'high', tools: ['bash'], worktree: true, autoApprove: true } });
  const events = log(id);
  expect(events[0]).toMatchObject({ type: 'SessionCreated', profile: 'local' });
  expect(events.find(e => e.type === 'BlockAdded' && e.kind === 'Tools')).toMatchObject({ content: expect.not.stringContaining('question') });
  expect(events.filter(e => e.type === 'ThinkingSet' || e.type === 'WorktreeSet')).toEqual([{ type: 'ThinkingSet', thinking: 'high' }, { type: 'WorktreeSet', on: true }]);
  expect([ws.policies.active(), options.autoApprove!.on()]).toEqual([null, true]);
  expect(options.approval.root).toBe(join(paths.projectHome.data, 'worktrees', id));
});

test('Auto-approve starts as configured, on by default; switched since, it stays when another session is opened', async () => {
  const { open } = await workspace();
  const { options } = await open();
  expect(options.autoApprove!.on()).toBe(true);
  options.autoApprove!.set(false);
  expect((await open()).options.autoApprove!.on()).toBe(false);
  const off = await workspace({ extra: ', "autoApprove": false' });
  expect((await off.open()).options.autoApprove!.on()).toBe(false);
});

const chat = (profile: string, checkout?: string): SessionEvent[] => [
  ...newSession(profile, 'You are terse.', checkout ? { checkout } : undefined),
  { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'hi there' },
];

test('a resumed session whose profile is gone falls back to the default one', async () => {
  const { open, log } = await workspace({ sessions: { ses_old: chat('gone') } });
  const { id, options } = await open({ which: 'ses_old' });
  expect(id).toBe('ses_old');
  expect(log(id).at(-1)).toEqual({ type: 'ProfileFallback', profile: 'local' });
  expect(options.notice).toEqual({ text: 'resumed "hi there" · profile "gone" not in config → local', tone: 'warn' });
});

test('a session in its worktree runs there', async () => {
  const { open, paths } = await workspace({ git: true, sessions: { ses_old: [...chat('local'), { type: 'WorktreeSet', on: true }] } });
  const { options } = await open({ which: 'ses_old' });
  expect(options.approval.root).toBe(join(paths.projectHome.data, 'worktrees', 'ses_old'));
});

test('a session whose checkout is gone runs in the current one and says so', async () => {
  const { open, project } = await workspace({ sessions: { ses_old: chat('local', '/nowhere/gone') } });
  const { options } = await open({ which: 'ses_old' });
  expect(options.approval.root).toBe(project);
  expect(options.notice?.text).toContain('checkout /nowhere/gone gone – runs in');
});

test('releasing a session logs its Background Processes as ended with it, also with no Gate listening', async () => {
  const { open, log } = await workspace({ extra: ', "bash": { "backgroundWait": 0.2 }' });
  const { id, options, release } = await open();
  const result = await options.runner.run('sleep 30', { signal: new AbortController().signal, onOutput: () => {}, background: true });
  options.log.append({ type: 'BackgroundStarted', call: 9, ...result.background! });
  await release();
  expect(log(id).at(-1)).toEqual({ type: 'BackgroundExited', call: 9, signal: 'session ended' });
});

// A process group as a crashed resector left it, with its record.
function orphan() {
  const child = spawn('bash', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid!;
  return { pid, record: JSON.stringify([{ pid, started: startTime(pid) }]), kill: () => process.kill(-pid, 'SIGKILL') };
}
const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
const started = (pid: number): SessionEvent[] => [...chat('local'), { type: 'BackgroundStarted', call: 9, pid, log: '/logs/x.log' }];

test('at start, a Background Process left by a crashed resector is killed and logged as orphaned', async () => {
  const left = orphan();
  const { log, sessionsDir } = await workspace({ sessions: { ses_old: started(left.pid) }, files: { 'ses_old.background': left.record } });
  while (groupAlive(left.pid)) await Bun.sleep(20);
  expect(log('ses_old').at(-1)).toEqual({ type: 'BackgroundExited', call: 9, signal: 'orphaned' });
  expect(existsSync(join(sessionsDir, 'ses_old.background'))).toBe(false);
});

test('at start, a recorded Background Process already gone is logged as orphaned too', async () => {
  const dead = Bun.spawnSync(['true']).pid;
  const { log } = await workspace({ sessions: { ses_old: started(dead) }, files: { 'ses_old.background': JSON.stringify([{ pid: dead, started: 'then' }]) } });
  expect(log('ses_old').at(-1)).toEqual({ type: 'BackgroundExited', call: 9, signal: 'orphaned' });
});

test('the report of a Subagent left by a crashed resector is logged with its end', async () => {
  const dead = Bun.spawnSync(['true']).pid;
  const report = { session: 'ses_sub', turns: 2, tokens: 500 };
  const files = { 'ses_old.background': JSON.stringify([{ pid: dead, started: 'then' }]), [`../background/ses_old/${dead}.report.json`]: JSON.stringify(report) };
  const { log } = await workspace({ sessions: { ses_old: started(dead) }, files });
  expect(log('ses_old').at(-1)).toEqual({ type: 'BackgroundExited', call: 9, signal: 'orphaned', report });
});

test('at start, the Background Processes of a session open in another instance are left running', async () => {
  const left = orphan();
  try {
    const files = { 'ses_old.background': left.record, 'ses_old.lock': String(process.ppid) };
    const { log, sessionsDir } = await workspace({ sessions: { ses_old: started(left.pid) }, files });
    await Bun.sleep(100);
    expect(groupAlive(left.pid)).toBe(true);
    expect(log('ses_old').at(-1)).toMatchObject({ type: 'BackgroundStarted' });
    expect(existsSync(join(sessionsDir, 'ses_old.background'))).toBe(true);
  } finally {
    left.kill();
  }
});

test('deleting a session kills the Background Processes it still has, and removes its record and logs', async () => {
  const { ws, paths, sessionsDir } = await workspace({ sessions: { ses_old: chat('local') } });
  const left = orphan();
  const logs = join(paths.projectHome.data, 'background', 'ses_old');
  put(join(logs, `${left.pid}.log`), 'up\n');
  put(join(sessionsDir, 'ses_old.background'), left.record);
  ws.deleteSession('ses_old');
  while (groupAlive(left.pid)) await Bun.sleep(20);
  expect([existsSync(join(sessionsDir, 'ses_old.jsonl')), existsSync(join(sessionsDir, 'ses_old.background')), existsSync(logs)]).toEqual([false, false, false]);
});

test('a session open in another instance is not deleted, its Background Processes keep running', async () => {
  const left = orphan();
  try {
    const files = { 'ses_old.background': left.record, 'ses_old.lock': String(process.ppid) };
    const { ws } = await workspace({ sessions: { ses_old: started(left.pid) }, files });
    expect(() => ws.deleteSession('ses_old')).toThrow('open in another resector instance');
    await Bun.sleep(100);
    expect(groupAlive(left.pid)).toBe(true);
  } finally {
    left.kill();
  }
});

test('a running Background Process is in its session\'s record until the session is released', async () => {
  const { open, sessionsDir } = await workspace({ extra: ', "bash": { "backgroundWait": 0.2 }' });
  const { id, options, release } = await open();
  const result = await options.runner.run('sleep 30', { signal: new AbortController().signal, onOutput: () => {}, background: true });
  expect(JSON.parse(readFileSync(join(sessionsDir, `${id}.background`), 'utf8'))).toMatchObject([{ pid: result.background!.pid }]);
  await release();
  expect(existsSync(join(sessionsDir, `${id}.background`))).toBe(false);
});

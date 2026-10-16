// Opening sessions without a view: what is logged, the policy they start with, where they run.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { configPaths } from '../adapters/fs/config';
import { projectSessionsDir } from '../adapters/store/session-log';
import { openSessionStore } from '../adapters/store/sessions';
import type { SessionEvent } from '../core/log/events';
import { newSession } from '../core/session/session';
import { openWorkspace } from './workspace';

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

// A workspace on a fresh project and config. sessions: logs already written; git: a repository with one commit.
async function workspace({ extra = '', sessions = {}, git = false }: { extra?: string; sessions?: Record<string, SessionEvent[]>; git?: boolean } = {}) {
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
  const store = openSessionStore(sessionsDir, { id: () => 'ses_new' });
  const ws = await openWorkspace({ paths, store, cwd: project, openFile: async () => {}, onReopen: () => {} });
  const open = async (...args: Parameters<typeof ws.open> extends [unknown, ...infer R] ? R : never) => {
    const opened = await ws.open(ws.config()!, ...args);
    released.push(opened.release);
    return opened;
  };
  const log = (id: string) => readFileSync(join(sessionsDir, `${id}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l) as SessionEvent);
  return { ws, open, log, project, paths };
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
  const { id, options } = await open(undefined, false, { profile: 'local', policy: 'off', thinking: 'high', tools: ['bash'], worktree: true, autoApprove: true });
  const events = log(id);
  expect(events[0]).toMatchObject({ type: 'SessionCreated', profile: 'local' });
  expect(events.find(e => e.type === 'BlockAdded' && e.kind === 'Tools')).toMatchObject({ content: expect.not.stringContaining('question') });
  expect(events.filter(e => e.type === 'ThinkingSet' || e.type === 'WorktreeSet')).toEqual([{ type: 'ThinkingSet', thinking: 'high' }, { type: 'WorktreeSet', on: true }]);
  expect([ws.policies.active(), options.autoApprove!.on()]).toEqual([null, true]);
  expect(options.approval.root).toBe(join(paths.projectHome.data, 'worktrees', id));
});

const chat = (profile: string, checkout?: string): SessionEvent[] => [
  ...newSession(profile, 'You are terse.', checkout ? { checkout } : undefined),
  { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'hi there' },
];

test('a resumed session whose profile is gone falls back to the default one', async () => {
  const { open, log } = await workspace({ sessions: { ses_old: chat('gone') } });
  const { id, options } = await open('ses_old');
  expect(id).toBe('ses_old');
  expect(log(id).at(-1)).toEqual({ type: 'ProfileFallback', profile: 'local' });
  expect(options.notice).toEqual({ text: 'resumed "hi there" · profile "gone" not in config → local', tone: 'warn' });
});

test('a session in its worktree runs there', async () => {
  const { open, paths } = await workspace({ git: true, sessions: { ses_old: [...chat('local'), { type: 'WorktreeSet', on: true }] } });
  const { options } = await open('ses_old');
  expect(options.approval.root).toBe(join(paths.projectHome.data, 'worktrees', 'ses_old'));
});

test('a session whose checkout is gone runs in the current one and says so', async () => {
  const { open, project } = await workspace({ sessions: { ses_old: chat('local', '/nowhere/gone') } });
  const { options } = await open('ses_old');
  expect(options.approval.root).toBe(project);
  expect(options.notice?.text).toContain('checkout /nowhere/gone gone – runs in');
});

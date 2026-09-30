// Launch test harness: starts the app from config files, sessions and project files against a fake llama.cpp server.
import { afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testRender } from '@opentui/solid';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import type { LocalServer } from '../adapters/backend/discover';
import { configPaths } from '../adapters/fs/config';
import { personalInstructionsDir } from '../adapters/fs/project';
import { openSessionStore } from '../adapters/store/sessions';
import type { SessionEvent } from '../core/log/events';
import { newSession } from '../core/session/session';
import { Launch } from './launch';

export let fake: ReturnType<typeof startFakeLlamaCpp>;
export let ui: Awaited<ReturnType<typeof testRender>>;

// Called once per test file: the UI and the fake server torn down after each test.
export function useHarness() {
  afterEach(() => {
    ui.renderer.destroy();
    fake.stop();
  });
}

export function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// policies: Context Policy modules by name, in policies/ next to the global config.
export type Setup = { config?: (url: string) => string; systemMd?: string; compactionMd?: string; policies?: Record<string, string>; servers?: (url: string) => LocalServer[]; sessions?: Record<string, SessionEvent[]>; locks?: Record<string, number>; resume?: true | string; files?: Record<string, string>; personal?: Record<string, string>; git?: true };

export async function launch({ config, systemMd, compactionMd, policies = {}, servers, sessions = {}, locks = {}, resume, files = {}, personal = {}, git }: Setup = {}) {
  fake = startFakeLlamaCpp({ nCtx: 4096, model: 'qwen3-8b.gguf' });
  const root = mkdtempSync(join(tmpdir(), 'resector-launch-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  for (const [name, text] of Object.entries(files)) put(join(project, name), text);
  // git: the project is a repository with one commit on main.
  if (git) {
    put(join(project, 'a.txt'), 'a\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']]) Bun.spawnSync(['git', ...args], { cwd: project });
  }
  const paths = configPaths({ home: join(root, 'home'), cwd: project, env: {} });
  if (config) put(paths.global, config(fake.url));
  for (const [name, text] of Object.entries(personal)) put(join(personalInstructionsDir(paths, project), name), text);
  if (systemMd) put(join(dirname(paths.global), 'system.md'), systemMd);
  if (compactionMd) put(join(dirname(paths.global), 'compaction.md'), compactionMd);
  for (const [name, text] of Object.entries(policies)) put(join(dirname(paths.global), 'policies', `${name}.ts`), text);
  const fatal: string[] = [];
  let created = 0;
  const store = openSessionStore(join(root, 'sessions'), { id: () => (created++ ? `ses_new${created - 1}` : 'ses_test') });
  // Sessions are written oldest last: the first one given is the newest.
  Object.entries(sessions).forEach(([id, events], i) => {
    const path = join(root, 'sessions', `${id}.jsonl`);
    put(path, events.map(e => JSON.stringify(e) + '\n').join(''));
    const t = new Date(Date.now() - (i + 1) * 3_600_000);
    utimesSync(path, t, t);
  });
  for (const [id, pid] of Object.entries(locks)) put(join(root, 'sessions', `${id}.lock`), String(pid));
  const quit: string[] = [];
  ui = await testRender(
    () => (
      <Launch
        paths={paths}
        servers={servers?.(fake.url) ?? [{ backend: 'llamacpp', endpoint: fake.url }]}
        store={store}
        editor={async text => text}
        openFile={async () => {}}
        cwd={project}
        clipboard={async () => {}}
        resume={resume}
        onQuit={() => quit.push('quit')}
        onFatal={m => fatal.push(m)}
      />
    ),
    { width: 80, height: 16 },
  );
  const log = () => readFileSync(join(root, 'sessions', 'ses_test.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { paths, fatal, log, store, quit, root, project };
}

export const profileConfig = (url: string, extra = '') => `{
  // test profile
  "profiles": { "local": { "backend": "llamacpp", "endpoint": "${url}", "window": 2048 ${extra} } },
  "defaultProfile": "local",
}`;

export const chat = (profile: string): SessionEvent[] => [
  ...newSession(profile, 'You are terse.'),
  { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'hi there' },
  { type: 'RequestSent', hash: 'h', tokens: 20 },
  { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'hello' },
  { type: 'ResponseReceived', usage: null, cached: null },
];

export const titled = (profile: string, title: string, tokens = 20) =>
  chat(profile).map(e => (e.type === 'BlockAdded' && e.kind === 'User' ? { ...e, content: title } : e.type === 'RequestSent' ? { ...e, tokens } : e));

export const key = async (name: string) => {
  if (name === 'up' || name === 'down') ui.mockInput.pressArrow(name);
  else if (name === 'enter') ui.mockInput.pressEnter();
  else if (name === 'escape') {
    ui.mockInput.pressEscape();
    await Bun.sleep(50);
  } else ui.mockInput.pressKey(name);
  await ui.flush();
};

export const line = (frame: string, pattern: RegExp) => frame.split('\n').find(l => pattern.test(l));

export async function command(text: string) {
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(text);
  ui.mockInput.pressEnter();
}

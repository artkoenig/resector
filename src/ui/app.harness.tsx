// UI test harness: renders the App against a fake llama.cpp server, with helpers to type, press and read frames.
import { afterEach, beforeAll } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testRender } from '@opentui/solid';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { frameMatching } from '../../test/frames';
import { BASH_TOOLS, withTools } from '../../test/requests';
import { connectLlamaCpp } from '../adapters/backend/llamacpp';
import { createRunner } from '../adapters/bash/runner';
import { createSplit } from '../adapters/bash/split';
import { createSessionLog } from '../adapters/store/session-log';
import { permissionRules, type Permissions, type Split } from '../core/approval/approval';
import { listProjectFiles, projectFiles } from '../adapters/fs/project';
import { newSession, type SessionNotes } from '../core/session/session';
import type { Tool } from '../core/log/events';
import type { Policy } from '../core/policy/policy';
import { createSignal } from 'solid-js';
import { App } from './app';
import { formatTokens } from '../gate/text';
import type { GateOptions } from '../gate';

export let fake: ReturnType<typeof startFakeLlamaCpp>;
export let ui: Awaited<ReturnType<typeof testRender>>;

// Where bash runs in these tests.
export const project = realpathSync(mkdtempSync(join(tmpdir(), 'resector-project-')));

let split: Split;

// Called once per test file: the bash split parser before, the UI and the fake server torn down after each test.
export function useHarness() {
  beforeAll(async () => {
    split = await createSplit();
  });
  afterEach(() => {
    ui.renderer.destroy();
    fake.stop();
  });
}

// What copy on select put into the clipboard.
export let copied: string[];
// The files opened in $EDITOR (`e` on an @path reference).
export let openedFiles: string[];
// Set by tests after start(): $EDITOR for `e`, the text as the user saves it (default unchanged); the environment Note's
// text as the harness probes it now.
export const fixture: { editor: (text: string) => Promise<string>; environment: string } = { editor: async text => text, environment: '' };

// `tools`: the Tools Block (default bash only, so token counts stay put). `users`: User blocks already in the Session Log, not yet sent; `global`, `project`: permission rules of the config.
// `calls`: pending Tool Calls after them, as at a resume (a string: a bash command). `template`: the chat template the server reports.
// `window`: the server's context size; `exact`: false counts like an inexact tokenizer (Ollama, LM Studio).
export type Start = { tools?: string; template?: string; window?: number; exact?: boolean; notes?: SessionNotes; timeout?: number; compactor?: GateOptions['compactor']; policies?: Policy[]; users?: string[]; calls?: (string | { tool: Tool; content: string })[]; global?: Permissions; project?: Permissions; git?: GateOptions['git']; hidden?: string[] | 'default' };
export async function start({ tools = BASH_TOOLS, template, window = 4096, exact = true, notes, timeout = 120, compactor, policies = [], users = [], calls = [], global, project: own, git, hidden = [] }: Start = {}) {
  fixture.editor = async text => text;
  copied = [];
  fixture.environment = notes?.environment ?? '';
  openedFiles = [];
  fake = startFakeLlamaCpp({ nCtx: window, template });
  const backend = { ...(await connectLlamaCpp(fake.url)), exact };
  const log = createSessionLog(mkdtempSync(join(tmpdir(), 'resector-')), 'ses_test');
  const runner = createRunner({ cwd: project, timeout });
  // search without ddgr: the query is echoed back as its result.
  const searcher = { timeout: 30, run: async (query: string) => ({ output: `results for ${query}\n`, exit: 0, stopped: null }) };
  const first = newSession('default', '', notes).length;
  const initial = [
    ...withTools(newSession('default', 'You are an agent.', notes), tools),
    ...users.map((content, i) => ({ type: 'BlockAdded' as const, id: i + first, kind: 'User' as const, origin: 'user' as const, content })),
    ...calls.map((call, i) => ({ type: 'BlockAdded' as const, id: users.length + i + first, kind: 'Tool Call' as const, origin: 'model' as const, ...(typeof call === 'string' ? { content: call } : call) })),
  ];
  initial.forEach(log.append);
  const opened: string[] = [];
  const approval = { split, root: project, permissions: () => permissionRules(global, own) };
  const files = { read: projectFiles(project), list: () => listProjectFiles(project), environment: () => fixture.environment, open: async (path: string) => void openedFiles.push(path) };
  const [active, setActive] = createSignal<Policy | null>(null);
  ui = await testRender(
    () => <App backend={backend} runner={runner} searcher={searcher} approval={approval} editor={text => fixture.editor(text)} project={files} clipboard={async text => void copied.push(text)} log={log} events={initial} instruction={() => 'keep the gist'} compactor={compactor} policies={{ all: policies, active, set: setActive }} openSessions={() => opened.push('sessions')} git={git} hidden={hidden === 'default' ? undefined : hidden} onQuit={() => {}} />,
    { width: 80, height: 20 },
  );
  const size = ` / ${formatTokens(window)}`;
  await frameMatching(ui, f => f.includes(users.length || notes || tools !== BASH_TOOLS ? size : `52${size}`) && !f.includes(`…${size}`));
  const events = () => readFileSync(log.path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { events, opened };
}

export const line = (frame: string, pattern: RegExp) => frame.split('\n').find(l => pattern.test(l));

// A lone ESC byte is only recognised as the Escape key after the input parser's timeout.
export async function escape() {
  ui.mockInput.pressEscape();
  await Bun.sleep(50);
}

// Writes `text` in input mode; Enter adds it and sends the Context.
export async function write(text: string) {
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(text);
  ui.mockInput.pressEnter();
}

// User blocks not yet sent, the last one selected.
export async function withUsers(...texts: string[]) {
  const started = await start({ users: texts });
  for (let i = 0; i < texts.length + 1; i++) ui.mockInput.pressArrow('down');
  await frameMatching(ui, f => previewed(f) === texts.at(-1));
  return started;
}

export const press = async (key: string, modifiers?: { meta?: boolean }) => {
  if (key === 'up' || key === 'down') ui.mockInput.pressArrow(key, modifiers);
  else ui.mockInput.pressKey(key, modifiers);
  await ui.flush();
};

export const order = (frame: string) => [...frame.matchAll(/^[ ┃] [ ●] +(\d+) {2}\w+ +(\S+)/gm)].map(m => `${m[1]} ${m[2]}`);

// Per numbered row: its number and Cache column.
export const cache = (frame: string) => [...frame.matchAll(/^[ ┃] [ ●] +(\d+) {2}.*\d +([●○]) /gm)].map(m => m[1]! + m[2]!);

// The first line of the Content preview: shows which block is selected.
export const previewed = (frame: string) => {
  const lines = frame.split('\n');
  return (lines[lines.findIndex(l => /^┃ [A-Z][\w ]* {2}#\d+/.test(l)) + 1] ?? '').slice(2, -1).trim(); // ┃ bar, last column: scrollbar
};

export async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(10);
}

export const bash = (command: string) => ({ name: 'bash', arguments: JSON.stringify({ command }) });

export type Sent = { messages: Record<string, unknown>[]; tools?: { function: { name: string } }[] };

// The model answers `go` with `text` and bash calls.
export async function answered(commands: string[], { text = '', ...options }: { text?: string } & Start = {}) {
  const started = await start(options);
  fake.reply({ chunks: text ? [text] : [], calls: commands.map(bash) });
  await write('go');
  return started;
}

// The same; the Gate stops at the first ? approve.
export async function asked(commands: string[], { text = '', ...options }: { text?: string } & Start = {}) {
  const started = await answered(commands, { text, ...options });
  await frameMatching(ui, f => f.includes('? approve –') && !/Tool Call .* … /.test(f));
  return started;
}

// The same; y runs the call, its result is sent and answered with `reply`.
export async function ran(command: string, { reply = 'ok', ...options }: { reply?: string; text?: string } & Start = {}) {
  const started = await asked([command], options);
  fake.reply({ chunks: [reply] });
  await press('y');
  await frameMatching(ui, f => f.includes('answer complete'));
  return started;
}

export const messages = (i: number) => (fake.chatRequests[i] as { messages: { role: string; content: string }[] }).messages;

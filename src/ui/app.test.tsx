import { afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextAttributes } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { frameMatching } from '../../test/frames';
import { BASH_TOOLS, withTools } from '../../test/requests';
import { TOOLS } from '../core/toolcall/bash';
import { connectLlamaCpp } from '../adapters/backend/llamacpp';
import { createRunner } from '../adapters/bash/runner';
import { createSplit } from '../adapters/bash/split';
import { createSessionLog } from '../adapters/store/session-log';
import { permissionRules, type Permissions, type Split } from '../core/approval/approval';
import { listProjectFiles, projectFiles } from '../adapters/fs/project';
import { newSession, type SessionNotes } from '../core/session/session';
import type { Tool } from '../core/log/events';
import type { Policy, PolicyOperation } from '../core/policy/policy';
import { createSignal } from 'solid-js';
import { App } from './app';
import { formatTokens } from './format';
import { TONE } from './theme';
import type { GateOptions } from './gate';

let fake: ReturnType<typeof startFakeLlamaCpp>;
let ui: Awaited<ReturnType<typeof testRender>>;
afterEach(() => {
  ui.renderer.destroy();
  fake.stop();
});

// Where bash runs in these tests.
const project = realpathSync(mkdtempSync(join(tmpdir(), 'resector-project-')));

let split: Split;
beforeAll(async () => {
  split = await createSplit();
});

// $EDITOR for `e`: the text as the user saves it; default unchanged.
let editor: (text: string) => Promise<string>;
// What copy on select put into the clipboard.
let copied: string[];
// The environment Note's text as the harness probes it now; the files opened in $EDITOR (`e` on an @path reference).
let environment: string;
let openedFiles: string[];

// `tools`: the Tools Block (default bash only, so token counts stay put). `users`: User blocks already in the Session Log, not yet sent; `global`, `project`: permission rules of the config.
// `calls`: pending Tool Calls after them, as at a resume (a string: a bash command). `template`: the chat template the server reports.
// `window`: the server's context size; `exact`: false counts like an inexact tokenizer (Ollama, LM Studio).
type Start = { tools?: string; template?: string; window?: number; exact?: boolean; notes?: SessionNotes; timeout?: number; compactor?: GateOptions['compactor']; policies?: Policy[]; users?: string[]; calls?: (string | { tool: Tool; content: string })[]; global?: Permissions; project?: Permissions; git?: GateOptions['git']; hidden?: string[] | 'default' };
async function start({ tools = BASH_TOOLS, template, window = 4096, exact = true, notes, timeout = 120, compactor, policies = [], users = [], calls = [], global, project: own, git, hidden = [] }: Start = {}) {
  editor = async text => text;
  copied = [];
  environment = notes?.environment ?? '';
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
  const files = { read: projectFiles(project), list: () => listProjectFiles(project), environment: () => environment, open: async (path: string) => void openedFiles.push(path) };
  const [active, setActive] = createSignal<Policy | null>(null);
  ui = await testRender(
    () => <App backend={backend} runner={runner} searcher={searcher} approval={approval} editor={text => editor(text)} project={files} clipboard={async text => void copied.push(text)} log={log} events={initial} instruction={() => 'keep the gist'} compactor={compactor} policies={{ all: policies, active, set: setActive }} openSessions={() => opened.push('sessions')} git={git} hidden={hidden === 'default' ? undefined : hidden} onQuit={() => {}} />,
    { width: 80, height: 20 },
  );
  const size = ` / ${formatTokens(window)}`;
  await frameMatching(ui, f => f.includes(users.length || notes || tools !== BASH_TOOLS ? size : `52${size}`) && !f.includes(`…${size}`));
  const events = () => readFileSync(log.path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { events, opened };
}

const line = (frame: string, pattern: RegExp) => frame.split('\n').find(l => pattern.test(l));

// A lone ESC byte is only recognised as the Escape key after the input parser's timeout.
async function escape() {
  ui.mockInput.pressEscape();
  await Bun.sleep(50);
}

// Writes `text` in input mode; Enter adds it and sends the Context.
async function write(text: string) {
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(text);
  ui.mockInput.pressEnter();
}

test('the Gate shows every Context Block with its exact tokens and the Template row', async () => {
  const { events } = await start();
  const frame = await frameMatching(ui, f => previewed(f) === 'You are an agent.');
  expect(line(frame, /default/)).toMatch(/^ {2}resector {2}default · thinking off +52 \/ 4k/);
  expect(frame.split('\n')[1]).toMatch(/^ {2}▀+/);
  expect(line(frame, /Type/)).toMatch(/#\s+Type\s+Content\s+Tokens\s+Cache\s+Flags/);
  expect(line(frame, /System prompt/)).toMatch(/1\s+System\s+System prompt\s+12\b/);
  expect(line(frame, /Template/)).toMatch(/Template\s.*\s4\b/);
  expect(line(frame, /#1 · /)).toMatch(/^┃ System {2}#1 · 12 tokens/);
  expect(previewed(frame)).toBe('You are an agent.');
  expect(frame).toContain('You are an agent.');
  expect(events()).toEqual([
    { type: 'SessionCreated', profile: 'default', protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'You are an agent.' },
    { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: BASH_TOOLS },
  ]);
});

test('Enter in input mode adds a User block and sends the Context; the answer streams in as a new row and is logged when complete', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hello', ' world'], usage: { prompt_tokens: 24, completion_tokens: 2 }, cacheN: 16 });
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('68 / 4k'));
  expect(line(frame, /hi there/)).toMatch(/3\s+User\s+hi there\s+8\b/);
  expect(line(frame, /Assistant/)).toMatch(/4\s+Assistant\s+Hello world\s+8\b/);
  expect(frame).toContain('⌥↑↓ move  e edit');
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().slice(3)).toEqual([
    { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'hi there' },
    { type: 'RequestSent', hash: expect.any(String), tokens: 60 },
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hello world' },
    { type: 'ResponseReceived', usage: { prompt_tokens: 24, completion_tokens: 2 }, cached: 16 },
  ]);
});

test('every request sends max_tokens = window − Context: no answer reserve', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['ok'] });
  await write('hi there');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events()[4]).toMatchObject({ type: 'RequestSent', tokens: 60 });
  expect(fake.chatRequests[0]).toMatchObject({ max_tokens: 4096 - 60 });
});

// The colour of the header's `tokens / window` (first line, right).
const headerTone = () => {
  const spans = ui.captureSpans().lines[0]!.spans.filter(s => /\d/.test(s.text));
  return spans.map(s => Array.from(s.fg.buffer.slice(0, 3), c => c.toString(16).padStart(2, '0')).join(''));
};

test('from 90 % of the window the tokens turn yellow', async () => {
  await start({ window: 64, users: ['short'] });
  const frame = ui.captureCharFrame();
  expect(line(frame, /default/)).toMatch(/58 \/ 64 {2}$/);
  expect(headerTone()).toEqual([TONE.warn.slice(1)]);
});

const LONG = 'a b c d e f g h i j k l m n o p q r s t';

test('a Context as big as the window blocks sending: red over by X, the bar marks the window edge', async () => {
  const { events } = await start({ window: 80, users: [LONG, 'short'] });
  let frame = ui.captureCharFrame();
  expect(line(frame, /default/)).toMatch(/102 \/ 80 over by 23 {2}$/);
  expect(headerTone()).toEqual([TONE.error.slice(1)]);
  expect(frame.split('\n')[1]).toMatch(/^ {2}▀+│▀+ *$/);
  const before = events().length;
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('over by 23 – sending blocked'));
  expect(line(frame, /sending blocked/)).toContain('d remove · e edit · c compact');
  expect(fake.chatRequests).toEqual([]);
  expect(events().slice(before).map(e => e.type)).not.toContain('RequestSent');
  // Removing the long block makes room: sent with the rest of the window as max_tokens.
  await press('down');
  await press('down');
  await press('d');
  frame = await frameMatching(ui, f => f.includes('58 / 80'));
  expect(frame.split('\n')[1]).not.toContain('│');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(fake.chatRequests[0]).toMatchObject({ max_tokens: 80 - 58 });
});

test('an inexact tokenizer shows ±drift and blocks sending that much below the window', async () => {
  const { events } = await start({ window: 80, exact: false, users: ['short'] });
  expect(line(ui.captureCharFrame(), /default/)).toMatch(/58 \/ 80 ±\? {2}$/);
  // The server counts 10 more prompt tokens than the backend did.
  fake.reply({ chunks: ['ok'], usage: { prompt_tokens: 68, completion_tokens: 1 } });
  ui.mockInput.pressEnter();
  let frame = await frameMatching(ui, f => f.includes('answer complete') && /\d+ \/ 80 ±10 {2}$/m.test(f));
  expect(events().find(e => e.type === 'RequestSent')).toMatchObject({ tokens: 58 });
  const total = Number(/(\d+) \/ 80 ±10 {2}$/m.exec(frame)![1]);
  // One word per two tokens: enough to reach the window less the drift, not the window itself.
  await write('x '.repeat(Math.ceil((70 - total - 5) / 2)).trim());
  const over = /(\d+) \/ 80 ±10 over by (\d+) {2}$/m;
  // The count comes after the block: wait for both.
  frame = await frameMatching(ui, f => f.includes('sending blocked') && over.test(f));
  const header = over.exec(frame)!;
  expect(Number(header[1])).toBeGreaterThanOrEqual(70);
  expect(Number(header[1])).toBeLessThan(80);
  expect(Number(header[2])).toBe(Number(header[1]) - 70 + 1);
  expect(fake.chatRequests).toHaveLength(1);
});

test('Enter in input mode on a full window: the User block stays, the status says why', async () => {
  const { events } = await start({ window: 64, users: [LONG] });
  await write('more');
  const frame = await frameMatching(ui, f => f.includes('sending blocked'));
  expect(line(frame, /more/)).toMatch(/User\s+more/);
  expect(events().at(-1)).toMatchObject({ type: 'BlockAdded', kind: 'User', content: 'more' });
  expect(fake.chatRequests).toEqual([]);
});

test('empty Enter in input mode adds nothing and sends nothing', async () => {
  await start();
  await write('   ');
  const frame = await frameMatching(ui, f => f.includes('⌥↑↓ move  e edit'));
  expect(frame).not.toMatch(/3\s+User/);
  expect(fake.chatRequests).toEqual([]);
});

test('Tab and Esc leave input mode without adding a block', async () => {
  await start();
  for (const leave of [async () => ui.mockInput.pressTab(), escape]) {
    ui.mockInput.pressTab();
    await frameMatching(ui, f => f.includes('adds a block and sends the Context'));
    await ui.mockInput.typeText('draft');
    await leave();
    const frame = await frameMatching(ui, f => f.includes('⌥↑↓ move  e edit'));
    expect(frame).not.toMatch(/3\s+User/);
  }
});

test('Enter in the Context sends it', async () => {
  const { events } = await start({ users: ['hi there'] });
  fake.reply({ chunks: ['Hello', ' world'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('68 / 4k'));
  expect(line(frame, /Assistant/)).toMatch(/4\s+Assistant\s+Hello world\s+8\b/);
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().at(-3)).toEqual({ type: 'RequestSent', hash: expect.any(String), tokens: 60 });
});

test('Esc again aborts streaming; the partial answer is kept as cut off', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hal'], hang: true });
  await write('hi there');
  const streaming = await frameMatching(ui, f => /4\s+Assistant\s+Hal/.test(f));
  expect(line(streaming, /Assistant/)).toMatch(/Hal\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  expect(events().at(-1).type).toBe('RequestSent');
  await escape();
  const stopping = await frameMatching(ui, f => f.includes('model is responding · stops after this answer'));
  expect(stopping).toContain('esc abort  q quit');
  await escape();
  const frame = await frameMatching(ui, f => /Hal\s+\d+\s+[●○]\s+⚠ cut off/.test(f));
  expect(line(frame, /Assistant/)).toMatch(/4\s+Assistant\s+Hal\s+\d+\s+●\s+⚠ cut off/);
  expect(events().slice(-2)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hal', cutOff: true },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
});

test('reasoning streams dimmed into its own Thinking row, the status says thinking; it is logged before the answer', async () => {
  const { events } = await start();
  fake.reply({ thinking: ['plan ', 'it'], chunks: ['hello'] });
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 hi', '4 plan', '5 hello']);
  expect(line(frame, /Thinking/)).toMatch(/4\s+Thinking\s+plan it\s/);
  expect(events().slice(-3)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Thinking', origin: 'model', content: 'plan it' },
    { type: 'BlockAdded', id: 5, kind: 'Assistant', origin: 'model', content: 'hello' },
    { type: 'ResponseReceived', usage: null, cached: 0 },
  ]);
  expect(fake.chatRequests).toHaveLength(1);
});

test('cut off while thinking: the Thinking row streams with status thinking, Esc keeps it ⚠ cut off without Assistant block', async () => {
  const { events } = await start();
  fake.reply({ thinking: ['Let me see'], chunks: [], hang: true });
  await write('hi there');
  const streaming = await frameMatching(ui, f => /4\s+Thinking\s+Let me see/.test(f));
  expect(streaming).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] model is thinking/);
  expect(previewed(streaming)).toBe('Let me see');
  await escape();
  await escape();
  const frame = await frameMatching(ui, f => f.includes('⚠ cut off ✂'));
  // Flags beyond their column are cut, not wrapped.
  expect(line(frame, /Thinking/)).toMatch(/4\s+Thinking\s+Let me see\s+0\s+[●○]\s+⚠ cut off ✂ t…$/);
  expect(frame).not.toMatch(/Assistant/);
  expect(events().slice(-2)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Thinking', origin: 'model', content: 'Let me see', cutOff: true },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
});

test('a Thinking block the chat template drops counts 0 tokens, is dimmed and flagged ✂ template; the cache is cold from there', async () => {
  await start();
  fake.reply({ thinking: ['plan it'], chunks: ['hello'] });
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('answer complete') && /Thinking.*✂ template/.test(f));
  expect(line(frame, /Thinking/)).toMatch(/4\s+Thinking\s+plan it\s+0\s+○\s+✂ template/);
  expect(cache(frame)).toEqual(['1●', '2●', '3●', '4○', '5○']);
  // Dimmed: the title in the muted colour.
  const title = ui.captureSpans().lines.flatMap(l => l.spans).find(s => s.text.includes('plan it'))!;
  expect(Array.from(title.fg.buffer.slice(0, 3)).join()).toBe('138,138,138');
});

test('the preview shows every block muted, Thinking in italics', async () => {
  await start();
  fake.reply({ thinking: ['plan it'], chunks: ['hello'] });
  await write('hi there');
  await frameMatching(ui, f => f.includes('answer complete'));
  const fg = (text: string) => {
    const span = ui.captureSpans().lines.slice(-20).flatMap(l => l.spans).findLast(s => s.text.includes(text))!;
    return Array.from(span.fg.buffer.slice(0, 3)).join();
  };
  const italic = (text: string) => {
    const spans = ui.captureSpans().lines.flatMap(l => l.spans).filter(s => s.text.includes(text));
    return spans.length > 1 && spans.every(s => (s.attributes & TextAttributes.ITALIC) !== 0);
  };
  await press('up');
  await frameMatching(ui, f => f.includes('┃ Thinking  #4'));
  expect(fg('plan it')).toBe('138,138,138');
  expect(italic('plan it')).toBe(true);
  await press('up');
  await frameMatching(ui, f => previewed(f) === 'hi there');
  expect(fg('hi there')).toBe('138,138,138');
  expect(ui.captureSpans().lines.flatMap(l => l.spans).filter(s => s.text.includes('hi there')).some(s => (s.attributes & TextAttributes.ITALIC) !== 0)).toBe(false);
});

// The colour of the last span holding `text`, once it is not the muted one: tree-sitter highlights in the background.
async function highlighted(text: string) {
  const fg = () => {
    const span = ui.captureSpans().lines.flatMap(l => l.spans).findLast(s => s.text.includes(text));
    return span ? Array.from(span.fg.buffer.slice(0, 3)).join() : '';
  };
  await until(() => fg() !== '' && fg() !== '138,138,138');
  return fg();
}

test('the preview renders Markdown: markers hidden, headings and bold stand out', async () => {
  await start();
  fake.reply({ chunks: ['# Plan\n\nfirst **bold** step\n\n- one\n- two'] });
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('answer complete') && /^┃ Plan\s/m.test(f));
  expect(frame).toMatch(/^┃ first bold step\s/m);
  expect(frame).not.toContain('**');
  const bold = ui.captureSpans().lines.flatMap(l => l.spans).findLast(s => s.text.includes('bold'))!;
  expect(bold.attributes & TextAttributes.BOLD).not.toBe(0);
});

test('a file Note is highlighted by its file type', async () => {
  writeFileSync(join(project, 'code.ts'), 'const answer = "yes";\n');
  await start();
  await write('@code.ts');
  await frameMatching(ui, f => f.includes('[code.ts]'));
  expect(await highlighted('const')).toBe('157,124,216');
  expect(await highlighted('"yes"')).toBe('127,216,143');
});

test('a bash Tool Call is highlighted as bash', async () => {
  await ran('echo "hi"');
  await press('up');
  await press('up');
  await frameMatching(ui, f => f.includes('┃ Tool Call'));
  expect(await highlighted('"hi"')).toBe('127,216,143');
});

test('while the answer streams, ↑↓ select and the preview scrolls; the Context stays as sent', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hal'], hang: true });
  await write('hi there');
  let frame = await frameMatching(ui, f => /4\s+Assistant\s+Hal/.test(f));
  expect(frame).toContain('esc stop after  q quit');
  await press('up');
  frame = await frameMatching(ui, f => previewed(f) === 'hi there');
  await press('d');
  await press('down');
  frame = await frameMatching(ui, f => previewed(f).startsWith('Hal'));
  expect(frame).not.toContain('removed');
  expect(events().at(-1).type).toBe('RequestSent');
  await escape();
  await escape();
  await frameMatching(ui, f => f.includes('⚠ cut off'));
  expect(events().filter(e => e.type === 'Remove')).toEqual([]);
});

// User blocks not yet sent, the last one selected.
async function withUsers(...texts: string[]) {
  const started = await start({ users: texts });
  for (let i = 0; i < texts.length + 1; i++) ui.mockInput.pressArrow('down');
  await frameMatching(ui, f => previewed(f) === texts.at(-1));
  return started;
}
const press = async (key: string, modifiers?: { meta?: boolean }) => {
  if (key === 'up' || key === 'down') ui.mockInput.pressArrow(key, modifiers);
  else ui.mockInput.pressKey(key, modifiers);
  await ui.flush();
};
const order = (frame: string) => [...frame.matchAll(/^[ ┃] [ ●] +(\d+) {2}\w+ +(\S+)/gm)].map(m => `${m[1]} ${m[2]}`);

test('⌥↑⌥↓ move the selected block and flag it ⇄ until sent', async () => {
  const { events } = await withUsers('first', 'second');
  await press('up', { meta: true });
  let frame = await frameMatching(ui, f => /3\s+User\s+second/.test(f));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 second', '4 first']);
  expect(line(frame, /second/)).toMatch(/⇄/);
  expect(line(frame, /first/)).not.toMatch(/⇄/);
  expect(events().at(-1)).toEqual({ type: 'Move', id: 4, after: 2, by: 'user' });
  await press('up', { meta: true });
  frame = await frameMatching(ui, f => f.includes('boundary reached'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 second', '4 first']);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => /5\s+Assistant\s+ok/.test(f) && f.includes('answer complete'));
  expect(frame).not.toContain('⇄');
});

test('p pins nothing: pinning is gone (ADR 0002)', async () => {
  const { events } = await withUsers('rules', 'question');
  const before = events().length;
  await press('up');
  await press('p');
  const frame = await frameMatching(ui, f => previewed(f) === 'rules');
  expect(frame).not.toContain('p pin');
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 rules', '4 question']);
  expect(events()).toHaveLength(before);
});

test('/thinking sets the thinking mode, shown in the header, logged and sent with the next request', async () => {
  const { events } = await withUsers('question');
  expect(line(await frameMatching(ui, f => f.includes('default')), /default/)).toContain('default · thinking off');
  await write('/thinking on');
  const frame = await frameMatching(ui, f => f.includes('default · thinking on'));
  expect(frame).toContain('thinking on');
  expect(events().slice(-1)).toEqual([{ type: 'ThinkingSet', thinking: 'on' }]);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(fake.chatRequests[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
  await write('/thinking off');
  await frameMatching(ui, f => f.includes('default · thinking off'));
});

test('/thinking offers the modes of the chat template', async () => {
  const { events } = await start({ template: "{% if reasoning_effort not in ('xhigh', 'low') %}{% endif %}" });
  await write('/thinking on:low');
  await frameMatching(ui, f => f.includes('default · thinking on:low'));
  await write('/thinking on:xhigh');
  await frameMatching(ui, f => f.includes('default · thinking on:xhigh'));
  await write('/thinking on:low');
  await frameMatching(ui, f => f.includes('default · thinking on:low'));
  expect(events().filter(e => e.type === 'ThinkingSet').map(e => e.thinking)).toEqual(['low', 'xhigh', 'low']);
});

test('a chat template without thinking: /thinking says so and logs nothing', async () => {
  const { events } = await start({ template: '{{ messages }}' });
  await write('/thinking');
  await frameMatching(ui, f => f.includes('the chat template has no thinking switch'));
  expect(events().some(e => e.type === 'ThinkingSet')).toBe(false);
});

test('with marks only d and c are offered; d removes every marked block, u brings all back', async () => {
  const { events } = await withUsers('one', 'two', 'three');
  await press(' ');
  await press('up');
  await press('up');
  await press(' ');
  let frame = await frameMatching(ui, f => /●\s+3\s+User/.test(f) && f.includes('esc unmark'));
  expect(frame).not.toContain('edit');
  await press('e');
  await press('d');
  frame = await frameMatching(ui, f => f.includes('removed 2 marked blocks'));
  expect(line(frame, /one/)).toMatch(/User\s+one\s+removed/);
  expect(line(frame, /two/)).not.toMatch(/removed/);
  expect(line(frame, /three/)).toMatch(/User\s+three\s+removed/);
  expect(frame).not.toMatch(/^[ ┃] ●/m);
  expect(events().at(-1)).toEqual({ type: 'Remove', id: 3, others: [5], by: 'user' });
  await press('u');
  frame = await frameMatching(ui, f => f.includes('undone: remove'));
  expect(frame).not.toMatch(/removed\s*$/m);
});

test('while a changed Context is counted, blocks before the change keep their tokens and cache', async () => {
  await withUsers('keep', 'drop');
  const before = line(ui.captureCharFrame(), /keep/)!;
  const release = fake.holdCounts();
  await press('d');
  let frame = await frameMatching(ui, f => f.includes('removed ·'));
  expect(line(frame, /keep/)!.slice(1)).toBe(before.slice(1));
  expect(line(frame, /System prompt/)).toMatch(/System prompt\s+12\b/);
  release();
  frame = await frameMatching(ui, f => f.includes('58 / 4k'));
  expect(line(frame, /keep/)!.slice(1)).toBe(before.slice(1));
});

test('d strikes the block through until sent; u brings it back as a counter-event', async () => {
  const { events } = await withUsers('keep', 'drop');
  await press('d');
  let frame = await frameMatching(ui, f => f.includes('removed ·'));
  expect(line(frame, /drop/)).toMatch(/^ {8}User\s+drop\s+removed/);
  const struck = ui.captureSpans().lines.flatMap(l => l.spans).find(s => s.text.includes('drop') && !s.text.includes('removed ·'))!;
  expect(struck.attributes & TextAttributes.STRIKETHROUGH).toBeTruthy();
  frame = await frameMatching(ui, f => f.includes('58 / 4k'));
  expect(line(frame, /keep/)).toMatch(/3\s+User\s+keep/);
  await press('u');
  frame = await frameMatching(ui, f => f.includes('undone: remove'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 keep', '4 drop']);
  expect(events().slice(-2)).toEqual([{ type: 'Remove', id: 4, by: 'user' }, { type: 'Undo', eventId: 5 }]);
  await press('down');
  await press('d');
  fake.reply({ chunks: ['fine'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('drop');
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 keep', '4 fine']);
});

test('Space marks and unmarks the selected block; the selection stays on the last row', async () => {
  await withUsers('one', 'two');
  await press(' ');
  let frame = await frameMatching(ui, f => /●\s+4\s+User\s+two/.test(f));
  expect(previewed(frame)).toBe('two');
  await press(' ');
  frame = await frameMatching(ui, f => !f.includes('●'));
  expect(line(frame, /two/)).toMatch(/^[ ┃] {2} +4\s+User/);
});

test('Space moves the selection on to the next row, like d', async () => {
  await withUsers('one', 'two');
  await press('up');
  await press(' ');
  const frame = await frameMatching(ui, f => /●\s+3\s+User\s+one/.test(f));
  expect(previewed(frame)).toBe('two');
});

test('@ in the Context starts a file reference in the input line, r does nothing', async () => {
  writeFileSync(join(project, 'at-key.txt'), 'x\n');
  const { events } = await withUsers('hello there');
  await press('r');
  expect(ui.captureCharFrame()).toContain('Tab to write');
  await ui.mockInput.typeText('@at-k');
  const frame = await frameMatching(ui, f => f.includes('┃ @at-k') && f.includes('at-key.txt'));
  expect(frame).toContain('tab/enter complete');
  expect(events().some(e => e.type === 'Rename')).toBe(false);
});

test('the header Context bar highlights the selected block', async () => {
  await start({ users: ['x '.repeat(300)] });
  for (const k of ['down', 'down']) await press(k);
  const bar = () => ui.captureSpans().lines[1]!.spans.filter(s => s.text.includes('▀'));
  const white = () => bar().filter(s => Array.from(s.fg.buffer.slice(0, 3)).join() === '238,238,238').map(s => s.text.length);
  await frameMatching(ui, f => /\d+ \/ 4k/.test(f) && !f.includes('52 / 4k'));
  const user = white();
  await press('up');
  await ui.renderOnce();
  const system = white();
  expect(user).toHaveLength(1);
  expect(system).toHaveLength(1);
  expect(user[0]).toBeGreaterThan(system[0]!);
});

// Per numbered row: its number and Cache column.
const cache = (frame: string) => [...frame.matchAll(/^[ ┃] [ ●] +(\d+) {2}.*\d +([●○]) /gm)].map(m => m[1]! + m[2]!);

test('the Cache column shows ● for rows before the invalidation point, ○ from it on', async () => {
  await withUsers('hi there');
  expect(cache(await frameMatching(ui, f => cache(f).length === 3))).toEqual(['1○', '2○', '3○']);
  fake.reply({ chunks: ['hello'] });
  ui.mockInput.pressEnter();
  const answered = await frameMatching(ui, f => f.includes('answer complete') && cache(f).length === 4);
  expect(cache(answered)).toEqual(['1●', '2●', '3●', '4●']);
  expect(line(answered, /Type/)).toMatch(/Tokens\s+Cache\s+Flags/);
  await press('up', { meta: true });
  const frame = await frameMatching(ui, f => /3\s+Assistant\s+hello/.test(f) && cache(f).length === 4);
  expect(cache(frame)).toEqual(['1●', '2●', '3○', '4○']);
});

test('a server reusing fewer tokens than predicted is reported', async () => {
  await withUsers('hi there');
  fake.reply({ chunks: ['hello'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  fake.reply({ chunks: ['ok'], cacheN: 3 });
  await write('more');
  const frame = await frameMatching(ui, f => f.includes('server reused'));
  // BOS + System 12 + Tools 36 + User 8 + <|im_start|> assistant \n hello
  expect(frame).toContain('answer complete · ⚠ cache: predicted 61 · server reused 3');
  expect(line(frame, /Type/)).toMatch(/Tokens +Cache +Flags/);
});

test('the key hints stay visible next to a status', async () => {
  await withUsers('hi');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).toContain('⌥↑↓ move  e edit');
});

test('a Context changed since the last request can be sent without a new User block', async () => {
  await withUsers('a', 'b');
  fake.reply({ chunks: ['x'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  await press('up');
  await press('up');
  await press('d');
  await frameMatching(ui, f => f.includes('struck through until sent'));
  fake.reply({ chunks: ['y'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete') && /y\s+\d+/.test(f));
  expect(fake.chatRequests).toHaveLength(2);
  expect((fake.chatRequests[1] as { messages: { content: string }[] }).messages.map(m => m.content)).toEqual(['You are an agent.', 'b', 'x']);
});

test('an undone change leaves nothing to send', async () => {
  await withUsers('a');
  fake.reply({ chunks: ['x'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  await press('up');
  await press('d');
  await frameMatching(ui, f => f.includes('struck through until sent'));
  await press('u');
  await frameMatching(ui, f => f.includes('undone: remove'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  expect(fake.chatRequests).toHaveLength(1);
});

test('typing / suggests the commands, filtered while typing; ↑↓ choose, Enter runs', async () => {
  const { opened } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/');
  let frame = await frameMatching(ui, f => f.includes('/filter'));
  expect(frame).toContain('↑↓ choose  tab complete  enter run  esc back');
  expect(frame).not.toContain('/reload');
  expect(line(frame, /\/sessions/)).toMatch(/\/sessions\s+list, resume, rename, delete sessions/);
  expect(line(frame, /\/rename/)).toMatch(/\/rename <title>\s+rename session/);
  await ui.mockInput.typeText('re');
  frame = await frameMatching(ui, f => !f.includes('/sessions'));
  expect(frame).toContain('/rename');
  ui.mockInput.pressBackspace();
  ui.mockInput.pressBackspace();
  await frameMatching(ui, f => f.includes('/sessions'));
  await press('down');
  // A command with an argument is completed first, then run.
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('┃ /rename') && !f.includes('rename session'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('session title reset'));
  await write('/sessions');
  await until(() => opened.length > 0);
  await write('/nope');
  await frameMatching(ui, f => f.includes('✗ unknown command /nope') && f.includes('/sessions /rename /tools /filter /policy /auto /thinking'));
  // Config is read when a session opens: a change needs a restart (ADR 0001).
  await write('/reload');
  await frameMatching(ui, f => f.includes('✗ unknown command /reload'));
});

test('/ in the Context starts a command in the input line', async () => {
  await start();
  await ui.mockInput.typeText('/');
  const frame = await frameMatching(ui, f => f.includes('/filter'));
  expect(frame).toContain('┃ /');
  await ui.mockInput.typeText('ren');
  await frameMatching(ui, f => f.includes('rename session') && !f.includes('/sessions'));
});

test('Tab completes a command; /rename sets the session title, empty resets it', async () => {
  const { events } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/ren');
  await frameMatching(ui, f => f.includes('rename session'));
  ui.mockInput.pressTab();
  await frameMatching(ui, f => f.includes('┃ /rename '));
  await ui.mockInput.typeText('my  title');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('session renamed: my  title'));
  expect(events().at(-1)).toEqual({ type: 'SessionRenamed', title: 'my  title' });
  await write('/rename');
  await frameMatching(ui, f => f.includes('session title reset to the first User message'));
  expect(events().at(-1)).toEqual({ type: 'SessionRenamed', title: '' });
});

test('/tools completes the tool names and switches one off and on; off, it is not sent', async () => {
  const { events } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/tools b');
  let frame = await frameMatching(ui, f => /^ {2}bash\s+on → off/m.test(f));
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('bash off · u = undo'));
  expect(line(frame, /Tools/)).toMatch(/2\s+Tools\s+no tools/);
  expect(events().at(-1)).toMatchObject({ type: 'Edit', id: 2, content: '[]', by: 'user' });
  fake.reply({ chunks: ['ok'] });
  await write('hi');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect((fake.chatRequests[0] as Sent).tools).toBeUndefined();
  await write('/tools bash');
  frame = await frameMatching(ui, f => f.includes('bash on · u = undo'));
  expect(line(frame, /Tools/)).toMatch(/2\s+Tools\s+bash/);
  await write('/tools');
  await frameMatching(ui, f => f.includes('tools: bash · /tools <tool> switches one'));
  await write('/tools python');
  await frameMatching(ui, f => f.includes('unknown tool python – bash search'));
});

test('search, switched on with /tools, runs without asking; its call and result are sent as search', async () => {
  const { events } = await start();
  await write('/tools search');
  await frameMatching(ui, f => f.includes('search on · u = undo'));
  fake.reply({ chunks: [], calls: [{ name: 'search', arguments: '{"query":"bun runtime"}' }] });
  fake.reply({ chunks: ['ok'] });
  await write('go');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('? approve');
  expect(frame).toMatch(/Tool Call\s+search bun runtime/);
  expect(frame).toMatch(/Tool Result\s+→ search bun runtime/);
  expect(events().find(e => e.kind === 'Tool Call')).toMatchObject({ tool: 'search', content: 'bun runtime' });
  expect(events().find(e => e.kind === 'Tool Result')).toMatchObject({ content: 'results for bun runtime\n[exit 0]' });
  const [call] = (fake.chatRequests[1] as { messages: { tool_calls?: { function: object }[] }[] }).messages.flatMap(m => m.tool_calls ?? []);
  expect(call!.function).toEqual({ name: 'search', arguments: '{"query":"bun runtime"}' });
});

// The first line of the Content preview: shows which block is selected.
const previewed = (frame: string) => {
  const lines = frame.split('\n');
  return (lines[lines.findIndex(l => /^┃ [A-Z][\w ]* {2}#\d+/.test(l)) + 1] ?? '').slice(2, -1).trim(); // ┃ bar, last column: scrollbar
};

async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(10);
}

test('the preview scrolls with PgUp/PgDn and ⇧↑↓; a newly selected block starts at its top', async () => {
  await start();
  const words = Array.from({ length: 90 }, (_, i) => `w${String(i + 1).padStart(2, '0')}`).join(' ');
  await write(words);
  let frame = await frameMatching(ui, f => previewed(f).startsWith('w01') && !f.includes('… / 4k'));
  expect(previewed(frame)).toMatch(/^w01 /);
  expect(frame).not.toContain('w90');
  ui.mockInput.pressKey('\u001B[6~');
  frame = await frameMatching(ui, f => f.includes('w90'));
  expect(previewed(frame)).not.toMatch(/^w01 /);
  ui.mockInput.pressArrow('up', { shift: true });
  frame = await frameMatching(ui, f => !f.includes('w90'));
  await press('\u001B[A');
  await press('\u001B[B');
  frame = await frameMatching(ui, f => /^w01 /.test(previewed(f)));
  expect(frame).not.toContain('w90');
});

const bash = (command: string) => ({ name: 'bash', arguments: JSON.stringify({ command }) });
type Sent = { messages: Record<string, unknown>[]; tools?: { function: { name: string } }[] };
// The model answers `go` with `text` and bash calls.
async function answered(commands: string[], { text = '', ...options }: { text?: string } & Start = {}) {
  const started = await start(options);
  fake.reply({ chunks: text ? [text] : [], calls: commands.map(bash) });
  await write('go');
  return started;
}
// The same; the Gate stops at the first ? approve.
async function asked(commands: string[], { text = '', ...options }: { text?: string } & Start = {}) {
  const started = await answered(commands, { text, ...options });
  await frameMatching(ui, f => f.includes('? approve –') && !/Tool Call .* … /.test(f));
  return started;
}
// The same; y runs the call, its result is sent and answered with `reply`.
async function ran(command: string, { reply = 'ok', ...options }: { reply?: string; text?: string } & Start = {}) {
  const started = await asked([command], options);
  fake.reply({ chunks: [reply] });
  await press('y');
  await frameMatching(ui, f => f.includes('answer complete'));
  return started;
}

test('the Tools Block (bash) is always sent and fixed', async () => {
  await withUsers('hi');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect((fake.chatRequests[0] as Sent).tools!.map(t => t.function.name)).toEqual(['bash']);
  for (const k of ['up', 'up']) await press(k);
  await frameMatching(ui, f => previewed(f) === '[');
  await press('d');
  await frameMatching(ui, f => f.includes('Tools Block cannot be removed'));
  await press('down', { meta: true });
  await frameMatching(ui, f => f.includes('Tools Block is fixed'));
});

test('a Tool Call waits at ? approve; y runs it once, its result is a Tool Result block and is sent', async () => {
  const { events } = await asked(['echo hello'], { text: 'Let me look.' });
  let frame = ui.captureCharFrame();
  expect(line(frame, /Let me look/)).toMatch(/4\s+Assistant\s+Let me look\./);
  expect(line(frame, /Tool Call/)).toMatch(/5\s+Tool Call\s+echo hello\s+\d+\s+[●○]\s+\? approve/);
  expect(frame).toMatch(/y run once.*n reject/);
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('Tool Calls await approval'));
  fake.reply({ chunks: ['done'] });
  await press('y');
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(line(frame, /Tool Result/)).toMatch(/6\s+Tool Result\s+→ echo hello\s+\d+/);
  expect(line(frame, /Tool Call/)).not.toContain('? approve');
  expect(fake.chatRequests).toHaveLength(2);
  expect(events().slice(-7)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Let me look.' },
    { type: 'BlockAdded', id: 5, kind: 'Tool Call', origin: 'model', content: 'echo hello' },
    { type: 'ResponseReceived', usage: null, cached: expect.any(Number) },
    { type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'hello\n[exit 0]', call: 5 },
    { type: 'RequestSent', hash: expect.any(String), tokens: expect.any(Number) },
    { type: 'BlockAdded', id: 7, kind: 'Assistant', origin: 'model', content: 'done' },
    { type: 'ResponseReceived', usage: null, cached: expect.any(Number) },
  ]);
  // Assistant text and its Tool Call are one message; the result a tool message.
  expect((fake.chatRequests[1] as Sent).messages.slice(2)).toEqual([
    { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'call_0', type: 'function', function: bash('echo hello') }] },
    { role: 'tool', tool_call_id: 'call_0', content: 'hello\n[exit 0]' },
  ]);
});

test('Enter in input mode while a Tool Call awaits approval adds the User block but sends nothing', async () => {
  const { events } = await asked(['echo hi']);
  ui.mockInput.pressTab();
  await frameMatching(ui, f => f.includes('adds a block and sends the Context'));
  await ui.mockInput.typeText('also this');
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('Tool Calls await approval') && f.includes('also this'));
  expect(line(frame, /also this/)).toMatch(/5\s+User\s+also this/);
  expect(previewed(frame)).toMatch(/^ask\s+echo hi\s+no rule → default ask$/);
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'User', origin: 'user', content: 'also this' });
});

test('n rejects: the call does not run, its result says "rejected by user"', async () => {
  const { events } = await asked(['touch rejected.txt']);
  expect(line(ui.captureCharFrame(), /Tool Call/)).toMatch(/4\s+Tool Call\s+touch rejected\.txt/);
  await press('n');
  const frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  expect(line(frame, /Tool Result/)).toMatch(/5\s+Tool Result\s+→ touch rejected\.txt/);
  expect(await Bun.file(join(project, 'rejected.txt')).exists()).toBe(false);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'rejected by user', call: 4 });
});

test('several calls are decided one by one in order; results keep call order', async () => {
  const { events } = await asked(['echo one', 'echo two']);
  let frame = ui.captureCharFrame();
  expect(line(frame, /echo one/)).toMatch(/\? approve/);
  expect(line(frame, /echo two/)).toMatch(/· queued/);
  await press('down');
  await press('y');
  await frameMatching(ui, f => f.includes('approve the earlier Tool Call first'));
  await press('up');
  await press('y');
  frame = await frameMatching(ui, f => f.includes('? approve –') && /^ask\s+echo two\s/.test(previewed(f)));
  expect(frame).toContain('┃ a allows "echo *" for this session');
  await press('n');
  frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  expect(frame).toMatch(/4\s+Tool Call\s+echo one[^]*5\s+Tool Call\s+echo two[^]*6\s+Tool Result\s+→ echo one[^]*7\s+Tool Result\s+→ echo two/);
  expect(events().slice(-2).map(e => [e.call, e.content])).toEqual([[4, 'one\n[exit 0]'], [5, 'rejected by user']]);
});

test('Esc again kills a running command: partial output + ⚠ killed', async () => {
  const { events } = await asked(['echo partial; sleep 5']);
  await press('y');
  let frame = await frameMatching(ui, f => f.includes('running: echo partial') && /^┃ partial\s*$/m.test(f));
  expect(frame).toMatch(/\d+s \/ 120s/);
  expect(frame).toContain('esc stop after');
  expect(line(frame, /Tool Result/)).toMatch(/5\s+Tool Result\s+→ echo partial.*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  expect(line(frame, /Tool Call/)).not.toContain('? approve');
  await escape();
  await frameMatching(ui, f => f.includes('stops after this call'));
  await escape();
  frame = await frameMatching(ui, f => f.includes('⚠ killed – review the results'));
  expect(line(frame, /Tool Result/)).toMatch(/⚠ killed/);
  expect(events().at(-1)).toMatchObject({ kind: 'Tool Result', content: 'partial\n[killed]', stopped: 'killed' });
});

test('Esc while a call runs: it finishes, the next call waits and nothing is sent; Enter goes on', async () => {
  const { events } = await answered(['sleep 0.3', 'ls'], { global: { 'sleep *': 'allow' } });
  await frameMatching(ui, f => f.includes('running: sleep 0.3'));
  await escape();
  let frame = await frameMatching(ui, f => f.includes('stopped – make your changes, Enter goes on'));
  expect(events().filter(e => e.kind === 'Tool Result').map(e => e.content)).toEqual(['[exit 0]']);
  expect(fake.chatRequests).toHaveLength(1);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.kind === 'Tool Result')).toHaveLength(2);
  expect(fake.chatRequests).toHaveLength(2);
});

test('reading an older row, the tool loop leaves the selection there; back on the last row it follows again', async () => {
  await start();
  fake.reply({ chunks: ['Look'], calls: [bash('ls')], delay: 0.3 });
  fake.reply({ chunks: ['done'] });
  await write('go');
  await frameMatching(ui, f => /Assistant\s+Look/.test(f));
  await press('up');
  await frameMatching(ui, f => previewed(f) === 'go');
  let frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(previewed(frame)).toBe('go');
  await press('down');
  await press('down');
  await press('down');
  await press('down');
  frame = await frameMatching(ui, f => previewed(f) === 'done');
  fake.reply({ chunks: ['Again'], calls: [bash('ls')], delay: 0.3 });
  fake.reply({ chunks: ['end'] });
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('more');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete') && /Assistant\s+end/.test(f) && previewed(f) === 'end');
});

test('Esc while the answer streams: it completes, its calls wait, even allowed ones; Enter runs them', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Look'], calls: [bash('ls')], delay: 0.3 });
  await write('go');
  await frameMatching(ui, f => /Assistant\s+Look/.test(f));
  await escape();
  await frameMatching(ui, f => f.includes('model is responding · stops after this answer'));
  await frameMatching(ui, f => f.includes('stopped – make your changes, Enter goes on'));
  expect(events().filter(e => e.kind === 'Tool Result')).toEqual([]);
  expect(events().find(e => e.kind === 'Assistant')).toEqual({ type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Look' });
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.kind === 'Tool Result')).toHaveLength(1);
});

test('stopped at a call the rules ask for: Enter still asks for approval', async () => {
  await start();
  fake.reply({ chunks: ['Look'], calls: [bash('touch x.txt')], delay: 0.3 });
  await write('go');
  await frameMatching(ui, f => /Assistant\s+Look/.test(f));
  await escape();
  await frameMatching(ui, f => f.includes('stopped – make your changes, Enter goes on'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('Tool Calls await approval'));
});

test('a command running into the timeout ends with ⚠ timeout', async () => {
  const { events } = await asked(['sleep 5'], { timeout: 0.3 });
  await press('y');
  const frame = await frameMatching(ui, f => f.includes('⚠ timeout – review the results'));
  expect(line(frame, /Tool Result/)).toMatch(/⚠ timeout/);
  expect(events().at(-1)).toMatchObject({ content: '[timeout after 0.3 s]', stopped: 'timeout' });
});

test('an answer cut off at max_tokens runs no call; calls that are no bash command are not run', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hm'], calls: [bash('ls')], finish: 'length' });
  await write('go');
  let frame = await frameMatching(ui, f => f.includes('cut off at max_tokens'));
  expect(frame).not.toContain('Tool Call');
  expect(events().at(-2)).toEqual({ type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hm\nbash {"command":"ls"}', cutOff: true });
  fake.reply({ chunks: [], calls: [{ name: 'python', arguments: '{}' }, bash('pwd')] });
  await write('again');
  frame = await frameMatching(ui, f => f.includes('tool call not run: unknown tool python'));
  expect(line(frame, /python/)).toMatch(/Assistant\s+python \{\}/);
  expect(line(frame, /Tool Call/)).toMatch(/Tool Call\s+pwd\s.*\? approve/);
});

test('more rows than fit: rows never overlap, the list follows the selection, Template stays visible', async () => {
  await withUsers(...Array.from({ length: 12 }, (_, i) => `note ${i + 3}`));
  const numbers = (f: string) => [...f.matchAll(/^[ ┃] [ ●] +(\d+) {2}/gm)].map(m => Number(m[1]));
  let frame = ui.captureCharFrame();
  expect(line(frame, /Type/)).toMatch(/^ {5}# {2}Type +Content +Tokens/);
  expect(frame).toMatch(/Template +BOS/);
  let shown = numbers(frame);
  expect(shown.at(-1)).toBe(14);
  expect(shown).toEqual(Array.from({ length: shown.length }, (_, i) => shown[0]! + i));
  expect(shown.length).toBeLessThan(14);
  for (let i = 0; i < 13; i++) await press('up');
  frame = await frameMatching(ui, f => previewed(f) === 'You are an agent.');
  shown = numbers(frame);
  expect(shown[0]).toBe(1);
  expect(line(frame, /System prompt/)).toMatch(/1\s+System\s+System prompt\s+12\b/);
  expect(frame).toMatch(/Template +BOS/);
});

test('the mouse wheel over the block table selects the previous or next block', async () => {
  await withUsers('note 3', 'note 4');
  await frameMatching(ui, f => previewed(f) === 'note 4');
  const y = ui.captureCharFrame().split('\n').findIndex(l => l.includes('note 3'));
  await ui.mockMouse.scroll(10, y, 'up');
  await frameMatching(ui, f => previewed(f) === 'note 3');
  await ui.mockMouse.scroll(10, y, 'down');
  await frameMatching(ui, f => previewed(f) === 'note 4');
});

test('an Assistant block of only whitespace is titled (empty)', async () => {
  await start();
  fake.reply({ chunks: ['\n\n\n'] });
  await write('hi there');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(line(frame, /Assistant/)).toMatch(/Assistant\s+\(empty\)/);
});

test('only whitespace before a call adds no Assistant block', async () => {
  const { events } = await asked(['pwd'], { text: '\n\n\n' });
  expect(ui.captureCharFrame()).not.toMatch(/Assistant/);
  expect(events().filter(e => e.kind === 'Assistant')).toEqual([]);
});

test('e edits the block in $EDITOR: a new Revision flagged ✎2 until sent, the request carries it', async () => {
  const { events } = await withUsers('helo');
  const opened: string[] = [];
  editor = async text => (opened.push(text), 'hello\n');
  await press('e');
  let frame = await frameMatching(ui, f => f.includes('revision 2'));
  expect(opened).toEqual(['helo']);
  expect(line(frame, /User/)).toMatch(/3\s+User\s+hello\s+\d+\s+[●○]?\s+✎2/);
  expect(frame).toContain('edited → revision 2 · u = undo');
  expect(events().at(-1)).toEqual({ type: 'Edit', id: 3, revision: 2, content: 'hello', by: 'user' });
  fake.reply({ chunks: ['hi'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('✎');
  expect((fake.chatRequests[0] as { messages: unknown[] }).messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
});

test('an unchanged save creates no Revision; u undoes an edit', async () => {
  const { events } = await withUsers('keep');
  await press('e');
  await frameMatching(ui, f => f.includes('unchanged – no new Revision'));
  expect(events().some(e => e.type === 'Edit')).toBe(false);
  editor = async () => 'changed';
  await press('e');
  await frameMatching(ui, f => f.includes('revision 2'));
  await press('u');
  const frame = await frameMatching(ui, f => f.includes('undone: edit'));
  expect(line(frame, /3\s+User/)).toMatch(/User\s+keep\s/);
  expect(frame).not.toContain('✎');
});

test('the Tools Block and executed Tool Calls are not opened in $EDITOR', async () => {
  await ran('echo hi');
  const opened: string[] = [];
  editor = async text => (opened.push(text), 'x');
  await press('up');
  await press('up');
  await press('e');
  await frameMatching(ui, f => f.includes('executed Tool Calls are immutable'));
  for (const k of ['up', 'up']) await press(k);
  await frameMatching(ui, f => previewed(f) === '[');
  await press('e');
  await frameMatching(ui, f => f.includes('Tools Block is not editable'));
  expect(opened).toEqual([]);
});

test('a Tool Call awaiting approval is edited; y runs the edited command', async () => {
  const { events } = await asked(['echo wrong']);
  editor = async () => 'echo right\n';
  await press('e');
  let frame = await frameMatching(ui, f => f.includes('revision 2'));
  expect(line(frame, /Tool Call/)).toMatch(/4\s+Tool Call\s+echo right\s+\d+\s+[●○]?\s+✎2 \? approve/);
  fake.reply({ chunks: ['ok'] });
  await press('y');
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().find(e => e.kind === 'Tool Result')).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'right\n[exit 0]', call: 4 });
});

test('allowed calls run without asking; then their results are sent', async () => {
  const { events } = await start();
  fake.reply({ chunks: [], calls: [bash('ls -d .'), bash('git status --short | wc -l')] });
  fake.reply({ chunks: ['ok'] });
  await write('go');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('? approve');
  expect(events().filter(e => e.kind === 'Tool Result').map(e => [e.call, e.content])).toEqual([[4, '.\n[exit 0]'], [5, expect.stringMatching(/\[exit 0\]$/)]]);
  expect(fake.chatRequests).toHaveLength(2);
});

test('a result held back (rejected, denied, killed, timeout) stops the tool loop: Enter sends', async () => {
  await asked(['echo one', 'echo two']);
  await press('n');
  await frameMatching(ui, f => f.includes('? approve –') && /^ask\s+echo two\s/.test(previewed(f)));
  await press('y');
  await frameMatching(ui, f => f.includes('tool loop paused – review the results, Enter sends'));
  expect(fake.chatRequests).toHaveLength(1);
});

test('a denied call is not run: its result says "denied by rule", the next call is still decided', async () => {
  const { events } = await answered(['touch denied.txt', 'echo next'], { global: { 'touch *': 'deny' } });
  const frame = await frameMatching(ui, f => f.includes('⚠ denied by rule: touch denied.txt · ? approve'));
  expect(line(frame, /echo next/)).toMatch(/\? approve/);
  expect(await Bun.file(join(project, 'denied.txt')).exists()).toBe(false);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'denied by rule', call: 4 });
});

test('/auto runs the call awaiting approval at once and every later one a rule asks for; a deny stays; /auto again asks', async () => {
  const { events } = await asked(['touch one.txt', 'touch denied.txt', 'touch two.txt'], { global: { 'touch denied.txt': 'deny' } });
  await write('/auto');
  let frame = await frameMatching(ui, f => f.includes('review the results, Enter sends'));
  expect(frame).toContain('auto-approve on – Tool Calls run without asking, deny rules still apply');
  expect(line(frame, /default/)).toMatch(/default · thinking off · auto-approve +/);
  expect(frame).not.toContain('? approve');
  expect(events().filter(e => e.kind === 'Tool Result').map(e => e.content)).toEqual(['[exit 0]', 'denied by rule', '[exit 0]']);
  expect(await Bun.file(join(project, 'two.txt')).exists()).toBe(true);
  expect(events().filter(e => e.type === 'AllowRuleAdded')).toEqual([]);
  fake.reply({ chunks: [], calls: [bash('touch three.txt')] });
  ui.mockInput.pressEnter();
  fake.reply({ chunks: ['ok'] });
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(await Bun.file(join(project, 'three.txt')).exists()).toBe(true);
  await write('/auto');
  frame = await frameMatching(ui, f => f.includes('auto-approve off'));
  expect(line(frame, /default/)).not.toContain('auto-approve');
  fake.reply({ chunks: [], calls: [bash('touch four.txt')] });
  await write('again');
  await frameMatching(ui, f => f.includes('? approve –'));
  expect(await Bun.file(join(project, 'four.txt')).exists()).toBe(false);
});

test('/auto with nothing awaiting approval only switches it', async () => {
  await start();
  await write('/auto');
  await frameMatching(ui, f => f.includes('auto-approve on'));
  expect(fake.chatRequests).toHaveLength(0);
});

test('the preview of a pending call shows each sub-command with the rule deciding it', async () => {
  await asked(['ls && touch x.txt', 'cat /etc/hostname']);
  const frame = ui.captureCharFrame();
  expect(frame).toMatch(/┃ allow\s+ls\s+built-in rule "ls \*"/);
  expect(frame).toMatch(/┃ ask\s+touch x\.txt\s+no rule → default ask/);
  expect(frame).toContain('┃ a allows "touch *" for this session');
});

test('a logs the session rule the preview shows and runs the call; every later match runs too, then the results are sent', async () => {
  const { events } = await asked(['touch one.txt', 'touch two.txt']);
  expect(ui.captureCharFrame()).toContain('┃ a allows "touch *" for this session');
  fake.reply({ chunks: ['ok'] });
  await press('a');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('? approve');
  expect(events().filter(e => e.type === 'AllowRuleAdded' || e.kind === 'Tool Result').map(e => e.pattern ?? e.content)).toEqual(['touch *', '[exit 0]', '[exit 0]']);
  expect(await Bun.file(join(project, 'two.txt')).exists()).toBe(true);
  expect(fake.chatRequests).toHaveLength(2);
});

test('a is not offered where an argument points outside the project', async () => {
  const { events } = await asked(['cat /etc/hostname']);
  await press('a');
  await frameMatching(ui, f => f.includes('cannot allow for session: argument outside project: /etc/hostname – y runs'));
  expect(events().some(e => e.type === 'AllowRuleAdded')).toBe(false);
});

test('e on a pending call: the new Revision is decided again by the rules', async () => {
  const { events } = await asked(['touch edited.txt']);
  editor = async () => 'ls -d .\n';
  fake.reply({ chunks: ['ok'] });
  await press('e');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().slice(-5, -3)).toEqual([
    { type: 'Edit', id: 4, revision: 2, content: 'ls -d .', by: 'user' },
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: '.\n[exit 0]', call: 4 },
  ]);
});

test('calls pending when the Gate opens are decided by the rules at once', async () => {
  const { events } = await start({ users: ['go'], calls: ['ls -d .', 'touch resumed.txt'] });
  await frameMatching(ui, f => f.includes('? approve –') && /Tool Call\s+touch resumed\.txt.*\? approve/.test(f));
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: '.\n[exit 0]', call: 4 });
});

test('project allow entries are ignored; the Gate says so', async () => {
  await start({ project: { 'touch *': 'allow', 'curl *': 'deny' } });
  expect(ui.captureCharFrame()).toContain('project config: allow "touch *" ignored (project config may only tighten)');
  fake.reply({ chunks: [], calls: [bash('touch project.txt')] });
  await write('go');
  await frameMatching(ui, f => f.includes('? approve –'));
  expect(await Bun.file(join(project, 'project.txt')).exists()).toBe(false);
});

test('an editor that fails leaves the block unchanged', async () => {
  const { events } = await withUsers('keep');
  editor = async () => {
    throw new Error('vi exited with 1');
  };
  await press('e');
  await frameMatching(ui, f => f.includes('✗ editor failed') && f.includes('┃ vi exited with 1 – unchanged'));
  expect(events().some(e => e.type === 'Edit')).toBe(false);
});

test('text selected with the mouse is copied to the clipboard on release', async () => {
  await start();
  const frame = await frameMatching(ui, f => f.includes('You are an agent.'));
  const y = frame.split('\n').findIndex(l => l.includes('You are an agent.'));
  const x = frame.split('\n')[y]!.indexOf('You');
  await ui.mockMouse.drag(x, y, x + 6, y);
  await frameMatching(ui, f => /copied 7 chars/.test(f));
  expect(copied).toEqual(['You are']);
  await ui.mockMouse.click(x, y);
  await ui.flush();
  expect(copied).toEqual(['You are']);
});

test('d removes a Tool Pair as a whole; Space marks it as a whole', async () => {
  const { events } = await ran('echo hi');
  await press('up');
  let frame = await frameMatching(ui, f => /┃ hi\s*$/m.test(f));
  await press(' ');
  frame = await frameMatching(ui, f => /●\s+5\s+Tool Result/.test(f));
  expect(line(frame, /Tool Call/)).toMatch(/●\s+4\s+Tool Call/);
  await press('up');
  await press(' ');
  await frameMatching(ui, f => !/^[ ┃] ●/m.test(f));
  await press('up');
  await press('d');
  frame = await frameMatching(ui, f => f.includes('(whole Tool Pair)'));
  expect(line(frame, /Tool Call/)).toMatch(/^ {8}Tool Call\s+echo hi\s+removed/);
  expect(line(frame, /Tool Result/)).toMatch(/^ {8}Tool Result\s+→ echo hi\s+removed/);
  expect(events().at(-1)).toEqual({ type: 'Remove', id: 5, by: 'user' });
});

test('⌥↑ on a Tool Pair asks; any other key cancels; the same key again turns it into a Note and moves it', async () => {
  const { events } = await ran('echo hi', { text: 'Look.' });
  await press('up');
  await press('up', { meta: true });
  await frameMatching(ui, f => f.includes('press ⌥↑ again to confirm'));
  await press('x');
  await press('up', { meta: true });
  await frameMatching(ui, f => f.includes('press ⌥↑ again to confirm'));
  expect(events().at(-1).type).toBe('ResponseReceived');
  await press('up', { meta: true });
  let frame = await frameMatching(ui, f => /4\s+Note\s+⇄ echo hi.*⇄/.test(f));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 go', '4 ⇄', '5 Look.', '6 ok']);
  expect(frame).not.toContain('Tool Result');
  expect(events().slice(-2)).toEqual([{ type: 'PairToNote', id: 8, call: 5, by: 'user' }, { type: 'Move', id: 8, after: 3, by: 'user' }]);
  fake.reply({ chunks: ['fine'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('fine'));
  expect((fake.chatRequests[2] as Sent).messages.slice(1)).toEqual([
    { role: 'user', content: 'go' },
    { role: 'user', content: '[Tool bash: echo hi]\nhi\n[exit 0]' },
    { role: 'assistant', content: 'Look.' },
    { role: 'assistant', content: 'ok' },
  ]);
});

// Compaction ------------------------------------------------------------------------------------

test('c opens the instruction line with header and the default instruction as hint; Tab copies it, Esc cancels', async () => {
  await withUsers('one', 'two');
  await press('c');
  let frame = await frameMatching(ui, f => /◇ Compact 1 block \(6 tok\) · default · request \d+ \/ 4k/.test(f));
  expect(frame).toContain('instruction > keep the gist');
  expect(frame).toMatch(/enter compact\s+tab default\s+esc back/);
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(' and paths');
  frame = await frameMatching(ui, f => f.includes('instruction > keep the gist and paths'));
  await escape();
  frame = await frameMatching(ui, f => f.includes('compaction cancelled'));
  expect(frame).not.toContain('instruction >');
  expect(fake.chatRequests).toEqual([]);
});

test('the proposal streams at the first source; Enter accepts it as one Note, u restores the sources', async () => {
  const { events } = await withUsers('one', 'two', 'three');
  await press('up');
  await press('up');
  await press(' ');
  await press(' ');
  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 2 blocks'));
  fake.reply({ chunks: ['one', ' and two'], hang: true });
  ui.mockInput.pressEnter();
  let frame = await frameMatching(ui, f => /3\s+Note\s+◇ proposal · 2 blocks/.test(f) && f.includes('one and two'));
  expect(frame).toContain('compacting with default');
  expect(line(frame, /User\s+one/)).toMatch(/◇ proposed/);
  expect(line(frame, /User\s+two/)).toMatch(/◇ proposed/);
  expect(frame).toMatch(/#3 · ◇ proposal · attempt 1 · replaces #4 #5 · "keep the gist"/);
  expect((fake.chatRequests[0] as Sent)).toMatchObject({
    messages: [{ role: 'system' }, { role: 'user', content: '# User\none\n\n# User\ntwo\n\nInstruction: keep the gist' }],
  });
  expect((fake.chatRequests[0] as Sent).tools).toBeUndefined();
  await escape();
  frame = await frameMatching(ui, f => f.includes('compaction aborted – Context unchanged'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two', '5 three']);

  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 2 blocks'));
  fake.reply({ chunks: ['both'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => /◇ 12 → 6 tok \(−50%\) · Context 70 → 64 \/ 4k\s+┃ session cache cold \(same model\/slot\) · cold from #3 after accept/.test(f));
  expect(line(frame, /Note/)).toMatch(/◇ proposal · 2 blocks · att…\s+6\b/);
  expect(frame).toMatch(/enter accept\s+x discard\s+i instruction\s+e edit/);
  await press('d');
  expect(events().at(-1).type).toBe('BlockAdded');
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('◇ accepted: 12 → 6 tok · u = undo'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 ◇', '4 three']);
  frame = await frameMatching(ui, f => /3\s+Note\s+◇ 2 blocks compacted\s+6\b/.test(f));
  expect(frame).not.toContain('●');
  expect(events().at(-1)).toEqual({ type: 'Compact', sources: [3, 4], instruction: 'keep the gist', noteId: 6, content: 'both', by: 'user' });
  await press('u');
  frame = await frameMatching(ui, f => f.includes('undone: compact'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two', '5 three']);
});

test('x discards the proposal; i runs again from the sources with a changed instruction; e edits the proposal', async () => {
  const { events } = await withUsers('one', 'two');
  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 1 block'));
  fake.reply({ chunks: ['first try'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('cold from #4 after accept'));
  await press('x');
  let frame = await frameMatching(ui, f => f.includes('proposal discarded – Context unchanged'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two']);

  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 1 block'));
  await ui.mockInput.typeText('shorter');
  fake.reply({ chunks: ['first try'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('cold from #4 after accept'));
  await press('i');
  frame = await frameMatching(ui, f => f.includes('instruction > shorter'));
  await escape();
  await frameMatching(ui, f => f.includes('attempt 1 ·') && f.includes('enter accept'));
  await press('i');
  await frameMatching(ui, f => f.includes('instruction > shorter'));
  await ui.mockInput.typeText('!');
  fake.reply({ chunks: ['2nd'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('#4 · ◇ proposal · attempt 2 · replaces #5 · "shorter!"') && f.includes('cold from #4'));
  expect((fake.chatRequests.at(-1) as Sent).messages[1]).toEqual({ role: 'user', content: '# User\ntwo\n\nInstruction: shorter!' });
  editor = async text => `${text} edited\n`;
  await press('e');
  frame = await frameMatching(ui, f => f.includes('proposal edited by hand') && f.includes('cold from #4'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('◇ accepted'));
  expect(events().at(-1)).toEqual({ type: 'Compact', sources: [4], instruction: 'shorter!', noteId: 5, content: '2nd edited', by: 'user' });
});

test('a request too big for the compaction window is blocked; Compaction runs on compactionProfile, leaving the session cache', async () => {
  const small = startFakeLlamaCpp({ nCtx: 80 });
  try {
    const backend = await connectLlamaCpp(small.url);
    await start({ compactor: async () => ({ profile: 'small', backend }), users: ['a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(2), 'short'] });
    await press('down');
    await press('down');
    await press('c');
    await frameMatching(ui, f => /◇ Compact 1 block \(\d+ tok\) · small · request \d+ ≥ window 80 – does not fit/.test(f));
    ui.mockInput.pressEnter();
    let frame = await frameMatching(ui, f => /compaction request \d+ ≥ window 80 of small – shrink the selection/.test(f));
    expect(small.chatRequests).toEqual([]);
    await escape();
    await press('down');
    await frameMatching(ui, f => previewed(f) === 'short');
    await press('c');
    frame = await frameMatching(ui, f => /request \d+ \/ 80/.test(f));
    const request = Number(/request (\d+) \/ 80/.exec(frame)![1]);
    small.reply({ chunks: ['s'] });
    ui.mockInput.pressEnter();
    frame = await frameMatching(ui, f => f.includes('session cache untouched'));
    expect(small.chatRequests).toHaveLength(1);
    // The proposal may use the rest of the Compaction profile's window.
    expect(small.chatRequests[0]).toMatchObject({ max_tokens: 80 - request });
    expect(fake.chatRequests).toEqual([]);
  } finally {
    small.stop();
  }
});

// Files, environment and project instructions ---------------------------------------------------------
const messages = (i: number) => (fake.chatRequests[i] as { messages: { role: string; content: string }[] }).messages;

test('@adds a reference row, not sent; e opens the file; on send it becomes a snapshot Note', async () => {
  writeFileSync(join(project, 'notes.txt'), 'one\ntwo\nthree\n');
  const { events } = await start();
  await write('@notes.txt:2-3');
  let frame = await frameMatching(ui, f => f.includes('1 file reference added') && f.includes('@path reference – read at send'));
  expect(line(frame, /@notes/)).toMatch(/3\s+Note\s+@notes\.txt:2-3\s+.*@ read at send/);
  expect(frame).toContain('@path reference – read at send');
  expect(frame).toContain('[notes.txt:2-3]');
  expect(fake.chatRequests).toEqual([]);
  expect(events().at(-1)).toEqual({ type: 'FileReferenced', id: 3, file: 'notes.txt:2-3' });
  ui.mockInput.pressKey('e');
  await frameMatching(ui, f => f.includes('notes.txt – read at send'));
  expect(openedFiles).toEqual(['notes.txt']);
  writeFileSync(join(project, 'notes.txt'), 'one\nTWO\nthree\n');
  fake.reply({ chunks: ['ok'] });
  await write('explain');
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(line(frame, /@notes/)).not.toContain('@ read at send');
  expect(events().slice(4, 6)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'User', origin: 'user', content: 'explain' },
    { type: 'FileRead', id: 3, content: '[notes.txt:2-3]\n2: TWO\n3: three' },
  ]);
  expect(messages(0).slice(1)).toEqual([
    { role: 'user', content: '[notes.txt:2-3]\n2: TWO\n3: three' },
    { role: 'user', content: 'explain' },
  ]);
});

test('an @path is completed from the project files: ↑↓ choose, Tab or Enter complete', async () => {
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'docs/complete-me.md'), 'x\n');
  writeFileSync(join(project, 'complete-too.txt'), 'y\n');
  const { events } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('@compl');
  let frame = await frameMatching(ui, f => f.includes('docs/complete-me.md') && f.includes('complete-too.txt'));
  expect(frame).toContain('↑↓ choose  tab/enter complete  esc back');
  await press('down');
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('┃ @docs/complete-me.md ') && !f.includes('complete-too.txt'));
  expect(events().some(e => e.type === 'FileReferenced')).toBe(false);
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('1 file reference added'));
  expect(events().at(-1)).toEqual({ type: 'FileReferenced', id: 3, file: 'docs/complete-me.md' });
});

test('a referenced file missing at send aborts sending', async () => {
  const { events } = await start();
  await write('@gone.txt what is in it?');
  const frame = await frameMatching(ui, f => f.includes('✗ file not found') && f.includes('gone.txt – sending aborted'));
  expect(line(frame, /@gone/)).toMatch(/3\s+Note\s+@gone\.txt\s+.*⚠ not found/);
  expect(fake.chatRequests).toEqual([]);
  expect(events().map(e => e.type)).not.toContain('RequestSent');
});

test('the environment Note follows the Tools Block; a changed environment is a new Revision in place before sending', async () => {
  const { events } = await start({ notes: { environment: 'date: 2026-09-26' } });
  let frame = ui.captureCharFrame();
  expect(line(frame, /Environment/)).toMatch(/3\s+Note\s+Environment\s+\d+/);
  fake.reply({ chunks: ['ok'] });
  await write('hi');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.type === 'Edit')).toEqual([]);
  environment = 'date: 2026-09-27';
  fake.reply({ chunks: ['ok'] });
  await write('again');
  frame = await frameMatching(ui, f => f.includes('answer complete') && /6\s+User\s+again/.test(f));
  expect(events().filter(e => e.type === 'Edit')).toEqual([{ type: 'Edit', id: 3, revision: 2, content: 'date: 2026-09-27', harness: true }]);
  expect(frame.search(/3\s+Note\s+Environment/)).toBeLessThan(frame.search(/4\s+User\s+hi/));
  expect(messages(1)[1]).toEqual({ role: 'user', content: 'date: 2026-09-27' });
});

test('the project instructions are a Note after the environment', async () => {
  await start({ notes: { environment: 'cwd: /p', instructions: [{ file: 'AGENTS.md', content: '# Rules' }] } });
  const frame = ui.captureCharFrame();
  expect(line(frame, /AGENTS/)).toMatch(/4\s+Note\s+@AGENTS\.md\s+\d+/);
});

test('the Notes a new session starts with ask for no answer', async () => {
  await start({ notes: { environment: 'cwd: /p', instructions: [{ file: 'AGENTS.md', content: '# Rules' }] } });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  expect(fake.chatRequests).toEqual([]);
});

test('a file reference alone whose send failed can be sent again', async () => {
  writeFileSync(join(project, 'again.txt'), 'content');
  await start({ notes: { environment: 'cwd: /p' } });
  await write('@again.txt');
  await frameMatching(ui, f => f.includes('1 file reference added'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('no scripted reply'));
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(messages(0).at(-1)).toEqual({ role: 'user', content: '[again.txt]\ncontent' });
});

test('a file reference alone is sent with Enter, the file as the last user message', async () => {
  writeFileSync(join(project, 'alone.txt'), 'content');
  await start();
  await write('@alone.txt');
  await frameMatching(ui, f => f.includes('1 file reference added'));
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(messages(0).at(-1)).toEqual({ role: 'user', content: '[alone.txt]\ncontent' });
});

// Question (#33) --------------------------------------------------------------------------------------------
const RUNTIME = { question: 'Which runtime should we use?', header: 'Runtime', options: [{ label: 'Node', description: 'common' }, { label: 'Bun', description: 'fast' }], recommended: 'Bun' };
const questionCall = (...questions: object[]) => ({ name: 'question', arguments: JSON.stringify({ questions }) });
// The model answers `go` with a Question; the dock opens.
async function questioned(...questions: object[]) {
  const started = await start({ tools: TOOLS });
  fake.reply({ chunks: [], calls: [questionCall(...questions)] });
  await write('go');
  await frameMatching(ui, f => f.includes('own answer'));
  return started;
}
// The Tool Result the model got for the Question.
const answerSent = () => (fake.chatRequests[1] as Sent).messages.at(-1);
// Moves the dock's cursor `downs` rows down, then Enter picks that row.
async function choose(downs: number) {
  for (let i = 0; i < downs; i++) await press('down');
  ui.mockInput.pressEnter();
  await ui.flush();
}

test('a Question opens the dock: the Recommended Option on top, marked and preselected; Enter answers and sends (#33)', async () => {
  const { events } = await questioned(RUNTIME);
  const frame = ui.captureCharFrame();
  expect((fake.chatRequests[0] as Sent).tools!.map(t => t.function.name)).toEqual(['bash', 'question']);
  expect(line(frame, /Tool Call/)).toMatch(/4\s+Tool Call\s+question Which runtime shou….*\? answer/);
  expect(frame).not.toContain('? approve');
  expect(frame).toContain('Which runtime should we use?');
  expect(line(frame, /› Bun/)).toMatch(/› Bun .*recommended.*fast/);
  expect(line(frame, /┃ +Node/)).toMatch(/^┃ +Node .*common/);
  expect(line(frame, /own answer/)).toMatch(/^┃ +own answer/);
  // The dock takes the prompt band's place: nothing can be written there.
  expect(frame).not.toContain('Tab to write');
  fake.reply({ chunks: ['great'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(ui.captureCharFrame()).not.toContain('own answer');
  expect(events().filter(e => e.kind === 'Tool Result')).toEqual([
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'user', content: 'Which runtime should we use?: Bun', call: 4 },
  ]);
  expect(answerSent()).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'Which runtime should we use?: Bun' });
});

test('↑↓ move, Enter picks; own answer takes free text (#33)', async () => {
  await questioned(RUNTIME);
  fake.reply({ chunks: ['ok'] });
  await choose(1);
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(answerSent()).toMatchObject({ content: 'Which runtime should we use?: Node' });
  ui.renderer.destroy();
  fake.stop();

  await questioned(RUNTIME);
  await press('down');
  await press('down');
  await press('up');
  await press('down');
  await frameMatching(ui, f => /› own answer/.test(f));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer >'));
  await ui.mockInput.typeText('Deno 2');
  // Typed in the own answer's row.
  expect(line(await frameMatching(ui, f => f.includes('Deno 2')), /answer >/)).toMatch(/^┃ +› answer > Deno 2/);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(answerSent()).toMatchObject({ content: 'Which runtime should we use?: Deno 2' });
});

test('a Question without a valid Recommended Option goes back to the model as error; the user never sees it (#33)', async () => {
  const { events } = await start({ tools: TOOLS });
  fake.reply({ chunks: [], calls: [questionCall({ ...RUNTIME, recommended: 'Deno' })] });
  fake.reply({ chunks: ['sorry'] });
  await write('go');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('own answer');
  expect(answerSent()).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'error: question 1: recommended "Deno" is not an option label' });
  expect(events().filter(e => e.kind === 'Tool Result')).toEqual([
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'error: question 1: recommended "Deno" is not an option label', call: 4 },
  ]);
});

test('questions given as a JSON string open the dock like a list', async () => {
  await start({ tools: TOOLS });
  fake.reply({ chunks: [], calls: [{ name: 'question', arguments: JSON.stringify({ questions: JSON.stringify([RUNTIME]) }) }] });
  await write('go');
  expect(await frameMatching(ui, f => f.includes('own answer'))).toContain('Which runtime should we use?');
});

test('a Question the dock cannot show goes back to the model as error, not as a crash', async () => {
  const { events } = await start({ tools: TOOLS });
  fake.reply({ chunks: [], calls: [{ name: 'question', arguments: JSON.stringify({ questions: [{ ...RUNTIME, options: 'Node or Bun' }] }) }] });
  fake.reply({ chunks: ['sorry'] });
  await write('go');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.kind === 'Tool Result')).toEqual([
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'error: question 1: at least 2 options', call: 4 },
  ]);
});

// Question: several questions & multi-select (#34) ------------------------------------------------------------
const LINTERS = {
  question: 'Which linters should run?',
  header: 'Linters',
  options: [{ label: 'ESLint', description: 'plugins' }, { label: 'Biome', description: 'fast' }, { label: 'Oxlint', description: 'faster' }],
  multiple: true,
  recommended: ['Biome', 'Oxlint'],
};

test('several questions: one tab each plus Confirm; `multiple` toggles, its Recommended Options preselected (#34)', async () => {
  await questioned(RUNTIME, LINTERS);
  let frame = ui.captureCharFrame();
  expect(line(frame, /Confirm/)).toMatch(/Runtime.*Linters.*Confirm/);
  expect(line(frame, /› Bun/)).toMatch(/› Bun .*recommended/);
  await choose(0);
  frame = await frameMatching(ui, f => f.includes('[✓]'));
  expect(frame).toContain('Which linters should run?');
  expect(line(frame, /Biome/)).toMatch(/› \[✓\] Biome .*recommended/);
  expect(line(frame, /Oxlint/)).toMatch(/ \[✓\] Oxlint .*recommended/);
  expect(line(frame, /ESLint/)).toMatch(/ \[ \] ESLint/);
  await choose(2);
  await press('up');
  await press('up');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => /\[✓\] ESLint/.test(f) && /\[ \] Biome/.test(f));
  ui.mockInput.pressArrow('right');
  frame = await frameMatching(ui, f => f.includes('enter sends'));
  expect(line(frame, /^┃\s+Runtime/)).toMatch(/Runtime\s+Bun/);
  expect(line(frame, /^┃\s+Linters/)).toMatch(/Linters\s+ESLint, Oxlint/);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(answerSent()).toMatchObject({ content: `${RUNTIME.question}: Bun\nWhich linters should run?: ESLint, Oxlint` });
});

test('skipped questions come back as Unanswered; ←→ switch tabs (#34)', async () => {
  await questioned(RUNTIME, LINTERS);
  ui.mockInput.pressArrow('right');
  await ui.flush();
  await frameMatching(ui, f => f.includes('Which linters should run?'));
  ui.mockInput.pressArrow('left');
  await ui.flush();
  await frameMatching(ui, f => f.includes('Which runtime should we use?'));
  ui.mockInput.pressArrow('right');
  await frameMatching(ui, f => f.includes('Which linters should run?'));
  await choose(0);
  await choose(1);
  ui.mockInput.pressArrow('right');
  await frameMatching(ui, f => f.includes('enter sends'));
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(answerSent()).toMatchObject({ content: `${RUNTIME.question}: Unanswered\nWhich linters should run?: Unanswered` });
});

test('r fills the unanswered questions with their Recommended Options and jumps to Confirm; own answers join the toggles (#34)', async () => {
  await questioned(RUNTIME, LINTERS, { ...RUNTIME, question: 'Which package manager?', header: 'Packages' });
  await choose(1);
  await frameMatching(ui, f => f.includes('Which linters should run?'));
  await choose(3);
  await frameMatching(ui, f => f.includes('answer >'));
  await ui.mockInput.typeText('Prettier');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => /\[✓\] own answer: Prettier/.test(f));
  await press('r');
  const frame = await frameMatching(ui, f => f.includes('enter sends'));
  expect(line(frame, /^┃\s+Packages/)).toMatch(/Packages\s+Bun/);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(answerSent()).toMatchObject({ content: `${RUNTIME.question}: Node\nWhich linters should run?: Biome, Oxlint, Prettier\nWhich package manager?: Bun` });
});

// Question: decline, resume, ordering (#35) --------------------------------------------------------------------
test('Esc declines the Question: its Tool Result says declined, the loop stops at the Gate (#35)', async () => {
  const { events } = await questioned(RUNTIME, LINTERS);
  await escape();
  const frame = await frameMatching(ui, f => f.includes('question declined – review the results, Enter sends'));
  expect(frame).not.toContain('own answer');
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'declined', call: 4 });
});

test('resuming with an unanswered Question reopens the dock, after the earlier calls are decided (#35)', async () => {
  const { events } = await start({ tools: TOOLS, users: ['go'], calls: ['ls -d .', { tool: 'question', content: JSON.stringify({ questions: [RUNTIME] }) }] });
  const frame = await frameMatching(ui, f => f.includes('own answer'));
  expect(line(frame, /› Bun/)).toMatch(/› Bun .*recommended/);
  expect(events().at(-1)).toMatchObject({ kind: 'Tool Result', content: '.\n[exit 0]', call: 4 });
  fake.reply({ chunks: ['ok'] });
  await choose(1);
  await frameMatching(ui, f => f.includes('answer complete'));
  expect((fake.chatRequests[0] as Sent).messages.at(-1)).toMatchObject({ role: 'tool', content: 'Which runtime should we use?: Node' });
});

test('mixed bash and question calls are decided in order: the Question waits for the earlier calls, later ones wait for it (#35)', async () => {
  const { events } = await start({ tools: TOOLS });
  fake.reply({ chunks: [], calls: [bash('touch first.txt'), questionCall(RUNTIME), bash('touch last.txt')] });
  await write('go');
  let frame = await frameMatching(ui, f => /Tool Call\s+touch first\.txt.*\? approve/.test(f));
  expect(frame).not.toContain('own answer');
  await press('y');
  await frameMatching(ui, f => f.includes('own answer'));
  expect(await Bun.file(join(project, 'last.txt')).exists()).toBe(false);
  await choose(0);
  frame = await frameMatching(ui, f => /Tool Call\s+touch last\.txt.*\? approve/.test(f));
  expect(frame).not.toContain('own answer');
  fake.reply({ chunks: ['ok'] });
  await press('y');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.kind === 'Tool Result').map(e => [e.call, e.content])).toEqual([
    [4, '[exit 0]'],
    [5, 'Which runtime should we use?: Bun'],
    [6, '[exit 0]'],
  ]);
});

test('the answer is a normal Context Block: e makes a new Revision; d removes the Tool Pair as a whole (#35)', async () => {
  const { events } = await questioned(RUNTIME);
  fake.reply({ chunks: ['ok'] });
  await choose(1);
  await frameMatching(ui, f => f.includes('answer complete'));
  await press('up');
  await frameMatching(ui, f => f.includes('┃ Tool Result  #5'));
  editor = async () => 'Which runtime should we use?: Deno\n';
  await press('e');
  let frame = await frameMatching(ui, f => f.includes('┃ Which runtime should we use?: Deno'));
  expect(events().at(-1)).toEqual({ type: 'Edit', id: 5, revision: 2, content: 'Which runtime should we use?: Deno', by: 'user' });
  await press('d');
  frame = await frameMatching(ui, f => f.includes('(whole Tool Pair)'));
  expect(line(frame, /Tool Call/)).toMatch(/Tool Call\s+question .*removed/);
  expect(events().at(-1)).toEqual({ type: 'Remove', id: 5, by: 'user' });
});

// Kind Filters: additive, each on or off; a view restriction at the Gate, never logged.
test('/filter <kind> hides blocks of that Kind, again shows them; the line names the hidden ones and the share shown; nothing is logged', async () => {
  const { events } = await withUsers('one', 'two');
  const before = events().length;
  let frame = ui.captureCharFrame();
  expect(frame).not.toContain('hidden:');
  const used = /(\d+) \/ 4k/.exec(frame)![1];
  const users = [line(frame, /User\s+one/), line(frame, /User\s+two/)].map(r => Number(/User\s+\S+\s+(\d+)/.exec(r!)![1]));
  await write('/filter user');
  frame = await frameMatching(ui, f => f.includes('hidden: user'));
  expect(order(frame)).toEqual(['1 System', '2 bash']);
  expect(frame).toContain(`hidden: user · 2/4 blocks · ${Number(used) - users[0]! - users[1]! - 4}/${used} tokens`);
  await write('/filter system');
  frame = await frameMatching(ui, f => f.includes('hidden: system user'));
  expect(frame).toContain('no blocks shown');
  await write('/filter user');
  frame = await frameMatching(ui, f => f.includes('hidden: system ·'));
  expect(order(frame)).toEqual(['3 one', '4 two']);
  expect(events().length).toBe(before);
});

test('by default Tool Calls and their Tool Results are hidden; /filter tool-calls shows them', async () => {
  await ran('echo hi', { hidden: 'default' });
  let frame = await frameMatching(ui, f => f.includes('hidden: tool-calls'));
  expect(frame).toContain('hidden: tool-calls · 4/6 blocks');
  expect(frame).not.toMatch(/Tool (Call|Result)/);
  await write('/filter tool-calls');
  frame = await frameMatching(ui, f => !f.includes('hidden:'));
  expect(line(frame, /Tool Call/)).toMatch(/4\s+Tool Call\s+echo hi/);
  expect(line(frame, /Tool Result/)).toMatch(/5\s+Tool Result\s+→ echo hi/);
});

test('a Tool Call awaiting approval shows while Tool Calls are hidden; y runs it', async () => {
  const { events } = await asked(['echo hello'], { hidden: 'default' });
  let frame = ui.captureCharFrame();
  expect(line(frame, /echo hello/)).toMatch(/^┃ +4\s+Tool Call\s+echo hello .*\? approve/);
  fake.reply({ chunks: ['ok'] });
  await press('y');
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.kind === 'Tool Result').map(e => e.content)).toEqual(['hello\n[exit 0]']);
  expect(frame).not.toMatch(/Tool (Call|Result)/);
});

test('after /filter the Kinds are suggested in glossary order with on/off; all first, only while one is off', async () => {
  await withUsers('one');
  const typing = async (text: string) => {
    ui.mockInput.pressTab();
    await ui.flush();
    await ui.mockInput.typeText(text);
  };
  const suggested = (f: string) => [...f.matchAll(/^ {2}([a-z-]+) +(?:on|off|show all blocks)/gm)].map(m => m[1]);
  await typing('/filter ');
  let frame = await frameMatching(ui, f => f.includes('tool-calls'));
  expect(suggested(frame)).toEqual(['system', 'user', 'thinking', 'assistant', 'tool-calls', 'note']);
  await ui.mockInput.typeText('us');
  frame = await frameMatching(ui, f => !f.includes('tool-calls'));
  expect(suggested(frame)).toEqual(['user']);
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('hidden: user'));
  await typing('/filter t');
  frame = await frameMatching(ui, f => f.includes('tool-calls'));
  expect(suggested(frame)).toEqual(['thinking', 'tool-calls']);
  ui.mockInput.pressBackspace();
  frame = await frameMatching(ui, f => f.includes('  all'));
  expect(suggested(frame)).toEqual(['all', 'system', 'user', 'thinking', 'assistant', 'tool-calls', 'note']);
  expect(line(frame, /^ {2}user /)).toMatch(/off · User/);
});

test('/filter all shows every block again; Esc does not', async () => {
  await withUsers('one', 'two');
  await write('/filter user');
  await write('/filter system');
  await frameMatching(ui, f => f.includes('hidden: system user'));
  await escape();
  let frame = await frameMatching(ui, f => f.includes('hidden: system user'));
  await write('/filter all');
  frame = await frameMatching(ui, f => !f.includes('hidden:'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two']);
});

test('/filter with an unknown Kind is an error listing the values; the filters stay as they were', async () => {
  await withUsers('one');
  await write('/filter User');
  await frameMatching(ui, f => f.includes('hidden: user'));
  await write('/filter foo');
  const frame = await frameMatching(ui, f => f.includes('unknown filter foo'));
  expect(frame).toContain('✗ unknown filter foo');
  expect(frame).toContain('all system user thinking assistant tool-calls note');
  expect(frame).toContain('hidden: user');
});

test('hiding the selected block moves the selection to the next shown one; ↑↓ stay among the shown ones', async () => {
  await withUsers('one', 'two');
  await press('up');
  await press('up');
  await press('up');
  await write('/filter system');
  let frame = await frameMatching(ui, f => f.includes('hidden: system'));
  expect(line(frame, /one/)).toMatch(/^┃ +3\s+User/);
  await press('down');
  await press('down');
  frame = await frameMatching(ui, f => previewed(f) === 'two');
  expect(line(frame, /two/)).toMatch(/^┃ +4\s+User/);
});

test('with every block hidden the table says so and keeps the Template row; d, p and c act on nothing hidden', async () => {
  const { events } = await withUsers('one');
  await write('/filter system');
  await write('/filter user');
  const frame = await frameMatching(ui, f => f.includes('hidden: system user'));
  expect(frame).toContain('no blocks shown');
  expect(frame).toMatch(/Template\s+BOS/);
  expect(frame).not.toMatch(/^┃ [A-Z][\w ]* {2}#\d+/m);
  const before = events().length;
  await press('d');
  await press('p');
  await press('c');
  await ui.flush();
  expect(events().length).toBe(before);
  expect(ui.captureCharFrame()).not.toContain('instruction >');
});

test('⌥↑↓ does not move while blocks are hidden, and its hint is gone; a filter hiding nothing keeps it', async () => {
  const { events } = await withUsers('one', 'two');
  await write('/filter thinking');
  let frame = await frameMatching(ui, f => f.includes('thinking off'));
  expect(frame).not.toContain('hidden:');
  expect(frame).toContain('⌥↑↓ move');
  await write('/filter system');
  frame = await frameMatching(ui, f => f.includes('hidden: system thinking'));
  expect(frame).not.toContain('⌥↑↓ move');
  expect(frame).toContain('e edit');
  const before = events().length;
  await press('up', { meta: true });
  await ui.flush();
  frame = ui.captureCharFrame();
  expect(order(frame)).toEqual(['3 one', '4 two']);
  expect(events().length).toBe(before);
});

test('hiding a Kind clears the marks on its blocks; the others stay marked', async () => {
  await withUsers('one', 'two');
  await press(' ');
  await frameMatching(ui, f => /●\s+4\s+User/.test(f));
  await write('/filter system');
  await frameMatching(ui, f => f.includes('hidden: system'));
  expect(ui.captureCharFrame()).toMatch(/●\s+4\s+User/);
  await write('/filter user');
  await frameMatching(ui, f => f.includes('hidden: system user'));
  await write('/filter all');
  const frame = await frameMatching(ui, f => !f.includes('hidden:'));
  expect(frame).not.toMatch(/^[ ┃] ●/m);
});

test('the proposal of a Compaction stays visible while Notes are hidden', async () => {
  await withUsers('one', 'two');
  await write('/filter note');
  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 1 block'));
  fake.reply({ chunks: ['short'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('enter accept'));
  expect(line(frame, /Note/)).toMatch(/4\s+Note\s+◇ proposal · 1 block/);
  expect(line(frame, /User\s+two/)).toMatch(/◇ proposed/);
  expect(previewed(frame)).toBe('short');
});

test('the filters last across sending: new blocks of a hidden Kind stay hidden', async () => {
  await withUsers('one');
  await write('/filter assistant');
  fake.reply({ chunks: ['fine'] });
  await write('two');
  const frame = await frameMatching(ui, f => f.includes('answer complete') && f.includes('hidden: assistant'));
  expect(frame).toContain('hidden: assistant · 4/5 blocks');
  expect(line(frame, /two/)).toMatch(/^┃ +4\s+User/);
  expect(frame).not.toMatch(/Assistant\s+fine/);
});

test('with only removed blocks shown the table still says none are shown', async () => {
  await withUsers('one');
  await press('d');
  await write('/filter system');
  const frame = await frameMatching(ui, f => f.includes('hidden: system'));
  expect(line(frame, /one/)).toMatch(/User\s+one\s+removed/);
  expect(frame).toContain('no blocks shown');
});

test('/filter alone shows each filter on or off and the values', async () => {
  await withUsers('one');
  await write('/filter note');
  await write('/filter');
  const frame = await frameMatching(ui, f => f.includes('filter: system on'));
  expect(frame.replace(/\s+/g, ' ')).toContain('note off · /filter all system');
  expect(frame).not.toContain('✗');
});

// Question: switch off via Permission Rules (#36) ------------------------------------------------------------
test('a deny rule for question takes it out of the Tools Block; a call anyway is "denied by rule", no dock (#36)', async () => {
  const { events } = await start({ tools: TOOLS, global: { question: 'allow' }, project: { question: 'deny' } });
  expect(events().at(-1)).toEqual({ type: 'Edit', id: 2, revision: 2, content: BASH_TOOLS, harness: true });
  await frameMatching(ui, f => /Tools\s+bash\s/.test(f) && f.includes('52 / 4k'));
  fake.reply({ chunks: [], calls: [questionCall(RUNTIME)] });
  await write('go');
  const frame = await frameMatching(ui, f => f.includes('⚠ denied by rule: question'));
  expect(frame).not.toContain('own answer');
  expect((fake.chatRequests[0] as Sent).tools!.map(t => t.function.name)).toEqual(['bash']);
  expect(events().filter(e => e.kind === 'Tool Result')).toEqual([
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'denied by rule', call: 4 },
  ]);
  await write('/tools question');
  await frameMatching(ui, f => f.includes('question is denied by rule'));
});

test('ask never pauses a Question; a Question still open at a resume is denied once a rule denies it (#36)', async () => {
  await start({ tools: TOOLS, global: { question: 'ask' } });
  fake.reply({ chunks: [], calls: [questionCall(RUNTIME)] });
  await write('go');
  await frameMatching(ui, f => f.includes('own answer'));
  ui.renderer.destroy();
  fake.stop();

  const { events } = await start({ tools: TOOLS, global: { question: 'deny' }, users: ['go'], calls: [{ tool: 'question', content: JSON.stringify({ questions: [RUNTIME] }) }] });
  const frame = await frameMatching(ui, f => f.includes('⚠ denied by rule: question'));
  expect(frame).not.toContain('own answer');
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'denied by rule', call: 4 });
});


// Context Policies (ADR 0001) ---------------------------------------------------------------------------
// A policy returning `passes` in turn, then nothing; `seen`: the block ids of each Context it was called with.
function scripted(name: string, passes: PolicyOperation[][], seen: number[][] = []): Policy {
  let pass = 0;
  return { name, run: context => (seen.push(context.blocks.map(b => b.id)), passes[pass++] ?? []) };
}
async function policyOn(name: string) {
  await write(`/policy ${name}`);
  await frameMatching(ui, f => f.includes(`policy ${name} on`));
}

test('/policy suggests the policies with their description, switches one on and off; the header shows the active one (ADR 0001)', async () => {
  await start({ policies: [{ ...scripted('trail', []), description: 'keeps a trail' }, scripted('tidy', [])] });
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/policy ');
  let frame = await frameMatching(ui, f => f.includes('switch on'));
  expect(line(frame, /trail/)).toMatch(/trail +keeps a trail/);
  expect(line(frame, /tidy/)).toMatch(/tidy +switch on/);
  expect(frame).not.toMatch(/off +no policy/);
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('policy trail on – edits the Context before every request'));
  expect(line(frame, /default/)).toMatch(/default · thinking off · policy trail +52/);
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/policy ');
  frame = await frameMatching(ui, f => f.includes('no policy'));
  expect(frame).toMatch(/trail +active · keeps a trail/);
  await escape();
  await escape();
  await write('/policy');
  await frameMatching(ui, f => f.includes('policy trail · /policy off trail tidy'));
  await write('/policy nope');
  await frameMatching(ui, f => f.includes('unknown policy nope') && f.includes('off trail tidy'));
  await write('/policy off');
  frame = await frameMatching(ui, f => f.includes('policy off'));
  expect(line(frame, /default/)).toMatch(/default · thinking off +52/);
});

test('the active policy edits the Context before the request, attributed to it, until it returns nothing', async () => {
  const seen: number[][] = [];
  const { events } = await start({ users: ['old', 'older'], policies: [scripted('trim', [[{ op: 'remove', id: 3 }], [{ op: 'edit', id: 4, content: 'newer' }]], seen)] });
  await policyOn('trim');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).toContain('trim: 1 User removed, 1 block edited · answer complete');
  expect(seen).toEqual([[1, 2, 3, 4], [1, 2, 4], [1, 2, 4]]);
  expect(events().slice(5, 7)).toEqual([{ type: 'Remove', id: 3, by: 'trim' }, { type: 'Edit', id: 4, revision: 2, content: 'newer', by: 'trim' }]);
  expect(JSON.stringify(fake.chatRequests[0])).not.toContain('old');
});

test('the policy runs before every request, the follow-ups of the tool loop too; an undone operation comes back', async () => {
  const seen: number[][] = [];
  const again: Policy = { name: 'drop', run: context => (seen.push([]), context.blocks.filter(b => b.kind === 'User' && b.content === 'drop me').map(b => ({ op: 'remove', id: b.id }))) };
  const { events } = await start({ users: ['drop me'], policies: [again] });
  await policyOn('drop');
  fake.reply({ chunks: [], calls: [bash('ls -d .')] });
  fake.reply({ chunks: ['ok'] });
  await write('go');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(fake.chatRequests).toHaveLength(2);
  expect(seen).toHaveLength(3);
  await press('u');
  await frameMatching(ui, f => f.includes('undone: remove'));
  fake.reply({ chunks: ['again'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('drop: 1 User removed · answer complete'));
  expect(events().filter(e => e.type === 'Remove')).toEqual([{ type: 'Remove', id: 3, by: 'drop' }, { type: 'Remove', id: 3, by: 'drop' }]);
});

test('a policy that throws, or still changes the Context after 8 passes, stops the Gate: nothing is sent', async () => {
  const boom: Policy = { name: 'boom', run: () => { throw new Error('bad rule'); } };
  const endless: Policy = { name: 'endless', run: context => [{ op: 'edit', id: 3, content: `${context.blocks.find(b => b.id === 3)!.content}!` }] };
  const { events } = await start({ users: ['hi'], policies: [boom, endless] });
  await policyOn('boom');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('✗ policy boom') && f.includes('failed: bad rule – not sent'));
  await policyOn('endless');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('✗ policy endless') && f.includes('still changing the Context after 8 passes – not sent · endless: 8 blocks'));
  expect(fake.chatRequests).toHaveLength(0);
  expect(events().filter(e => e.type === 'RequestSent')).toEqual([]);
  expect(events().filter(e => e.type === 'Edit').at(-1)).toMatchObject({ content: 'hi!!!!!!!!', by: 'endless' });
});

test('an operation the rules refuse stops the Gate and names it', async () => {
  await start({ users: ['hi'], policies: [scripted('bad', [[{ op: 'remove', id: 1 }]])] });
  await policyOn('bad');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('✗ policy bad') && f.includes('remove 1: System prompt cannot be removed – not sent'));
  expect(fake.chatRequests).toHaveLength(0);
});

test('a policy compacts: the Compaction runs without review, its Note is attributed; the request follows', async () => {
  const { events } = await start({ users: ['a', 'b', 'c'], policies: [scripted('squash', [[{ op: 'compact', sources: [3, 4], instruction: 'merge' }]])] });
  await policyOn('squash');
  fake.reply({ chunks: ['a and b'] });
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).toContain('squash: 2 User → 1 Note · answer complete');
  expect(events().find(e => e.type === 'Compact')).toEqual({ type: 'Compact', sources: [3, 4], instruction: 'merge', noteId: 6, content: 'a and b', by: 'squash' });
  expect(fake.chatRequests).toHaveLength(2);
  expect(JSON.stringify(fake.chatRequests[0])).toContain('Instruction: merge');
  expect(JSON.stringify(fake.chatRequests[1])).toContain('a and b');
});

test('a policy Compaction that writes nothing stops the Gate: nothing is sent', async () => {
  const { events } = await start({ users: ['a', 'b'], policies: [scripted('squash', [[{ op: 'compact', sources: [3], instruction: 'merge' }]])] });
  await policyOn('squash');
  fake.reply({ chunks: [' '] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('✗ policy squash') && f.includes('compact 3: compaction failed: empty Note – not sent'));
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().some(e => e.type === 'Compact' || e.type === 'RequestSent')).toBe(false);
});

test('a policy Compaction runs on compactionProfile; too big for its window, cut off or aborted, it stops the Gate', async () => {
  const small = startFakeLlamaCpp({ nCtx: 80 });
  try {
    const backend = await connectLlamaCpp(small.url);
    const long = 'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(2);
    const squash = (id: number): Policy => ({ name: `squash${id}`, run: c => (c.blocks.some(b => b.id === id) ? [{ op: 'compact', sources: [id], instruction: 'merge' }] : []) });
    const { events } = await start({ compactor: async () => ({ profile: 'small', backend }), users: [long, 'short'], policies: [squash(3), squash(4)] });
    await policyOn('squash3');
    ui.mockInput.pressEnter();
    await frameMatching(ui, f => /compact 3: compaction failed: request \d+ ≥ window 80/.test(f));
    await policyOn('squash4');
    small.reply({ chunks: ['cut'], finish: 'length' });
    ui.mockInput.pressEnter();
    await frameMatching(ui, f => f.includes('compaction failed: cut off at max_tokens – not sent'));
    small.reply({ chunks: ['wait'], hang: true });
    ui.mockInput.pressEnter();
    await frameMatching(ui, f => /[\u2800-\u28ff] policy squash4 running/.test(f));
    await escape();
    await frameMatching(ui, f => f.includes('compaction failed: aborted – not sent'));
    small.reply({ chunks: ['brief'] });
    fake.reply({ chunks: ['ok'] });
    ui.mockInput.pressEnter();
    await frameMatching(ui, f => f.includes('squash4: 1 User → 1 Note · answer complete'));
    expect(small.chatRequests).toHaveLength(3);
    expect(fake.chatRequests).toHaveLength(1);
    expect(events().find(e => e.type === 'Compact')).toMatchObject({ sources: [4], content: 'brief', by: 'squash4' });
  } finally {
    small.stop();
  }
});

test('a request failing after the policy ran still says what the policy did', async () => {
  await start({ users: ['old', 'new'], policies: [scripted('trim', [[{ op: 'remove', id: 3 }]])] });
  await policyOn('trim');
  fake.reply({ chunks: [], error: 'server overloaded' });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('backend error') && f.includes('trim: 1 User removed'));
});

// Git as the Gate sees it: branches main and feature/x, busy in another worktree; switching, the worktree and reopening are recorded.
function fakeGit() {
  const calls: string[] = [];
  let current = 'main';
  let dirty = false;
  let branchChanged = () => {};
  let dirtyChanged = () => {};
  // Another tool switches the branch.
  const switchOutside = (name: string) => ((current = name), branchChanged());
  // Another tool dirties or cleans the working tree.
  const dirtyOutside = (d: boolean) => ((dirty = d), dirtyChanged());
  const git: NonNullable<GateOptions['git']> = {
    branches: () => ({ current, all: ['busy', 'feature/x', 'main'], elsewhere: { busy: '/p/.resector/worktrees/ses_other' } }),
    status: () => dirty,
    switchBranch: name => {
      if (name === 'dirty') throw new Error('error: your local changes would be overwritten');
      calls.push(`switch ${name}`);
      current = name;
    },
    watch: onChange => ((branchChanged = dirtyChanged = onChange), () => (branchChanged = dirtyChanged = () => {})),
    worktree: on => {
      if (current === 'locked') throw new Error("fatal: '/p/.resector/worktrees/ses_test' is a missing but locked worktree");
      calls.push(`worktree ${on}`);
      return on ? '/p/.resector/worktrees/ses_test' : '/p';
    },
    reopen: notice => void calls.push(`reopen ${notice.text}`),
  };
  return { git, calls, switchOutside, dirtyOutside };
}

test('outside a git repository the /git: commands are neither offered nor run', async () => {
  await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/');
  const frame = await frameMatching(ui, f => f.includes('/sessions'));
  expect(frame).not.toContain('/git:');
  await escape();
  await escape();
  await write('/git:branch');
  await frameMatching(ui, f => f.includes('unknown command /git:branch'));
});

test('/git:branch shows the branch, suggests the others, marks those in another worktree and switches to one; the header shows it', async () => {
  const { git, calls } = fakeGit();
  await start({ git });
  expect(line(ui.captureCharFrame(), /default/)).toMatch(/default · thinking off · ⎇ main +52/);
  await write('/git:branch');
  await frameMatching(ui, f => f.includes('branch main · /git:branch busy feature/x'));
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/git:branch ');
  const frame = await frameMatching(ui, f => f.includes('switch to'));
  expect(line(frame, /feature\/x/)).toMatch(/feature\/x +switch to/);
  expect(line(frame, /main +current/)).toBeDefined();
  expect(line(frame, /busy/)).toMatch(/busy +in worktree ses_other/);
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('switched to branch feature/x') && /thinking off · ⎇ feature\/x/.test(f));
  expect(calls).toEqual(['switch feature/x']);
  await write('/git:branch dirty');
  await frameMatching(ui, f => f.includes('your local changes would be overwritten'));
});

test('a branch switched by another tool shows in the header', async () => {
  const { git, switchOutside } = fakeGit();
  await start({ git });
  switchOutside('feature/x');
  await frameMatching(ui, f => /thinking off · ⎇ feature\/x/.test(f));
});

test('a dirty working tree shows a star in the header, and its change outside the Gate follows', async () => {
  const { git, dirtyOutside } = fakeGit();
  await start({ git });
  expect(line(ui.captureCharFrame(), /default/)).toMatch(/⎇ main +52/);
  dirtyOutside(true);
  await frameMatching(ui, f => /⎇ main\*/.test(f));
  dirtyOutside(false);
  await frameMatching(ui, f => /⎇ main +52/.test(f) && !f.includes('⎇ main*'));
});

test('/git:worktree on prepares the worktree, logs the switch and reopens the Gate there', async () => {
  const { git, calls } = fakeGit();
  const { events } = await start({ git });
  await write('/git:worktree');
  await frameMatching(ui, f => f.includes('worktree off · runs in') && f.includes('/git:worktree on'));
  await write('/git:worktree maybe');
  await frameMatching(ui, f => f.includes('unknown value maybe') && f.includes('/git:worktree on off'));
  await write('/git:worktree on');
  await frameMatching(ui, f => f.includes('worktree · ') || f.includes('· worktree'));
  expect(calls).toEqual(['worktree true', 'reopen worktree on – session runs in /p/.resector/worktrees/ses_test']);
  expect(events().at(-1)).toEqual({ type: 'WorktreeSet', on: true });
  await write('/git:worktree on');
  await frameMatching(ui, f => f.includes('worktree already on'));
});

test('/git:worktree on that git refuses shows the git message and stays in the project', async () => {
  const { git, calls, switchOutside } = fakeGit();
  const { events } = await start({ git });
  switchOutside('locked');
  await write('/git:worktree on');
  await frameMatching(ui, f => f.includes('missing but locked worktree'));
  expect(calls).toEqual([]);
  expect(events().some(e => e.type === 'WorktreeSet')).toBe(false);
});

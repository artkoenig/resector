// Gate test harness: the Review Gate without a renderer, on a scripted backend and runner and a stub view.
import { createRoot, createSignal } from 'solid-js';
import { BASH_TOOLS, withTools } from '../../test/requests';
import { permissionRules, type Permissions, type Split } from '../core/approval/approval';
import type { Config } from '../core/config/config';
import { subagentRefusal } from '../core/config/subagent';
import type { ChatResult } from '../core/tools/answer';
import type { BackgroundEnd, SessionEvent, Thinking, Tool } from '../core/log/events';
import type { Policy } from '../core/policy/policy';
import type { Request } from '../core/render/native';
import { newSession } from '../core/session/session';
import type { RawCall } from '../core/tools/call';
import type { RunResult } from '../core/tools/call';
import { createGate, type Compactor, type Gate, type View } from '.';
import type { Skill } from '../core/skills/skills';
import { minimalView } from './minimal-view';
import type { Backend, Background, RunOptions, Runner, Subagents } from './ports';

// One simple command per line, its words as arguments: enough for the rules to decide.
const split: Split = command => command.split('\n').map(text => ({ text, args: text.split(' ').slice(1), writes: [] }));

export const bash = (command: string): RawCall => ({ name: 'bash', arguments: JSON.stringify({ command }) });
// A call starting a Subagent.
export const subagent = (prompt: string): RawCall => ({ name: 'subagent', arguments: JSON.stringify({ prompt }) });
// A bash call to run as a Background Process.
export const background = (command: string): RawCall => ({ name: 'bash', arguments: JSON.stringify({ command, background: true }) });

// An answer of the scripted backend. It streams `thinking` and `content`, then ends after `delay` ms, or hangs until
// aborted; aborted, it keeps what streamed. error: the request fails.
export type Reply = Partial<ChatResult> & { hang?: boolean; delay?: number; error?: string };

// The tests decide approval as a strict config does: a global "*" ask over the built-in "*" allow, read-only commands
// allowed; the test's own global rules come after.
const READ_ONLY = ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'sed -n', 'git status', 'git diff', 'git log', 'git show'];
const ASK_ALL = (global: Permissions = {}): Permissions =>
  ({ '*': 'ask', ...Object.fromEntries(READ_ONLY.map(c => [`${c} *`, 'allow' as const])), ...global });

// A backend answering the replies in order; each block counts `perBlock` tokens, each count takes `countDelay` ms.
// sent: each chat request with its options.
export function scriptedBackend({ window = 4096, exact = true, perBlock = 10, countDelay = 0, thinkingModes }: { window?: number; exact?: boolean; perBlock?: number; countDelay?: number; thinkingModes?: Thinking[] | null } = {}) {
  const replies: Reply[] = [];
  const sent: { request: Request; maxTokens?: number }[] = [];
  const backend: Backend = {
    window,
    exact,
    thinkingModes,
    count: async prefixes => (countDelay && (await Bun.sleep(countDelay)), { total: prefixes.length * perBlock, blocks: prefixes.map(() => perBlock), template: 0, cached: { tokens: 0, exact: true } }),
    chat: async (request, options) => {
      sent.push({ request, maxTokens: options.maxTokens });
      const { hang, delay, error, ...reply } = replies.shift() ?? {};
      if (error) throw new Error(error);
      const result = answer(reply);
      stream(result, options);
      const stopped = await abortedWithin(options.signal, hang ? Infinity : (delay ?? 0));
      return stopped ? { ...result, calls: [], finish: 'aborted' } : result;
    },
  };
  return { backend, sent, reply: (...more: Reply[]) => void replies.push(...more) };
}

const answer = ({ calls = [], ...reply }: Partial<ChatResult>): ChatResult =>
  ({ thinking: '', content: '', calls, finish: calls.length ? 'tool_calls' : 'stop', usage: null, cached: null, predicted: null, ...reply });

// The first token comes at once: the delay is generation.
const stream = (result: ChatResult, options: Parameters<Backend['chat']>[1]) => {
  options.onToken?.();
  if (result.thinking) options.onThinking?.(result.thinking);
  if (result.content) options.onDelta(result.content);
};

// Whether the signal aborts within `ms`; at once when `ms` is 0.
const abortedWithin = (signal: AbortSignal, ms: number) =>
  new Promise<boolean>(resolve => {
    if (!ms) return resolve(false);
    if (ms !== Infinity) setTimeout(() => resolve(false), ms);
    signal.addEventListener('abort', () => resolve(true));
  });

// Runs a command: it prints `ran <command>`, or its entry of `results`; a `slow` one takes 20 ms, a `hang` one
// prints `partial` and runs until killed. With background it keeps running: `started <command>`, pid 4242.
export function scriptedRunner({ timeout = 120, slow = [] as string[], hang = [] as string[], results = {} as Record<string, RunResult> } = {}) {
  const ran: string[] = [];
  const run = async (command: string, { signal, onOutput, background }: RunOptions): Promise<RunResult> => {
    ran.push(command);
    if (results[command]) return results[command];
    if (background) return { output: `started ${command}\n`, exit: null, stopped: null, background: { pid: 4242, log: '/home/background/4242.log' } };
    if (!hang.includes(command) && !slow.includes(command)) return { output: `ran ${command}\n`, exit: 0, stopped: null };
    if (hang.includes(command)) onOutput('partial\n');
    const killed = await abortedWithin(signal, slow.includes(command) ? 20 : Infinity);
    return killed ? { output: 'partial\n', exit: null, stopped: 'killed' } : { output: `ran ${command}\n`, exit: 0, stopped: null };
  };
  return { runner: { timeout, run }, ran };
}

// Background Processes the test ends: exit(pid, end) tells the Gate one's process group is empty; logs: their log
// files by path; stopped: the pids the Gate asked to stop.
export function scriptedBackground() {
  const listeners = new Set<(pid: number, end: BackgroundEnd) => void>();
  const logs = new Map<string, string>();
  const stopped: number[] = [];
  const background: Background = {
    stop: pid => void stopped.push(pid),
    log: path => logs.get(path) ?? null,
    onExit: listener => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return { background, logs, stopped, exit: (pid: number, end: BackgroundEnd) => listeners.forEach(l => l(pid, end)) };
}

// users: User blocks in the Session Log, not yet sent; calls: pending Tool Calls after them, as at a resume; logged:
// events after them (e.g. a Background Process's start and exit).
// global, project: permission rules of the config. files: the project's files for @path references.
export type GateSetup = {
  users?: string[];
  calls?: (string | { tool: Tool; content: string })[];
  tools?: string;
  global?: Permissions;
  project?: Permissions;
  policies?: Policy[];
  compactor?: Compactor;
  files?: Record<string, string>;
  editor?: (text: string) => Promise<string>;
  runner?: Parameters<typeof scriptedRunner>[0];
  skills?: Skill[];
  logged?: SessionEvent[];
  subagent?: Config['subagent'];
  // false: the Session runs outside a git repository.
  repository?: boolean;
} & Parameters<typeof scriptedBackend>[0];

// The Gate on the minimal view: rows are the blocks sent next, the selection follows. focused: the blocks the Gate
// moved the selection to. events: the Session Log as appended.
export function gateWith(setup: GateSetup = {}) {
  const { users = [], calls = [], tools = BASH_TOOLS, global, project, policies = [], compactor, files = {}, editor = async text => text, skills } = setup;
  const { backend, sent, reply } = scriptedBackend(setup);
  const { runner, ran } = scriptedRunner(setup.runner);
  const { background, logs, stopped, exit } = scriptedBackground();
  const opening = withTools(newSession('default', 'You are an agent.'), tools);
  const first = opening.length;
  const events: SessionEvent[] = [
    ...opening,
    ...users.map((content, i) => ({ type: 'BlockAdded' as const, id: first + i, kind: 'User' as const, origin: 'user' as const, content })),
    ...calls.map((call, i) => ({ type: 'BlockAdded' as const, id: first + users.length + i, kind: 'Tool Call' as const, origin: 'model' as const, ...(typeof call === 'string' ? { content: call } : call) })),
    ...(setup.logged ?? []),
  ];
  const logged: SessionEvent[] = [...events];
  const focused: number[] = [];
  const [active, setActive] = createSignal<Policy | null>(null);
  const [autoOn, setAutoOn] = createSignal(false);
  const searcher = { timeout: 30, run: async (query: string) => ({ output: `results for ${query}\n`, exit: 0, stopped: null }) };
  // Starts no process: the prompts of the Subagents asked for, pids from 4343; a worktree is named after the pid.
  const prompts: string[] = [];
  const subagents: Subagents = {
    timeout: 0,
    refused: (running, worktree) => subagentRefusal({ profiles: {}, subagent: setup.subagent }, running, { worktree, repository: setup.repository ?? true }),
    run: async (prompt, { worktree }) => {
      const pid = 4342 + prompts.push(prompt);
      const made = worktree && { worktree: { path: `/home/worktrees/ses_${pid}`, branch: `resector/ses_${pid}`, base: 'abc' } };
      return { output: '', exit: null, stopped: null, background: { pid, log: `/home/background/${pid}.log`, ...made } };
    },
  };
  let selection: View;
  const gate = createRoot(() => createGate({
    backend, runner, searcher, subagents, events, log: { append: e => void logged.push(e) }, editor, clipboard: async () => {},
    approval: { split, root: '/project', permissions: () => permissionRules(ASK_ALL(global), project) },
    project: {
      read: path => files[path] ?? null,
      isText: path => path in files && !files[path]!.includes('\0'),
      // An image's copy is named after its path; sent as its name behind a data URL prefix.
      images: { exists: path => path in files, save: path => (path in files ? `copy-${path}` : null), load: image => `data:${image}` },
      list: () => Object.keys(files),
      environment: () => '',
      open: async () => {},
    },
    instruction: () => 'keep the gist',
    compactor: async () => compactor ?? null,
    policies: { all: policies, active, set: setActive },
    autoApprove: { on: autoOn, set: setAutoOn },
    openSessions: () => {}, skills, background,
  }, k => (selection = minimalView(k, id => focused.push(id)))));
  const select = (id: number) => selection.setSelected(id);
  const mark = (...ids: number[]) => selection.setMarked(new Set(ids));
  return { gate, sent, reply, ran, prompts, focused, events: logged, select, selected: () => selection.selected(), mark, exit, logs, stopped };
}

// Until the Gate is idle: no answer streaming, no call running, no policy or Compaction under way.
export async function settled(gate: Gate) {
  for (let quiet = 0, i = 0; quiet < 3 && i < 2000; i++) {
    await Bun.sleep(gate.busy() ? 1 : 0);
    quiet = gate.busy() ? 0 : quiet + 1;
  }
}

// Until `condition` holds.
export async function until(condition: () => boolean) {
  for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(1);
  if (!condition()) throw new Error('condition never held');
}

// The events of one type, or with one Kind.
export const ofType = (events: SessionEvent[], type: SessionEvent['type']) => events.filter(e => e.type === type);
export const results = (events: SessionEvent[]) => events.filter(e => e.type === 'BlockAdded' && e.kind === 'Tool Result') as Extract<SessionEvent, { type: 'BlockAdded' }>[];

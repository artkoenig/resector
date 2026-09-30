// Review Gate tests without a renderer: the request cycle against fake ports and a stub view.
import { expect, test } from 'bun:test';
import { createRoot, createSignal } from 'solid-js';
import { BASH_TOOLS, withTools } from '../../test/requests';
import { permissionRules, type Split } from '../core/approval/approval';
import type { Backend, ChatResult } from '../core/backend';
import type { SessionEvent } from '../core/log/events';
import type { Request } from '../core/render/native';
import { newSession } from '../core/session/session';
import type { RawCall } from '../core/tools/call';
import type { Runner } from '../core/tools/runner';
import { createGate, type Kernel, type View } from '.';

const answer = (content: string, calls: RawCall[] = []): ChatResult =>
  ({ thinking: '', content, calls, finish: calls.length ? 'tool_calls' : 'stop', usage: null, cached: null, predicted: null });
const bash = (command: string): RawCall => ({ name: 'bash', arguments: JSON.stringify({ command }) });
// One simple command per line: enough for the rules to decide.
const split: Split = command => command.split('\n').map(text => ({ text, args: text.split(' ').slice(1), writes: [] }));

// The Gate without a renderer: a backend answering in order, a runner echoing the command, a view that only
// follows. focused: the blocks the Gate moved the selection to.
function gateWith(answers: ChatResult[]) {
  const requests: Request[] = [];
  const ran: string[] = [];
  const backend: Backend = {
    window: 4096,
    exact: true,
    count: async prefixes => ({ total: prefixes.length, blocks: prefixes.map(() => 1), template: 0, cached: { tokens: 0, exact: true } }),
    chat: async request => (requests.push(request), answers.shift()!),
  };
  const runner: Runner = { timeout: 5, run: async command => (ran.push(command), { output: `ran ${command}\n`, exit: 0, stopped: null }) };
  const events: SessionEvent[] = withTools(newSession('default', 'You are an agent.'), BASH_TOOLS);
  const focused: number[] = [];
  const view = (k: Kernel): View => {
    const [selected, setSelected] = createSignal(1);
    const [marked, setMarked] = createSignal<ReadonlySet<number>>(new Set());
    const rows = () => k.sent().map(b => b.id);
    return {
      rows, shown: rows, hiding: () => false, selected, setSelected, marked, setMarked,
      selectedBlock: () => k.sent().find(b => b.id === selected()),
      selectAt: i => setSelected(rows()[i] ?? selected()),
      keepSelection: () => {},
      follow: id => void (focused.push(id), setSelected(id)),
      release: () => {},
      filterBy: () => {},
    };
  };
  const gate = createRoot(() => createGate({
    backend, runner, searcher: runner, events, log: { append: () => {} }, editor: async text => text, clipboard: async () => {},
    approval: { split, root: '/project', permissions: () => permissionRules(undefined, undefined) },
    project: { read: () => null, list: () => [], environment: () => '', open: async () => {} },
    openSessions: () => {},
  }, view));
  return { gate, requests, ran, focused };
}

const settled = async (gate: ReturnType<typeof createGate>) => {
  for (let i = 0; i < 100 && (gate.busy() || gate.nextCall()); i++) await Bun.sleep(1);
};

test('a user message is sent and the answer becomes an Assistant block, which the selection follows', async () => {
  const { gate, requests, focused } = gateWith([answer('hello')]);
  gate.submit('hi');
  await settled(gate);
  expect(JSON.stringify(requests[0]!.messages.at(-1))).toContain('hi');
  const last = gate.context().blocks.at(-1)!;
  expect(last).toMatchObject({ kind: 'Assistant', content: 'hello' });
  expect(focused).toContain(last.id);
});

test('an allowed Tool Call runs and its result is sent at once; the loop ends with an answer without calls', async () => {
  const { gate, requests, ran } = gateWith([answer('', [bash('ls')]), answer('done')]);
  gate.submit('list the files');
  await settled(gate);
  expect(ran).toEqual(['ls']);
  expect(JSON.stringify(requests[1]!.messages)).toContain('ran ls');
  expect(gate.context().blocks.at(-1)).toMatchObject({ kind: 'Assistant', content: 'done' });
});

test('a Tool Call the rules ask for holds the loop until approved', async () => {
  const { gate, requests, ran } = gateWith([answer('', [bash('rm x')]), answer('removed')]);
  gate.submit('remove x');
  await Bun.sleep(5);
  expect(gate.nextCall()).toMatchObject({ kind: 'Tool Call', pending: true });
  expect(ran).toEqual([]);
  expect(requests).toHaveLength(1);
  gate.approve();
  await settled(gate);
  expect(ran).toEqual(['rm x']);
  expect(gate.context().blocks.at(-1)).toMatchObject({ kind: 'Assistant', content: 'removed' });
});

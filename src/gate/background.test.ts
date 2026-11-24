// Background Process tests without a renderer: starting one, its exit Note and what it sends, the log, the kill.
import { expect, test } from 'bun:test';
import type { Policy } from '../core/policy/policy';
import { TOOLS } from '../core/tools/catalog';
import { background, bash, gateWith, settled, until, type GateSetup, type Reply } from './gate.harness';

test('a bash call with background runs as a Background Process: its result says it runs, BackgroundStarted is logged', async () => {
  const g = gateWith({ global: { '*': 'allow' } });
  g.reply({ calls: [background('serve')] }, { content: 'up' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.events.filter(e => e.type === 'BlockAdded' && e.id >= 4 || e.type === 'BackgroundStarted').slice(0, 3)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Tool Call', origin: 'model', content: 'serve', background: true },
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'started serve\n[running in the background: pid 4242 · log /home/background/4242.log · stop: kill -- -4242]', call: 4 },
    { type: 'BackgroundStarted', call: 4, pid: 4242, log: '/home/background/4242.log' },
  ]);
});

test('a bash call without background runs in the foreground, nothing else logged', async () => {
  const g = gateWith({ global: { '*': 'allow' } });
  g.reply({ calls: [bash('ls')] }, { content: 'ok' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.events.some(e => e.type === 'BackgroundStarted')).toBe(false);
});

const NOTE = 'Background Process pid 4242 ended: exited with 0\ncommand: serve\nlog: /home/background/4242.log';
const notes = (g: ReturnType<typeof gateWith>) => g.events.filter(e => e.type === 'BlockAdded' && e.origin === 'background') as { id: number; content: string }[];
const carriesNote = (g: ReturnType<typeof gateWith>, i: number) => g.sent[i]!.request.messages.some(m => m.content === NOTE);
// At rest after a Background Process was started and the answer `up`.
async function atRest(setup: GateSetup = {}, ...replies: Reply[]) {
  const g = gateWith({ global: { '*': 'allow' }, ...setup });
  g.reply({ calls: [background('serve')] }, { content: 'up' }, ...replies);
  g.gate.submit('go');
  await settled(g.gate);
  return g;
}

test('a Background Process ending while the Session is at rest logs BackgroundExited and its exit Note, sent at once; no Note twice', async () => {
  const g = await atRest({}, { content: 'ok' }, { content: 'fine' });
  const before = g.events.length;
  g.exit(4242, { exit: 0 });
  // Before the request is even counted.
  expect(g.events.slice(before)).toEqual([
    { type: 'BackgroundExited', call: 4, exit: 0 },
    { type: 'BlockAdded', id: 7, kind: 'Note', origin: 'background', content: NOTE, exited: 4 },
  ]);
  await settled(g.gate);
  expect(g.sent).toHaveLength(3);
  expect(carriesNote(g, 2)).toBe(true);
  expect(g.gate.status()?.text).toBe('answer complete');
  g.gate.submit('and now?');
  await settled(g.gate);
  expect(notes(g)).toHaveLength(1);
});

test('two Background Processes ending shortly after each other: one Note each, the later one goes with the next request', async () => {
  const call = (id: number, content: string) => ({ type: 'BlockAdded' as const, id, kind: 'Tool Call' as const, origin: 'model' as const, content, background: true as const });
  const result = (id: number, c: number) => ({ type: 'BlockAdded' as const, id, kind: 'Tool Result' as const, origin: 'tool' as const, content: 'started', call: c });
  const g = gateWith({
    logged: [
      call(3, 'serve'), result(4, 3), { type: 'BackgroundStarted', call: 3, pid: 10, log: '/l/10.log' },
      call(5, 'watch'), result(6, 5), { type: 'BackgroundStarted', call: 5, pid: 11, log: '/l/11.log' },
      { type: 'BlockAdded', id: 7, kind: 'Assistant', origin: 'model', content: 'up' },
    ],
  });
  g.reply({ content: 'ok' }, { content: 'fine' });
  g.exit(10, { exit: 0 });
  g.exit(11, { exit: 1 });
  await settled(g.gate);
  expect(g.sent).toHaveLength(1);
  expect(notes(g)).toHaveLength(2);
  expect(JSON.stringify(g.sent[0]!.request)).not.toContain('pid 11 ended');
  g.gate.submit('go on');
  await settled(g.gate);
  expect(JSON.stringify(g.sent[1]!.request)).toContain('pid 11 ended');
});

test('ending while an answer streams: the Note comes after the answer, nothing extra is sent, the next request carries it', async () => {
  const g = await atRest({}, { content: 'hm', delay: 20 }, { content: 'ok' });
  g.gate.submit('what is up?');
  await until(() => g.gate.streaming()?.text === 'hm');
  g.exit(4242, { exit: 0 });
  expect(notes(g)).toEqual([]);
  await settled(g.gate);
  expect(g.sent).toHaveLength(3);
  expect(g.events.slice(-2)).toMatchObject([{ type: 'ResponseReceived' }, { kind: 'Note', exited: 4 }]);
  // Not answered yet: Enter alone sends it.
  await g.gate.send();
  await settled(g.gate);
  expect(carriesNote(g, 3)).toBe(true);
  expect(notes(g)).toHaveLength(1);
});

test('ending while a request fails: the Note is there, nothing extra is sent', async () => {
  const g = await atRest({ countDelay: 20 }, { error: 'down' });
  g.gate.submit('what is up?');
  await until(() => g.gate.streaming() !== null);
  g.exit(4242, { exit: 0 });
  await settled(g.gate);
  expect(g.sent).toHaveLength(3);
  expect(notes(g)).toHaveLength(1);
  expect(g.gate.status()?.text).toContain('backend error');
});

test('ending while a call runs: the Note is there at once, the Tool Loop’s next request carries it, the selection stays on the call’s output', async () => {
  const g = await atRest({ runner: { slow: ['build'] } }, { calls: [bash('build')] }, { content: 'done' });
  g.gate.submit('build it');
  await until(() => g.gate.running() !== null);
  g.exit(4242, { exit: 0 });
  expect(notes(g)).toMatchObject([{ id: 9 }]);
  expect(g.gate.running()).not.toBeNull();
  expect(g.selected()).toBe(10);
  await settled(g.gate);
  expect(g.sent).toHaveLength(4);
  expect(carriesNote(g, 3)).toBe(true);
});

test('ending while the Tool Loop is held: the Note, no request; it goes with the next one', async () => {
  const g = await atRest({ runner: { hang: ['build'] } }, { calls: [bash('build')] }, { content: 'ok' });
  g.gate.submit('build it');
  await until(() => g.gate.running()?.output === 'partial\n');
  g.gate.abort();
  g.gate.abort();
  await settled(g.gate);
  expect(g.gate.status()?.text).toContain('Enter sends');
  g.exit(4242, { exit: 0 });
  await settled(g.gate);
  expect(g.sent).toHaveLength(3);
  expect(notes(g)).toHaveLength(1);
  await g.gate.send();
  await settled(g.gate);
  expect(carriesNote(g, 3)).toBe(true);
});

test('ending after Esc stopped the Tool Loop before the next call: the Note, the call is not run', async () => {
  const g = await atRest({}, { calls: [bash('ls')], delay: 20 });
  g.gate.submit('look');
  await until(() => g.gate.streaming() !== null);
  g.gate.abort();
  await settled(g.gate);
  g.exit(4242, { exit: 0 });
  await settled(g.gate);
  expect(g.ran).toEqual(['serve']);
  expect(g.sent).toHaveLength(3);
  expect(notes(g)).toHaveLength(1);
});

const waiting: [string, Reply][] = [
  ['a Tool Call awaits approval', { calls: [bash('rm x')] }],
  ['a Question is open', { calls: [{ name: 'question', arguments: JSON.stringify({ questions: [{ question: 'A or B?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], recommended: 'A' }] }) }] }],
];
for (const [what, reply] of waiting)
  test(`ending while ${what}: the Note, no request, the selection and the status stay`, async () => {
    const g = await atRest({ global: { '*': 'allow', 'rm *': 'ask' }, tools: TOOLS }, reply);
    g.gate.submit('next');
    await settled(g.gate);
    const status = g.gate.status()?.text;
    g.exit(4242, { exit: 0 });
    await settled(g.gate);
    expect(g.gate.nextCall()).toBeDefined();
    expect(g.sent).toHaveLength(3);
    expect(notes(g)).toHaveLength(1);
    expect(g.selected()).toBe(g.gate.nextCall()!.id);
    expect(g.gate.status()?.text).toBe(status!);
  });

test('ending with a Context too big to send: the Note, no request, the status says why', async () => {
  const g = await atRest({ perBlock: 600 });
  g.reply({ content: 'ok' });
  await until(() => g.gate.split() !== null);
  const sent = g.sent.length;
  g.exit(4242, { exit: 0 });
  await settled(g.gate);
  expect(notes(g)).toHaveLength(1);
  expect(g.sent).toHaveLength(sent);
  expect(g.gate.status()?.text).toContain('sending blocked');
});

test('ending with a reference to a missing file not sent yet: the Note, no request', async () => {
  const g = gateWith({
    logged: [
      { type: 'BlockAdded', id: 3, kind: 'Tool Call', origin: 'model', content: 'serve', background: true }, { type: 'BlockAdded', id: 4, kind: 'Tool Result', origin: 'tool', content: 'started', call: 3 },
      { type: 'BackgroundStarted', call: 3, pid: 10, log: '/l/10.log' },
      { type: 'BlockAdded', id: 5, kind: 'User', origin: 'user', content: 'see @gone.ts' }, { type: 'FileReferenced', id: 6, file: 'gone.ts' },
    ],
  });
  g.exit(10, { exit: 0 });
  await settled(g.gate);
  expect(notes(g)).toHaveLength(1);
  expect(g.sent).toHaveLength(0);
  expect(g.gate.status()?.text).toContain('sending aborted');
});

test('the active Context Policy runs before the request an exit Note sends, as before any', async () => {
  const seen: string[] = [];
  const watch: Policy = { name: 'watch', run: context => (seen.push(context.blocks.at(-1)!.content), []) };
  const g = await atRest({ policies: [watch] }, { content: 'ok' });
  g.gate.submit('/policy watch');
  g.exit(4242, { exit: 0 });
  await settled(g.gate);
  expect(seen[0]).toBe(NOTE);
  expect(g.sent).toHaveLength(3);
});

test('ending while the Context Policy runs before a request: the Note goes with that request', async () => {
  const slow: Policy = { name: 'slow', run: async () => (await Bun.sleep(10), []) };
  const g = await atRest({ policies: [slow] }, { content: 'ok' });
  g.gate.submit('/policy slow');
  g.gate.submit('what is up?');
  await until(() => g.gate.policing() !== null);
  g.exit(4242, { exit: 0 });
  expect(notes(g)).toEqual([]);
  await settled(g.gate);
  expect(g.sent).toHaveLength(3);
  expect(carriesNote(g, 2)).toBe(true);
  expect(notes(g)).toHaveLength(1);
});

test('ending during the user’s Compaction: the Note comes once it is over, nothing is sent', async () => {
  const g = await atRest();
  g.select(6);
  g.gate.startCompaction();
  await until(() => g.gate.compacting() !== null);
  g.exit(4242, { exit: 0 });
  await settled(g.gate);
  expect(notes(g)).toEqual([]);
  g.gate.leaveInstruction();
  await settled(g.gate);
  expect(notes(g)).toHaveLength(1);
  expect(g.sent).toHaveLength(2);
});

const heldCall = [
  { type: 'BlockAdded', id: 3, kind: 'Tool Call', origin: 'model', content: 'serve', background: true }, { type: 'BlockAdded', id: 4, kind: 'Tool Result', origin: 'tool', content: 'started', call: 3 },
  { type: 'BackgroundStarted', call: 3, pid: 10, log: '/l/10.log' },
] satisfies GateSetup['logged'];

test('ending after the Session was opened again with results unsent: the Note, no request', async () => {
  const g = gateWith({ logged: heldCall });
  g.exit(10, { exit: 0 });
  await settled(g.gate);
  expect(notes(g)).toHaveLength(1);
  expect(g.sent).toHaveLength(0);
});

test('ending after Esc cancelled the request of the Tool Loop: the Note, no request', async () => {
  const g = await atRest({ countDelay: 20, runner: { slow: ['build'] } }, { calls: [bash('build')] });
  g.gate.submit('build it');
  await until(() => g.events.some(e => e.type === 'BlockAdded' && e.id === 9) && g.gate.streaming() !== null);
  g.gate.abort();
  g.gate.abort();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('send cancelled');
  g.exit(4242, { exit: 0 });
  await settled(g.gate);
  expect(g.sent).toHaveLength(3);
  expect(notes(g)).toHaveLength(1);
});

test('an exit logged while no Gate was open: its Note is there when the Session is opened, Enter sends it', async () => {
  const g = gateWith({ logged: [...heldCall, { type: 'BlockAdded', id: 5, kind: 'Assistant', origin: 'model', content: 'up' }, { type: 'ResponseReceived', usage: null, cached: null }, { type: 'BackgroundExited', call: 3, exit: 0 }] });
  g.reply({ content: 'ok' });
  await settled(g.gate);
  expect(notes(g)).toHaveLength(1);
  expect(g.sent).toHaveLength(0);
  await g.gate.send();
  await settled(g.gate);
  expect(g.sent).toHaveLength(1);
});

test('one the session’s end stopped gets no Note and no request now: after a resume', async () => {
  const g = await atRest();
  g.exit(4242, { signal: 'session ended' });
  await settled(g.gate);
  expect(notes(g)).toEqual([]);
  expect(g.sent).toHaveLength(2);
});

test('in a Headless Run the Note goes with the Tool Loop’s next request, else none is added', async () => {
  const g = gateWith({ global: { '*': 'allow' }, runner: { slow: ['build'] } });
  g.reply({ calls: [background('serve')] }, { calls: [bash('build')] }, { content: 'done' });
  const run = g.gate.run({ prompt: 'go' });
  await until(() => g.gate.running()?.call.content === 'build');
  g.exit(4242, { exit: 0 });
  expect(notes(g)).toEqual([]);
  expect((await run).turns).toBe(3);
  expect(carriesNote(g, 2)).toBe(true);
});

test('a Background Process ending after the Headless Run’s answer sends nothing', async () => {
  const g = gateWith({ global: { '*': 'allow' } });
  g.reply({ calls: [background('serve')] }, { content: 'up' });
  await g.gate.run({ prompt: 'go' });
  g.exit(4242, { exit: 0 });
  await settled(g.gate);
  expect(g.sent).toHaveLength(2);
});

test('an exit with no Background Process running under its pid is not logged', async () => {
  const g = gateWith({ global: { '*': 'allow' } });
  g.exit(4242, { exit: 0 });
  expect(g.events.some(e => e.type === 'BackgroundExited')).toBe(false);
});

test('a resumed Session gets a Note for every logged exit without one, whatever ended it', async () => {
  const call = (id: number, content: string) => ({ type: 'BlockAdded' as const, id, kind: 'Tool Call' as const, origin: 'model' as const, content, background: true as const });
  const result = (id: number, c: number) => ({ type: 'BlockAdded' as const, id, kind: 'Tool Result' as const, origin: 'tool' as const, content: 'started', call: c });
  const g = gateWith({
    logged: [
      call(3, 'serve'), result(4, 3), { type: 'BackgroundStarted', call: 3, pid: 10, log: '/l/10.log' }, { type: 'BackgroundExited', call: 3, signal: 'user' },
      call(5, 'watch'), result(6, 5), { type: 'BackgroundStarted', call: 5, pid: 11, log: '/l/11.log' }, { type: 'BackgroundExited', call: 5, signal: 'session ended' },
    ],
  });
  g.reply({ content: 'ok' });
  g.gate.submit('go on');
  await settled(g.gate);
  expect(g.events.filter(e => e.type === 'BlockAdded' && e.origin === 'background').map(e => (e as { content: string }).content.split('\n')[0])).toEqual([
    'Background Process pid 10 ended: stopped by the user',
    'Background Process pid 11 ended: stopped when the session ended',
  ]);
});

test('the log of a Tool Pair’s Background Process: by its call or result, while it runs and after', async () => {
  const g = gateWith({ global: { '*': 'allow' } });
  g.reply({ calls: [background('serve')] }, { content: 'up' });
  g.gate.submit('go');
  await settled(g.gate);
  g.logs.set('/home/background/4242.log', 'listening\n');
  const log = { path: '/home/background/4242.log', text: 'listening\n', running: true };
  expect(g.gate.backgroundLog(4)).toEqual(log);
  expect(g.gate.backgroundLog(5)).toEqual(log);
  g.exit(4242, { exit: 0 });
  expect(g.gate.backgroundLog(5)).toEqual({ ...log, running: false });
  // Not a Background Process's pair; a log that is gone.
  expect(g.gate.backgroundLog(3)).toBeNull();
  g.logs.clear();
  expect(g.gate.backgroundLog(5)).toBeNull();
});

test('killing the selected Tool Pair’s running Background Process stops it; its exit is logged as the user’s, the Note says so', async () => {
  const g = gateWith({ global: { '*': 'allow' } });
  g.reply({ calls: [background('serve')] }, { content: 'up' }, { content: 'ok' });
  g.gate.submit('go');
  await settled(g.gate);
  // Not a Background Process's pair.
  g.select(3);
  expect(g.gate.killable()).toBe(false);
  g.gate.killBackground();
  expect(g.stopped).toEqual([]);
  // By its result as by its call.
  g.select(5);
  expect(g.gate.killable()).toBe(true);
  g.select(4);
  expect(g.gate.killable()).toBe(true);
  g.gate.killBackground();
  expect(g.stopped).toEqual([4242]);
  g.exit(4242, { signal: 'user' });
  expect(g.events.slice(-2)).toMatchObject([{ type: 'BackgroundExited', call: 4, signal: 'user' }, { kind: 'Note', exited: 4 }]);
  // The user knows: nothing is sent for it.
  await settled(g.gate);
  expect(g.sent).toHaveLength(2);
  // Ended: nothing left to kill.
  expect(g.gate.killable()).toBe(false);
  g.gate.killBackground();
  expect(g.stopped).toEqual([4242]);
  g.gate.submit('still up?');
  await settled(g.gate);
  expect(g.events.filter(e => e.type === 'BlockAdded' && e.origin === 'background').map(e => (e as { content: string }).content.split('\n')[0])).toEqual([
    'Background Process pid 4242 ended: stopped by the user',
  ]);
});

test('a Background Process is killed while another call runs', async () => {
  const g = gateWith({ global: { '*': 'allow' }, runner: { slow: ['build'] } });
  g.reply({ calls: [background('serve')] }, { calls: [bash('build')] }, { content: 'done' });
  g.gate.submit('go');
  while (!g.gate.running()) await Bun.sleep(1);
  g.select(4);
  g.gate.killBackground();
  expect(g.stopped).toEqual([4242]);
  await settled(g.gate);
});

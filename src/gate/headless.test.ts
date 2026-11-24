// Headless Run tests without a renderer: the outcome of a run, holds going on, turns, the Terminal.
import { expect, test } from 'bun:test';
import { TOOLS } from '../core/tools/catalog';
import type { Policy } from '../core/policy/policy';
import { bash, gateWith, results } from './gate.harness';
import type { Terminal } from './ports';

const QUESTION = { question: 'Which one?', header: 'pick', options: [{ label: 'a', description: 'A' }, { label: 'b', description: 'B' }], recommended: 'a' };
const question = { name: 'question', arguments: JSON.stringify({ questions: [QUESTION] }) };
// The Tool Results of the run, in order.
const resultTexts = (g: ReturnType<typeof gateWith>) => results(g.events).map(e => e.content);

// A terminal answering approvals in turn; asked: the commands it was asked about.
function terminal(choices: Awaited<ReturnType<Terminal['approve']>>[], answers: string[][] | null = null) {
  const asked: string[] = [];
  const t: Terminal = {
    approve: async call => (asked.push(call.content), choices.shift()!),
    answer: async () => answers,
  };
  return { t, asked };
}

test('an answer without calls ends the run with its text after one turn', async () => {
  const g = gateWith();
  g.reply({ content: 'hello there' });
  expect(await g.gate.run({ prompt: 'hi' })).toEqual({ kind: 'answer', text: 'hello there', turns: 1, tokens: 30 });
});

test('a Hold does not stop the run: results of calls rejected, denied by rule or stopped go back to the model', async () => {
  const g = gateWith({ global: { 'rm *': 'deny', 'sleep *': 'allow' }, runner: { results: { 'sleep 9': { output: '', exit: null, stopped: 'timeout' } } } });
  const { t } = terminal(['reject']);
  g.reply({ calls: [bash('touch x'), bash('rm y'), bash('sleep 9')] }, { content: 'done' });
  expect(await g.gate.run({ prompt: 'go', terminal: t })).toMatchObject({ kind: 'answer', text: 'done', turns: 2 });
  expect(resultTexts(g)).toEqual(['rejected by user', 'denied by rule', expect.stringContaining('timeout')]);
});

test('a run ends after maxTurns requests', async () => {
  const g = gateWith({ global: { 'ls *': 'allow' } });
  g.reply({ calls: [bash('ls a')] }, { calls: [bash('ls b')] }, { content: 'never' });
  expect(await g.gate.run({ prompt: 'go', maxTurns: 2 })).toMatchObject({ kind: 'max-turns', turns: 2 });
  expect(g.sent).toHaveLength(2);
});

test('a policy sending on counts as a turn, its Compaction does not', async () => {
  const onward: Policy = {
    name: 'onward',
    run: c => (c.blocks.some(b => b.kind === 'Assistant') && !c.blocks.some(b => b.content === 'go on') ? [{ op: 'note', after: c.blocks.at(-1)!.id, content: 'go on' }, { op: 'send' }] : []),
  };
  const squash: Policy = { name: 'squash', run: c => (c.blocks.some(b => b.content === 'old') ? [{ op: 'compact', sources: [3], instruction: 'merge' }] : []) };
  const sent = gateWith({ policies: [onward] });
  sent.gate.submit('/policy onward');
  sent.reply({ content: 'first' }, { content: 'second' });
  expect(await sent.gate.run({ prompt: 'hi' })).toMatchObject({ kind: 'answer', text: 'second', turns: 2 });
  const compacted = gateWith({ users: ['old'], policies: [squash] });
  compacted.gate.submit('/policy squash');
  compacted.reply({ content: 'the gist' }, { content: 'ok' });
  expect(await compacted.gate.run({ prompt: 'hi' })).toMatchObject({ kind: 'answer', text: 'ok', turns: 1 });
  expect(compacted.sent).toHaveLength(2);
});

test('an error ends the run with the Gate\'s status text: backend gone, file missing, no budget, policy failed', async () => {
  const backend = gateWith();
  backend.reply({ error: 'connection refused' });
  expect(await backend.gate.run({ prompt: 'hi' })).toEqual({ kind: 'error', text: 'backend error: connection refused', turns: 1, tokens: 30 });
  const file = gateWith();
  expect(await file.gate.run({ prompt: '@gone.txt read it' })).toMatchObject({ kind: 'error', text: expect.stringContaining('sending aborted') });
  const budget = gateWith({ window: 30 });
  expect(await budget.gate.run({ prompt: 'hi' })).toMatchObject({ kind: 'error', text: expect.stringMatching(/^over by/) });
  const policy = gateWith({ policies: [{ name: 'boom', run: () => { throw new Error('bad rule'); } }] });
  policy.gate.submit('/policy boom');
  expect(await policy.gate.run({ prompt: 'hi' })).toMatchObject({ kind: 'error', text: 'policy boom: failed: bad rule – not sent' });
  expect([backend, file, budget, policy].map(g => g.sent.length)).toEqual([1, 0, 0, 0]);
});

test('an abort stops the streaming answer or the running call and ends the run', async () => {
  const streaming = gateWith();
  streaming.reply({ content: 'part', hang: true });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 10);
  expect(await streaming.gate.run({ prompt: 'hi', signal: stop.signal })).toMatchObject({ kind: 'aborted', turns: 1 });
  const running = gateWith({ global: { 'sleep *': 'allow' }, runner: { hang: ['sleep 9'] } });
  running.reply({ calls: [bash('sleep 9')] }, { content: 'never' });
  const kill = new AbortController();
  setTimeout(() => kill.abort(), 10);
  expect(await running.gate.run({ prompt: 'go', signal: kill.signal })).toMatchObject({ kind: 'aborted', turns: 1 });
  expect(resultTexts(running)).toEqual([expect.stringContaining('killed')]);
  expect(running.sent).toHaveLength(1);
});

test('after an abort no further call runs or is asked about, and a terminal still asking is left', async () => {
  const g = gateWith({ global: { 'sleep *': 'allow', 'ls *': 'allow' }, runner: { hang: ['sleep 9'] } });
  const { t, asked } = terminal(['once']);
  g.reply({ calls: [bash('sleep 9'), bash('ls a'), bash('touch x')] }, { content: 'never' });
  const kill = new AbortController();
  setTimeout(() => kill.abort(), 10);
  expect(await g.gate.run({ prompt: 'go', signal: kill.signal, terminal: t })).toMatchObject({ kind: 'aborted' });
  expect([g.ran, asked]).toEqual([['sleep 9'], []]);
  const waiting = gateWith();
  const silent: Terminal = { approve: () => new Promise(() => {}), answer: () => new Promise(() => {}) };
  waiting.reply({ calls: [bash('touch x')] }, { content: 'never' });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 10);
  expect(await waiting.gate.run({ prompt: 'go', signal: stop.signal, terminal: silent })).toMatchObject({ kind: 'aborted', turns: 1 });
  expect(waiting.ran).toEqual([]);
});

test('without a terminal a Question is declined and a call the rules ask for is not run; the run goes on', async () => {
  const g = gateWith({ tools: TOOLS });
  g.reply({ calls: [question] }, { calls: [bash('touch x')] }, { content: 'done' });
  expect(await g.gate.run({ prompt: 'go' })).toMatchObject({ kind: 'answer', text: 'done', turns: 3 });
  expect(resultTexts(g)).toEqual(['declined', 'no user to approve']);
  expect(g.ran).toEqual([]);
});

test('with Auto-approve a call the rules ask for runs without asking; a deny rule still denies', async () => {
  const g = gateWith({ global: { 'rm *': 'deny' } });
  const { t, asked } = terminal([]);
  g.gate.submit('/auto');
  g.reply({ calls: [bash('touch x'), bash('rm y')] }, { content: 'done' });
  expect(await g.gate.run({ prompt: 'go', terminal: t })).toMatchObject({ kind: 'answer', turns: 2 });
  expect(asked).toEqual([]);
  expect(resultTexts(g)).toEqual(['ran touch x\n[exit 0]', 'denied by rule']);
});

test('the terminal approves once or for the session, and answers a Question', async () => {
  const g = gateWith({ tools: TOOLS });
  const { t, asked } = terminal(['once', 'session'], [['b']]);
  g.reply({ calls: [bash('touch x'), bash('touch y')] }, { calls: [question, bash('touch z')] }, { content: 'done' });
  expect(await g.gate.run({ prompt: 'go', terminal: t })).toMatchObject({ kind: 'answer', text: 'done', turns: 3 });
  // touch z is allowed for the session by then.
  expect(asked).toEqual(['touch x', 'touch y']);
  expect(g.ran).toEqual(['touch x', 'touch y', 'touch z']);
  expect(resultTexts(g)[2]).toBe('Which one?: b');
});

test('a call that cannot be allowed for the session runs once when the terminal allows it for the session', async () => {
  const g = gateWith();
  const { t } = terminal(['session']);
  g.reply({ calls: [bash('cat /etc/hostname')] }, { content: 'done' });
  expect(await g.gate.run({ prompt: 'go', terminal: t })).toMatchObject({ kind: 'answer', text: 'done', turns: 2 });
  expect(g.ran).toEqual(['cat /etc/hostname']);
});

const SUMMARY = { prompt: '/sum it up @all' };

test('a summary is asked for after the answer: prompt and answer logged, not counted as a turn', async () => {
  const g = gateWith();
  g.reply({ content: 'hello' }, { content: 'said hello' });
  const asking: number[] = [];
  const outcome = await g.gate.run({ prompt: 'hi', summary: { ...SUMMARY, asking: () => asking.push(g.sent.length) } });
  expect(outcome).toEqual({ kind: 'answer', text: 'hello', turns: 1, tokens: expect.any(Number), summary: { text: 'said hello' } });
  expect(asking).toEqual([1]);
  expect(g.sent).toHaveLength(2);
  const logged = g.events.slice(g.events.findIndex(e => e.type === 'BlockAdded' && e.content === SUMMARY.prompt));
  expect(logged[0]).toMatchObject({ kind: 'User', origin: 'user' });
  expect(logged).toContainEqual(expect.objectContaining({ kind: 'Assistant', content: 'said hello' }));
});

test('without it nothing more is sent', async () => {
  const g = gateWith();
  g.reply({ content: 'hello' }, { content: 'never' });
  expect(await g.gate.run({ prompt: 'hi' })).not.toHaveProperty('summary');
  expect(g.sent).toHaveLength(1);
});

test('at max turns the summary request still goes; its calls are not run, its text counts', async () => {
  const g = gateWith({ tools: TOOLS, global: { 'ls *': 'allow' } });
  g.reply({ calls: [bash('ls a')] }, { content: 'looked', calls: [bash('ls b'), question] }, { content: 'never' });
  expect(await g.gate.run({ prompt: 'go', maxTurns: 1, summary: SUMMARY })).toMatchObject({ kind: 'max-turns', turns: 1, summary: { text: 'looked' } });
  expect(g.ran).toEqual(['ls a']);
  expect(g.sent).toHaveLength(2);
  expect(resultTexts(g).slice(1)).toEqual(['not run: the run has ended', 'not run: the run has ended']);
});

test('no policy sends on after the summary', async () => {
  const onward: Policy = {
    name: 'onward',
    run: c => (c.blocks.some(b => b.kind === 'Assistant' && b.content === 'the summary') ? [{ op: 'note', after: c.blocks.at(-1)!.id, content: 'go on' }, { op: 'send' }] : []),
  };
  const g = gateWith({ policies: [onward] });
  g.gate.submit('/policy onward');
  g.reply({ content: 'hello' }, { content: 'the summary' }, { content: 'never' });
  expect(await g.gate.run({ prompt: 'hi', summary: SUMMARY })).toMatchObject({ turns: 1, summary: { text: 'the summary' } });
  expect(g.sent).toHaveLength(2);
});

test('no summary after an error; one that fails or stays empty says why, the Outcome stays', async () => {
  const error = gateWith();
  error.reply({ error: 'gone' }, { content: 'never' });
  expect(await error.gate.run({ prompt: 'hi', summary: SUMMARY })).toMatchObject({ kind: 'error', text: 'backend error: gone' });
  expect(error.sent).toHaveLength(1);
  const failing = gateWith();
  failing.reply({ content: 'hello' }, { error: 'gone' });
  expect(await failing.gate.run({ prompt: 'hi', summary: SUMMARY })).toMatchObject({ kind: 'answer', turns: 1, summary: { error: 'backend error: gone' } });
  const empty = gateWith({ tools: TOOLS });
  empty.reply({ content: 'hello' }, { calls: [bash('ls')] });
  expect(await empty.gate.run({ prompt: 'hi', summary: SUMMARY })).toMatchObject({ kind: 'answer', summary: { error: 'the model wrote none' } });
});

test('aborted during the run or the summary request there is no summary', async () => {
  const during = gateWith();
  during.reply({ content: 'part', hang: true }, { content: 'never' });
  const first = new AbortController();
  setTimeout(() => first.abort(), 10);
  expect(await during.gate.run({ prompt: 'hi', signal: first.signal, summary: SUMMARY })).not.toHaveProperty('summary');
  expect(during.sent).toHaveLength(1);
  const g = gateWith();
  g.reply({ content: 'hello' }, { content: 'part', hang: true });
  const stop = new AbortController();
  const run = g.gate.run({ prompt: 'hi', signal: stop.signal, summary: { ...SUMMARY, asking: () => setTimeout(() => stop.abort(), 10) } });
  expect(await run).toEqual({ kind: 'aborted', text: '', turns: 1, tokens: expect.any(Number) });
});

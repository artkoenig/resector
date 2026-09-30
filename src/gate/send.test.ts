// Send tests without a renderer: the request, max_tokens and the budget, streaming, aborting, thinking.
import { expect, test } from 'bun:test';
import { gateWith, settled, until } from './gate.harness';

const messages = (g: ReturnType<typeof gateWith>, i: number) => g.sent[i]!.request.messages.map(m => m.content);

test('a User message is added and sent; the answer becomes an Assistant block, logged when complete, which the selection follows', async () => {
  const g = gateWith();
  g.reply({ content: 'Hello world', usage: { prompt_tokens: 24, completion_tokens: 2 }, cached: 16 });
  g.gate.submit('hi there');
  await settled(g.gate);
  expect(g.events.slice(3)).toEqual([
    { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'hi there' },
    { type: 'RequestSent', hash: expect.any(String), tokens: 30 },
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hello world' },
    { type: 'ResponseReceived', usage: { prompt_tokens: 24, completion_tokens: 2 }, cached: 16 },
  ]);
  expect(messages(g, 0)).toEqual(['You are an agent.', 'hi there']);
  expect(g.focused).toContain(4);
  expect(g.gate.status()?.text).toBe('answer complete');
});

test('every request sends max_tokens = window − Context: no answer reserve', async () => {
  const g = gateWith({ users: ['hi'] });
  g.reply({ content: 'ok' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.sent[0]!.maxTokens).toBe(4096 - 30);
});

test('a Context as big as the window blocks sending; removing a block makes room', async () => {
  const g = gateWith({ window: 40, users: ['long', 'short'] });
  await until(() => g.gate.budget() !== null);
  await g.gate.send();
  expect(g.gate.status()?.text).toBe('over by 1 – sending blocked · d remove · e edit · c compact');
  expect(g.sent).toEqual([]);
  g.select(3);
  g.gate.remove();
  g.reply({ content: 'ok' });
  await until(() => g.gate.budget()?.maxTokens === 10);
  await g.gate.send();
  await settled(g.gate);
  expect(g.sent[0]!.maxTokens).toBe(10);
});

test('a User message on a full window stays, the status says why, nothing is sent', async () => {
  const g = gateWith({ window: 30, users: ['long'] });
  g.gate.submit('more');
  await settled(g.gate);
  expect(g.events.at(-1)).toMatchObject({ type: 'BlockAdded', kind: 'User', content: 'more' });
  expect(g.gate.status()?.text).toContain('sending blocked');
  expect(g.sent).toEqual([]);
});

test('an empty User message adds nothing and sends nothing', async () => {
  const g = gateWith();
  g.gate.submit('   ');
  await settled(g.gate);
  expect(g.events).toHaveLength(3);
  expect(g.sent).toEqual([]);
});

test('Esc stops after the answer, Esc again aborts it: the partial answer is kept as cut off', async () => {
  const g = gateWith();
  g.reply({ content: 'Hal', hang: true });
  g.gate.submit('hi there');
  await until(() => g.gate.streaming()?.text === 'Hal');
  expect(g.events.at(-1)!.type).toBe('RequestSent');
  g.gate.abort();
  expect(g.gate.stopping()).toBe(true);
  g.gate.abort();
  await settled(g.gate);
  expect(g.events.slice(-2)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hal', cutOff: true },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
  expect(g.gate.status()?.text).toBe('⚠ aborted – partial answer kept (cut off)');
});

test('reasoning is logged as a Thinking block before the answer', async () => {
  const g = gateWith();
  g.reply({ thinking: 'plan it', content: 'hello' });
  g.gate.submit('hi there');
  await settled(g.gate);
  expect(g.events.slice(-3)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Thinking', origin: 'model', content: 'plan it' },
    { type: 'BlockAdded', id: 5, kind: 'Assistant', origin: 'model', content: 'hello' },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
});

test('aborted while thinking: the Thinking block is kept cut off, no Assistant block', async () => {
  const g = gateWith();
  g.reply({ thinking: 'Let me see', hang: true });
  g.gate.submit('hi there');
  await until(() => g.gate.streaming()?.thinking === 'Let me see');
  g.gate.abort();
  g.gate.abort();
  await settled(g.gate);
  expect(g.events.slice(-2)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Thinking', origin: 'model', content: 'Let me see', cutOff: true },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
  expect(g.gate.status()?.text).toBe('⚠ aborted while thinking – partial answer kept (cut off)');
});

test('a Context changed since the last request can be sent without a new User block', async () => {
  const g = gateWith({ users: ['a', 'b'] });
  g.reply({ content: 'x' });
  await g.gate.send();
  await settled(g.gate);
  await g.gate.send();
  expect(g.gate.status()?.text).toStartWith('nothing to send');
  g.select(3);
  g.gate.remove();
  g.reply({ content: 'y' });
  await g.gate.send();
  await settled(g.gate);
  expect(messages(g, 1)).toEqual(['You are an agent.', 'b', 'x']);
});

test('an undone change leaves nothing to send', async () => {
  const g = gateWith({ users: ['a'] });
  g.reply({ content: 'x' });
  await g.gate.send();
  await settled(g.gate);
  g.select(3);
  g.gate.remove();
  g.gate.undo();
  await g.gate.send();
  expect(g.gate.status()?.text).toStartWith('nothing to send');
  expect(g.sent).toHaveLength(1);
});

test('a failing request says so; no answer is added', async () => {
  const g = gateWith({ users: ['hi'] });
  g.reply({ error: 'server overloaded' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()).toMatchObject({ tone: 'error' });
  expect(g.gate.status()?.text).toContain('server overloaded');
  expect(g.events.at(-1)!.type).toBe('RequestSent');
});

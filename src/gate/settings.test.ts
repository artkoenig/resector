// Session setting tests without a renderer: /thinking, /rename, /tools and the search tool.
import { expect, test } from 'bun:test';
import { gateWith, ofType, results, settled } from './gate.harness';

test('/thinking sets the thinking mode, logged and sent with the next request', async () => {
  const g = gateWith({ users: ['question'] });
  expect(g.gate.thinking()).toBe('off');
  g.gate.submit('/thinking on');
  expect(g.gate.thinking()).toBe('on');
  expect(g.events.at(-1)).toEqual({ type: 'ThinkingSet', thinking: 'on' });
  g.reply({ content: 'ok' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.sent[0]!.request.thinking).toBe('on');
  g.gate.submit('/thinking nope');
  expect(g.gate.status()).toMatchObject({ tone: 'error' });
  expect(g.gate.status()?.text).toStartWith('unknown thinking nope');
});

test('/thinking offers the modes of the chat template', () => {
  const g = gateWith({ thinkingModes: ['low', 'xhigh'] });
  g.gate.submit('/thinking on:low');
  g.gate.submit('/thinking on:xhigh');
  expect(ofType(g.events, 'ThinkingSet')).toEqual([{ type: 'ThinkingSet', thinking: 'low' }, { type: 'ThinkingSet', thinking: 'xhigh' }]);
});

test('a chat template without thinking: /thinking says so and logs nothing', () => {
  const g = gateWith({ thinkingModes: [] });
  g.gate.submit('/thinking on');
  expect(g.gate.status()?.text).toBe('the chat template has no thinking switch');
  expect(ofType(g.events, 'ThinkingSet')).toEqual([]);
});

test('/rename sets the session title, empty resets it', () => {
  const g = gateWith();
  g.gate.submit('/rename my  title');
  expect(g.gate.status()?.text).toBe('session renamed: my  title');
  expect(g.events.at(-1)).toEqual({ type: 'SessionRenamed', title: 'my  title' });
  g.gate.submit('/rename');
  expect(g.gate.status()?.text).toBe('session title reset to the first User message');
  expect(g.events.at(-1)).toEqual({ type: 'SessionRenamed', title: '' });
});

test('/tools switches a tool off and on; off, it is not sent', async () => {
  const g = gateWith();
  g.gate.submit('/tools bash');
  expect(g.gate.status()?.text).toBe('bash off · u = undo');
  expect(g.events.at(-1)).toMatchObject({ type: 'Edit', id: 2, content: '[]', by: 'user' });
  g.reply({ content: 'ok' });
  g.gate.submit('hi');
  await settled(g.gate);
  expect(g.sent[0]!.request.tools).toEqual([]);
  g.gate.submit('/tools bash');
  expect(g.gate.toolsOn()).toEqual(['bash']);
  g.gate.submit('/tools');
  expect(g.gate.status()?.text).toBe('tools: bash · /tools <tool> switches one');
  g.gate.submit('/tools python');
  expect(g.gate.status()?.text).toBe('unknown tool python – bash search question');
});

test('search, switched on with /tools, runs without asking; its call and result are sent as search', async () => {
  const g = gateWith();
  g.gate.submit('/tools search');
  g.reply({ calls: [{ name: 'search', arguments: '{"query":"bun runtime"}' }] }, { content: 'ok' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.gate.context().blocks.find(b => b.kind === 'Tool Call')).toMatchObject({ tool: 'search', content: 'bun runtime' });
  expect(results(g.events)).toMatchObject([{ content: 'results for bun runtime\n[exit 0]' }]);
  const [call] = g.sent[1]!.request.messages.flatMap(m => ('tool_calls' in m && m.tool_calls) || []);
  expect(call!.function).toEqual({ name: 'search', arguments: '{"query":"bun runtime"}' });
});

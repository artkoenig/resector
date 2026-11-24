// Subagent tests without a renderer: a `subagent` Tool Call, approved, starts one and the Tool Loop goes on.
import { expect, test } from 'bun:test';
import { TOOLS } from '../core/tools/catalog';
import { gateWith, ofType, results, settled, subagent, until } from './gate.harness';

const PROMPT = "fix 'it' && say \"done\"\n$HOME";

test('an allowed subagent call starts one with the prompt as it is; its result says so at once, the loop goes on', async () => {
  const g = gateWith({ tools: TOOLS, global: { subagent: 'allow' } });
  g.reply({ calls: [subagent(PROMPT)] }, { content: 'started it' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.prompts).toEqual([PROMPT]);
  expect(g.ran).toEqual([]);
  expect(g.events.filter(e => e.type === 'BlockAdded' && e.id >= 4 || e.type === 'BackgroundStarted').slice(0, 3)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Tool Call', origin: 'model', tool: 'subagent', content: PROMPT },
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: '[Subagent started: pid 4343 · log /home/background/4343.log · stop: kill -- -4343]', call: 4 },
    { type: 'BackgroundStarted', call: 4, pid: 4343, log: '/home/background/4343.log' },
  ]);
  expect(g.gate.status()?.text).toContain('answer complete');
  expect(g.sent).toHaveLength(2);
});

test('without a rule the call is asked for; approved, the Subagent starts', async () => {
  const g = gateWith({ tools: TOOLS });
  g.reply({ calls: [subagent(PROMPT)] }, { content: 'started it' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.prompts).toEqual([]);
  expect(g.gate.status()?.text).toStartWith('? approve');
  g.gate.approve();
  await settled(g.gate);
  expect(g.prompts).toEqual([PROMPT]);
});

test('allowed for the session, the next one starts without asking', async () => {
  const g = gateWith({ tools: TOOLS });
  g.reply({ calls: [subagent('one')] }, { calls: [subagent('two')] }, { content: 'started both' });
  g.gate.submit('go');
  await settled(g.gate);
  g.gate.allowForSession();
  await settled(g.gate);
  expect(g.prompts).toEqual(['one', 'two']);
});

const contents = (events: Parameters<typeof results>[0]) => results(events).map(r => r.content);

test('a third call of one answer fails at once while two run; one goes through after one has ended', async () => {
  const g = gateWith({ tools: TOOLS, global: { subagent: 'allow' } });
  g.reply({ calls: ['one', 'two', 'three'].map(subagent) }, { content: 'two started' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.prompts).toEqual(['one', 'two']);
  expect(contents(g.events)[2]).toBe('limit reached: 2 running\n[exit 1]');
  expect(ofType(g.events, 'BackgroundStarted')).toHaveLength(2);
  expect(g.sent).toHaveLength(2);
  g.reply({ calls: [subagent('four')] }, { content: 'started' });
  g.exit(4343, { signal: 'user' });
  g.gate.submit('again');
  await settled(g.gate);
  expect(g.prompts).toEqual(['one', 'two', 'four']);
});

test('a call over the limit is not asked for', async () => {
  const g = gateWith({ tools: TOOLS, subagent: { max: 1 } });
  g.reply({ calls: [subagent('one'), subagent('two')] }, { content: 'one started' });
  g.gate.submit('go');
  await settled(g.gate);
  g.gate.approve();
  await settled(g.gate);
  expect(g.prompts).toEqual(['one']);
  expect(contents(g.events)[1]).toBe('limit reached: 1 running\n[exit 1]');
});

test('a denied call stays denied over the limit', async () => {
  const g = gateWith({ tools: TOOLS, global: { subagent: 'deny' }, subagent: { profile: 'x' } });
  g.reply({ calls: [subagent('one')] }, { content: 'ok' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(contents(g.events)).toEqual(['denied by rule']);
});

test('an unknown subagent.profile fails the call, the loop goes on', async () => {
  const g = gateWith({ tools: TOOLS, subagent: { profile: 'x' } });
  g.reply({ calls: [subagent('one')] }, { content: 'ok' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.prompts).toEqual([]);
  expect(contents(g.events)).toEqual(['subagent.profile: unknown profile x (profiles: )\n[exit 1]']);
  expect(g.sent).toHaveLength(2);
});

test('a call pending at a resume is refused when approved over the limit', async () => {
  const g = gateWith({
    tools: TOOLS, subagent: { max: 1 }, calls: [{ tool: 'subagent', content: 'one' }, { tool: 'subagent', content: 'two' }],
    logged: [
      { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'started', call: 3 },
      { type: 'BackgroundStarted', call: 3, pid: 1, log: '/1.log' },
    ],
  });
  g.reply({ content: 'ok' });
  g.select(4);
  g.gate.approve();
  await settled(g.gate);
  expect(g.prompts).toEqual([]);
  expect(contents(g.events)[1]).toBe('limit reached: 1 running\n[exit 1]');
});

test('the limit frees for a Subagent ended before a resume; ordinary Background Processes do not count', async () => {
  const g = gateWith({
    tools: TOOLS, global: { subagent: 'allow' }, subagent: { max: 1 },
    users: ['go'], calls: [{ tool: 'subagent', content: 'old' }, 'serve'],
    logged: [
      { type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'started', call: 4 },
      { type: 'BackgroundStarted', call: 4, pid: 1, log: '/1.log' },
      { type: 'BlockAdded', id: 7, kind: 'Tool Result', origin: 'tool', content: 'started', call: 5 },
      { type: 'BackgroundStarted', call: 5, pid: 2, log: '/2.log' },
      { type: 'BackgroundExited', call: 4, signal: 'orphaned' },
    ],
  });
  g.reply({ calls: [subagent('new')] }, { content: 'ok' });
  g.gate.submit('on');
  await settled(g.gate);
  expect(g.prompts).toEqual(['new']);
});

test('a Headless Run without Auto-approve gets the limit, not that nobody can approve', async () => {
  const g = gateWith({
    tools: TOOLS, subagent: { max: 1 }, users: ['go'], calls: [{ tool: 'subagent', content: 'old' }],
    logged: [
      { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'started', call: 4 },
      { type: 'BackgroundStarted', call: 4, pid: 1, log: '/1.log' },
    ],
  });
  g.reply({ calls: [subagent('new')] }, { content: 'done' });
  expect(await g.gate.run({ prompt: 'on' })).toMatchObject({ kind: 'answer', text: 'done' });
  expect(contents(g.events).at(-1)).toBe('limit reached: 1 running\n[exit 1]');
});

test('a refused call left pending by Esc fails at the next Enter, the loop goes on', async () => {
  const g = gateWith({ tools: TOOLS, subagent: { profile: 'x' } });
  g.reply({ content: 'Look', calls: [subagent('one')], delay: 20 }, { content: 'ok' });
  g.gate.submit('go');
  await until(() => g.gate.streaming()?.text === 'Look');
  g.gate.abort();
  await settled(g.gate);
  expect(contents(g.events)).toEqual([]);
  await g.gate.send();
  await settled(g.gate);
  expect(g.prompts).toEqual([]);
  expect(contents(g.events)).toEqual(['subagent.profile: unknown profile x (profiles: )\n[exit 1]']);
  expect(g.sent).toHaveLength(2);
});

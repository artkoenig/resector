// Subagent tests without a renderer: a `subagent` Tool Call, approved, starts one and the Tool Loop goes on.
import { expect, test } from 'bun:test';
import { TOOLS } from '../core/tools/catalog';
import { gateWith, settled, subagent } from './gate.harness';

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

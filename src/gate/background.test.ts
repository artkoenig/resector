// Background Process tests without a renderer: starting one from a bash Tool Call.
import { expect, test } from 'bun:test';
import { background, bash, gateWith, settled } from './gate.harness';

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

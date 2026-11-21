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

test('a Background Process ending logs BackgroundExited; the next request carries its exit Note, once', async () => {
  const g = gateWith({ global: { '*': 'allow' } });
  g.reply({ calls: [background('serve')] }, { content: 'up' }, { content: 'ok' }, { content: 'fine' });
  g.gate.submit('go');
  await settled(g.gate);
  g.exit(4242, { exit: 0 });
  expect(g.events.at(-1)).toEqual({ type: 'BackgroundExited', call: 4, exit: 0 });
  // Not before the next request: nothing is sent for it alone.
  expect(g.sent).toHaveLength(2);
  g.gate.submit('still up?');
  await settled(g.gate);
  const note = 'Background Process pid 4242 ended: exited with 0\ncommand: serve\nlog: /home/background/4242.log';
  expect(g.events.filter(e => e.type === 'BlockAdded' && e.kind === 'Note' && e.origin === 'background')).toEqual([
    { type: 'BlockAdded', id: 8, kind: 'Note', origin: 'background', content: note, exited: 4 },
  ]);
  expect(JSON.stringify(g.sent[2]!.request)).toContain(JSON.stringify(note).slice(1, -1));
  g.gate.submit('and now?');
  await settled(g.gate);
  expect(g.events.filter(e => e.type === 'BlockAdded' && e.origin === 'background')).toHaveLength(1);
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

// Subagent tests without a renderer: a `subagent` Tool Call, approved, starts one and the Tool Loop goes on.
import { expect, test } from 'bun:test';
import { TOOLS } from '../core/tools/catalog';
import { titleOf } from './text';
import { gateWith, ofType, results, settled, subagent, until } from './gate.harness';

const PROMPT = "fix 'it' && say \"done\"\n$HOME";

test('an allowed subagent call starts one with the prompt as it is; its result says so at once, the log names its Session, the loop goes on', async () => {
  const g = gateWith({ tools: TOOLS, global: { subagent: 'allow' } });
  g.reply({ calls: [subagent(PROMPT)] }, { content: 'started it' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.prompts).toEqual([PROMPT]);
  expect(g.ran).toEqual([]);
  expect(g.events.filter(e => e.type === 'BlockAdded' && e.id >= 4 || e.type === 'BackgroundStarted').slice(0, 3)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Tool Call', origin: 'model', tool: 'subagent', content: PROMPT },
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: '[Subagent started: pid 4343 · log /home/background/4343.log · stop: kill -- -4343]', call: 4 },
    { type: 'BackgroundStarted', call: 4, pid: 4343, log: '/home/background/4343.log', session: 'ses_4343' },
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

const inWorktree = (prompt: string) => ({ name: 'subagent', arguments: JSON.stringify({ prompt, worktree: true }) });
const WORKTREE = { path: '/home/worktrees/ses_4343', branch: 'resector/ses_4343', base: 'abc' };

test('a call with worktree outside a git repository fails at once: nothing is started, nothing asked for', async () => {
  const g = gateWith({ tools: TOOLS, repository: false });
  g.reply({ calls: [inWorktree('fix')] }, { content: 'ok' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.prompts).toEqual([]);
  expect(contents(g.events)).toEqual(['worktree: not a git repository\n[exit 1]']);
  expect(ofType(g.events, 'BackgroundStarted')).toEqual([]);
  expect(g.sent).toHaveLength(2);
});

test('a call with worktree is asked for with the argument; its Tool Result names the worktree and its branch', async () => {
  const g = gateWith({ tools: TOOLS });
  g.reply({ calls: [inWorktree('fix')] }, { content: 'started it' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.gate.status()?.text).toStartWith('? approve');
  expect(titleOf(g.gate.context().blocks.find(b => b.id === 4)!)).toBe('subagent [worktree] fix');
  g.gate.approve();
  await settled(g.gate);
  expect(g.events.filter(e => e.type === 'BlockAdded' && e.id >= 4 || e.type === 'BackgroundStarted').slice(0, 3)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Tool Call', origin: 'model', tool: 'subagent', content: 'fix', worktree: true },
    {
      type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', call: 4,
      content: '[Subagent started: pid 4343 · log /home/background/4343.log · stop: kill -- -4343 · worktree /home/worktrees/ses_4343 · branch resector/ses_4343]',
    },
    { type: 'BackgroundStarted', call: 4, pid: 4343, log: '/home/background/4343.log', session: 'ses_4343', worktree: WORKTREE },
  ]);
  expect(JSON.stringify(g.sent[1]!.request)).toContain('\\"worktree\\":true');
});

test('a worktree every Subagent gets by the config shows on the call without the argument too', async () => {
  const g = gateWith({ tools: TOOLS, headless: { worktree: true } });
  g.reply({ calls: [subagent('fix')] }, { content: 'started it' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(titleOf(g.gate.context().blocks.find(b => b.id === 4)!)).toBe('subagent [worktree] fix');
  g.gate.approve();
  await settled(g.gate);
  expect(ofType(g.events, 'BackgroundStarted')[0]).toMatchObject({ worktree: WORKTREE });
});

const exitNote = (g: ReturnType<typeof gateWith>) =>
  g.events.flatMap(e => (e.type === 'BlockAdded' && e.origin === 'background' ? [e.content] : [])).at(-1);

async function startedInWorktree() {
  const g = gateWith({ tools: TOOLS, global: { subagent: 'allow' } });
  g.reply({ calls: [inWorktree('fix')] }, { content: 'started it' }, { content: 'fine' });
  g.gate.submit('go');
  await settled(g.gate);
  return g;
}

test('the exit Note names the worktree and its branch, and says when it has uncommitted changes', async () => {
  const committed = await startedInWorktree();
  committed.exit(4343, { exit: 0, worktree: { dirty: false } });
  expect(exitNote(committed)).toBe('Subagent pid 4343 ended: exited with 0\nprompt: fix\nlog: /home/background/4343.log\nworktree: /home/worktrees/ses_4343 · branch: resector/ses_4343');
  const changed = await startedInWorktree();
  changed.exit(4343, { exit: 0, worktree: { dirty: true } });
  expect(exitNote(changed)).toEndWith('\nworktree: /home/worktrees/ses_4343 · branch: resector/ses_4343 · uncommitted changes');
});

test('a worktree removed as empty: the exit Note names none', async () => {
  const g = await startedInWorktree();
  g.exit(4343, { exit: 0 });
  expect(exitNote(g)).toBe('Subagent pid 4343 ended: exited with 0\nprompt: fix\nlog: /home/background/4343.log');
});

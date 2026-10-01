// Tool loop tests without a renderer: approval, rules, /auto, stopping and killing calls.
import { expect, test } from 'bun:test';
import { bash, gateWith, ofType, results, settled, until } from './gate.harness';

const APPROVE = '? approve – y run once · a allow for session · n reject · e edit';

// The model answers `go` with bash calls; the Gate settles, at the first call to ask for or after the loop.
async function answered(commands: string[], setup: Parameters<typeof gateWith>[0] = {}) {
  const g = gateWith(setup);
  g.reply({ calls: commands.map(bash) });
  g.gate.submit('go');
  await settled(g.gate);
  return g;
}

test('a Tool Call waits for approval; y runs it once, its result is a Tool Result block and is sent with the call', async () => {
  const g = gateWith();
  g.reply({ content: 'Let me look.', calls: [bash('echo hello')] }, { content: 'done' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe(APPROVE);
  expect(g.gate.nextCall()).toMatchObject({ id: 5, content: 'echo hello' });
  g.gate.approve();
  await settled(g.gate);
  expect(g.events.slice(-7)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Let me look.' },
    { type: 'BlockAdded', id: 5, kind: 'Tool Call', origin: 'model', content: 'echo hello' },
    { type: 'ResponseReceived', usage: null, cached: null },
    { type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'ran echo hello\n[exit 0]', call: 5 },
    { type: 'RequestSent', hash: expect.any(String), tokens: 60 },
    { type: 'BlockAdded', id: 7, kind: 'Assistant', origin: 'model', content: 'done' },
    { type: 'ResponseReceived', usage: null, cached: null },
  ]);
  // Assistant text and its Tool Call are one message; the result a tool message.
  expect(g.sent[1]!.request.messages.slice(2)).toEqual([
    { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'call_0', type: 'function', function: bash('echo hello') }] },
    { role: 'tool', tool_call_id: 'call_0', content: 'ran echo hello\n[exit 0]' },
  ]);
});

test('a User message while a Tool Call awaits approval is added, nothing is sent', async () => {
  const g = await answered(['echo hi']);
  g.gate.submit('also this');
  await settled(g.gate);
  expect(g.events.at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'User', origin: 'user', content: 'also this' });
  expect(g.gate.status()?.text).toBe('Tool Calls await approval – y run once · a allow for session · n reject · e edit on the ? approve row');
  expect(g.sent).toHaveLength(1);
});

test('n rejects: the call does not run, its result says "rejected by user", the loop pauses', async () => {
  const g = await answered(['touch rejected.txt']);
  g.gate.reject();
  await settled(g.gate);
  expect(g.ran).toEqual([]);
  expect(g.events.at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'rejected by user', call: 4 });
  expect(g.gate.status()?.text).toBe('tool loop paused – review the results, Enter sends');
  expect(g.sent).toHaveLength(1);
});

test('several calls are decided one by one in order; results keep call order', async () => {
  const g = await answered(['echo one', 'echo two']);
  g.select(5);
  g.gate.approve();
  expect(g.gate.status()?.text).toBe('approve the earlier Tool Call first');
  g.select(4);
  g.gate.approve();
  await settled(g.gate);
  expect(g.gate.nextCall()?.id).toBe(5);
  g.gate.reject();
  await settled(g.gate);
  expect(results(g.events).map(e => [e.call, e.content])).toEqual([[4, 'ran echo one\n[exit 0]'], [5, 'rejected by user']]);
});

test('Esc while a call runs: it finishes, the next call waits and nothing is sent; send goes on', async () => {
  const g = gateWith({ global: { 'sleep *': 'allow' }, runner: { slow: ['sleep 1'] } });
  g.reply({ calls: [bash('sleep 1'), bash('ls')] });
  g.gate.submit('go');
  await until(() => g.gate.running() !== null);
  g.gate.abort();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('stopped – make your changes, Enter goes on');
  expect(results(g.events).map(e => e.content)).toEqual(['ran sleep 1\n[exit 0]']);
  expect(g.sent).toHaveLength(1);
  g.reply({ content: 'ok' });
  await g.gate.send();
  await settled(g.gate);
  expect(results(g.events)).toHaveLength(2);
  expect(g.sent).toHaveLength(2);
});

test('Esc again kills a running command: its partial output is kept, the results are held', async () => {
  const g = gateWith({ runner: { hang: ['sleep 5'] } });
  g.reply({ calls: [bash('sleep 5')] });
  g.gate.submit('go');
  await settled(g.gate);
  g.gate.approve();
  await until(() => g.gate.running()?.output === 'partial\n');
  g.gate.abort();
  expect(g.gate.stopping()).toBe(true);
  g.gate.abort();
  await settled(g.gate);
  expect(g.events.at(-1)).toMatchObject({ kind: 'Tool Result', content: 'partial\n[killed]', stopped: 'killed' });
  expect(g.gate.status()?.text).toBe('⚠ killed – review the results, Enter sends');
});

test('Esc while the answer streams: it completes, its calls wait, even allowed ones; send runs them', async () => {
  const g = gateWith();
  g.reply({ content: 'Look', calls: [bash('ls')], delay: 20 });
  g.gate.submit('go');
  await until(() => g.gate.streaming()?.text === 'Look');
  g.gate.abort();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('stopped – make your changes, Enter goes on');
  expect(g.events.find(e => e.type === 'BlockAdded' && e.kind === 'Assistant')).toEqual({ type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Look' });
  expect(g.ran).toEqual([]);
  g.reply({ content: 'ok' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.ran).toEqual(['ls']);
  expect(g.sent).toHaveLength(2);
});

test('stopped at a call the rules ask for: send still asks for approval', async () => {
  const g = gateWith();
  g.reply({ content: 'Look', calls: [bash('touch x.txt')], delay: 20 });
  g.gate.submit('go');
  await until(() => g.gate.streaming()?.text === 'Look');
  g.gate.abort();
  await settled(g.gate);
  await g.gate.send();
  expect(g.gate.status()?.text).toStartWith('Tool Calls await approval');
  expect(g.ran).toEqual([]);
});

test('a command running into the timeout is held with ⚠ timeout', async () => {
  const g = await answered(['sleep 5'], { runner: { timeout: 0.3, results: { 'sleep 5': { output: '', exit: null, stopped: 'timeout' } } } });
  g.gate.approve();
  await settled(g.gate);
  expect(g.events.at(-1)).toMatchObject({ content: '[timeout after 0.3 s]', stopped: 'timeout' });
  expect(g.gate.status()?.text).toBe('⚠ timeout – review the results, Enter sends');
});

test('an answer cut off at max_tokens runs no call; calls that are no known tool are not run', async () => {
  const g = gateWith();
  g.reply({ content: 'Hm', calls: [bash('ls')], finish: 'length' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('⚠ cut off at max_tokens');
  expect(g.events.at(-2)).toEqual({ type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hm\nbash {"command":"ls"}', cutOff: true });
  g.reply({ calls: [{ name: 'python', arguments: '{}' }, bash('pwd')] });
  g.gate.submit('again');
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe(`⚠ tool call not run: unknown tool python · ${APPROVE}`);
  expect(g.gate.context().blocks.slice(-2)).toMatchObject([{ kind: 'Assistant', content: 'python {}' }, { kind: 'Tool Call', content: 'pwd', pending: true }]);
});

test('a Tool Call awaiting approval is edited; y runs the edited command', async () => {
  const g = await answered(['echo wrong'], { editor: async () => 'echo right\n' });
  g.gate.edit();
  await until(() => g.gate.nextCall()?.revision === 2);
  g.reply({ content: 'ok' });
  g.gate.approve();
  await settled(g.gate);
  expect(results(g.events)).toEqual([{ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'ran echo right\n[exit 0]', call: 4 }]);
});

test('e on a pending call: the new Revision is decided again by the rules', async () => {
  const g = await answered(['touch edited.txt'], { editor: async () => 'ls -d .\n' });
  g.reply({ content: 'ok' });
  g.gate.edit();
  await until(() => g.sent.length === 2);
  await settled(g.gate);
  expect(g.events.slice(-5, -3)).toEqual([
    { type: 'Edit', id: 4, revision: 2, content: 'ls -d .', by: 'user' },
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'ran ls -d .\n[exit 0]', call: 4 },
  ]);
});

test('allowed calls run without asking; then their results are sent', async () => {
  const g = gateWith();
  g.reply({ calls: [bash('ls -d .'), bash('ls')] }, { content: 'ok' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.ran).toEqual(['ls -d .', 'ls']);
  expect(results(g.events).map(e => e.call)).toEqual([4, 5]);
  expect(g.sent).toHaveLength(2);
  expect(g.gate.status()?.text).toBe('answer complete');
});

test('a denied call is not run: its result says "denied by rule", the next call is still decided', async () => {
  const g = await answered(['touch denied.txt', 'echo next'], { global: { 'touch *': 'deny' } });
  expect(g.ran).toEqual([]);
  expect(g.gate.status()?.text).toBe(`⚠ denied by rule: touch denied.txt · ${APPROVE}`);
  expect(g.gate.nextCall()?.content).toBe('echo next');
  expect(g.events.at(-1)).toEqual({ type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'denied by rule', call: 4 });
});

test('/auto runs the call awaiting approval at once and every later one a rule asks for; a deny stays; /auto again asks', async () => {
  const g = await answered(['touch one.txt', 'touch denied.txt', 'touch two.txt'], { global: { 'touch denied.txt': 'deny' } });
  g.gate.submit('/auto');
  await settled(g.gate);
  expect(g.gate.autoApprove()).toBe(true);
  expect(g.gate.status()?.text).toContain('auto-approve on – Tool Calls run without asking, deny rules still apply');
  expect(results(g.events).map(e => e.content)).toEqual(['ran touch one.txt\n[exit 0]', 'denied by rule', 'ran touch two.txt\n[exit 0]']);
  expect(ofType(g.events, 'AllowRuleAdded')).toEqual([]);
  g.reply({ calls: [bash('touch three.txt')] }, { content: 'ok' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.ran).toContain('touch three.txt');
  g.gate.submit('/auto');
  expect(g.gate.status()?.text).toBe('auto-approve off');
  g.reply({ calls: [bash('touch four.txt')] });
  g.gate.submit('again');
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe(APPROVE);
  expect(g.ran).not.toContain('touch four.txt');
});

test('/auto with nothing awaiting approval only switches it', async () => {
  const g = gateWith();
  g.gate.submit('/auto');
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('auto-approve on – Tool Calls run without asking, deny rules still apply');
  expect(g.sent).toEqual([]);
});

test('a logs the session rule and runs the call; every later match runs too, then the results are sent', async () => {
  const g = await answered(['touch one.txt', 'touch two.txt']);
  g.reply({ content: 'ok' });
  g.gate.allowForSession();
  await settled(g.gate);
  expect(ofType(g.events, 'AllowRuleAdded')).toEqual([{ type: 'AllowRuleAdded', pattern: 'touch *' }]);
  expect(results(g.events).map(e => e.content)).toEqual(['ran touch one.txt\n[exit 0]', 'ran touch two.txt\n[exit 0]']);
  expect(g.sent).toHaveLength(2);
});

test('a is refused where an argument points outside the project', async () => {
  const g = await answered(['cat /etc/hostname']);
  g.gate.allowForSession();
  expect(g.gate.status()?.text).toBe('cannot allow for session: argument outside project: /etc/hostname – y runs once, e edits');
  expect(ofType(g.events, 'AllowRuleAdded')).toEqual([]);
});

test('calls pending when the Gate opens are decided by the rules at once', async () => {
  const g = gateWith({ users: ['go'], calls: ['ls -d .', 'touch resumed.txt'] });
  await settled(g.gate);
  expect(g.events.at(-1)).toEqual({ type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'ran ls -d .\n[exit 0]', call: 4 });
  expect(g.gate.nextCall()?.content).toBe('touch resumed.txt');
});

test('a project rule beats a global one: project allow loosens a global ask, project deny beats a global allow', async () => {
  const g = await answered(['touch project.txt', 'make'], { global: { 'touch *': 'ask', 'make *': 'allow' }, project: { 'touch *': 'allow', 'make *': 'deny' } });
  expect(g.ran).toEqual(['touch project.txt']);
  expect(results(g.events).map(e => e.content)).toEqual(['ran touch project.txt\n[exit 0]', 'denied by rule']);
});

test('a session rule beats global and project rules', async () => {
  const g = await answered(['touch one.txt', 'touch secret.txt'], { global: { 'touch secret.txt': 'allow' }, project: { 'touch secret.txt': 'deny', 'touch one.txt': 'ask' } });
  g.reply({ content: 'ok' });
  g.gate.allowForSession();
  await settled(g.gate);
  expect(g.ran).toEqual(['touch one.txt', 'touch secret.txt']);
});

// UI tests: the tool loop: approval, rules, /auto, stopping and killing calls.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { frameMatching } from '../../test/frames';
import type { Tool } from '../core/log/events';
import { answered, asked, bash, escape, fake, fixture, line, press, previewed, project, type Sent, start, ui, useHarness, withUsers, write } from './app.harness';

useHarness();

test('the Tools Block (bash) is always sent and fixed', async () => {
  await withUsers('hi');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect((fake.chatRequests[0] as Sent).tools!.map(t => t.function.name)).toEqual(['bash']);
  for (const k of ['up', 'up']) await press(k);
  await frameMatching(ui, f => previewed(f) === '[');
  await press('d');
  await frameMatching(ui, f => f.includes('Tools Block cannot be removed'));
  await press('down', { meta: true });
  await frameMatching(ui, f => f.includes('Tools Block is fixed'));
});

test('a Tool Call waits at ? approve; y runs it once, its result is a Tool Result block and is sent', async () => {
  const { events } = await asked(['echo hello'], { text: 'Let me look.' });
  let frame = ui.captureCharFrame();
  expect(line(frame, /Let me look/)).toMatch(/4\s+Assistant\s+Let me look\./);
  expect(line(frame, /Tool Call/)).toMatch(/5\s+Tool Call\s+echo hello\s+\d+\s+[●○]\s+\? approve/);
  expect(frame).toMatch(/y run once.*n reject/);
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('Tool Calls await approval'));
  fake.reply({ chunks: ['done'] });
  await press('y');
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(line(frame, /Tool Result/)).toMatch(/6\s+Tool Result\s+→ echo hello\s+\d+/);
  expect(line(frame, /Tool Call/)).not.toContain('? approve');
  expect(fake.chatRequests).toHaveLength(2);
  expect(events().slice(-7)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Let me look.' },
    { type: 'BlockAdded', id: 5, kind: 'Tool Call', origin: 'model', content: 'echo hello' },
    { type: 'ResponseReceived', usage: null, cached: expect.any(Number) },
    { type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'hello\n[exit 0]', call: 5 },
    { type: 'RequestSent', hash: expect.any(String), tokens: expect.any(Number) },
    { type: 'BlockAdded', id: 7, kind: 'Assistant', origin: 'model', content: 'done' },
    { type: 'ResponseReceived', usage: null, cached: expect.any(Number) },
  ]);
  // Assistant text and its Tool Call are one message; the result a tool message.
  expect((fake.chatRequests[1] as Sent).messages.slice(2)).toEqual([
    { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'call_0', type: 'function', function: bash('echo hello') }] },
    { role: 'tool', tool_call_id: 'call_0', content: 'hello\n[exit 0]' },
  ]);
});

test('Enter in input mode while a Tool Call awaits approval adds the User block but sends nothing', async () => {
  const { events } = await asked(['echo hi']);
  ui.mockInput.pressTab();
  await frameMatching(ui, f => f.includes('adds a block and sends the Context'));
  await ui.mockInput.typeText('also this');
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('Tool Calls await approval') && f.includes('also this'));
  expect(line(frame, /also this/)).toMatch(/5\s+User\s+also this/);
  expect(previewed(frame)).toMatch(/^ask\s+echo hi\s+no rule → default ask$/);
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'User', origin: 'user', content: 'also this' });
});

test('n rejects: the call does not run, its result says "rejected by user"', async () => {
  const { events } = await asked(['touch rejected.txt']);
  expect(line(ui.captureCharFrame(), /Tool Call/)).toMatch(/4\s+Tool Call\s+touch rejected\.txt/);
  await press('n');
  const frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  expect(line(frame, /Tool Result/)).toMatch(/5\s+Tool Result\s+→ touch rejected\.txt/);
  expect(await Bun.file(join(project, 'rejected.txt')).exists()).toBe(false);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'rejected by user', call: 4 });
});

test('several calls are decided one by one in order; results keep call order', async () => {
  const { events } = await asked(['echo one', 'echo two']);
  let frame = ui.captureCharFrame();
  expect(line(frame, /echo one/)).toMatch(/\? approve/);
  expect(line(frame, /echo two/)).toMatch(/· queued/);
  await press('down');
  await press('y');
  await frameMatching(ui, f => f.includes('approve the earlier Tool Call first'));
  await press('up');
  await press('y');
  frame = await frameMatching(ui, f => f.includes('? approve –') && /^ask\s+echo two\s/.test(previewed(f)));
  expect(frame).toContain('┃ a allows "echo *" for this session');
  await press('n');
  frame = await frameMatching(ui, f => f.includes('tool loop paused'));
  expect(frame).toMatch(/4\s+Tool Call\s+echo one[^]*5\s+Tool Call\s+echo two[^]*6\s+Tool Result\s+→ echo one[^]*7\s+Tool Result\s+→ echo two/);
  expect(events().slice(-2).map(e => [e.call, e.content])).toEqual([[4, 'one\n[exit 0]'], [5, 'rejected by user']]);
});

test('Esc again kills a running command: partial output + ⚠ killed', async () => {
  const { events } = await asked(['echo partial; sleep 5']);
  await press('y');
  let frame = await frameMatching(ui, f => f.includes('running: echo partial') && /^┃ partial\s*$/m.test(f));
  expect(frame).toMatch(/\d+s \/ 120s/);
  expect(frame).toContain('esc stop after');
  expect(line(frame, /Tool Result/)).toMatch(/5\s+Tool Result\s+→ echo partial.*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  expect(line(frame, /Tool Call/)).not.toContain('? approve');
  await escape();
  await frameMatching(ui, f => f.includes('stops after this call'));
  await escape();
  frame = await frameMatching(ui, f => f.includes('⚠ killed – review the results'));
  expect(line(frame, /Tool Result/)).toMatch(/⚠ killed/);
  expect(events().at(-1)).toMatchObject({ kind: 'Tool Result', content: 'partial\n[killed]', stopped: 'killed' });
});

test('Esc while a call runs: it finishes, the next call waits and nothing is sent; Enter goes on', async () => {
  const { events } = await answered(['sleep 0.3', 'ls'], { global: { 'sleep *': 'allow' } });
  await frameMatching(ui, f => f.includes('running: sleep 0.3'));
  await escape();
  let frame = await frameMatching(ui, f => f.includes('stopped – make your changes, Enter goes on'));
  expect(events().filter(e => e.kind === 'Tool Result').map(e => e.content)).toEqual(['[exit 0]']);
  expect(fake.chatRequests).toHaveLength(1);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.kind === 'Tool Result')).toHaveLength(2);
  expect(fake.chatRequests).toHaveLength(2);
});

test('reading an older row, the tool loop leaves the selection there; back on the last row it follows again', async () => {
  await start();
  fake.reply({ chunks: ['Look'], calls: [bash('ls')], delay: 0.3 });
  fake.reply({ chunks: ['done'] });
  await write('go');
  await frameMatching(ui, f => /Assistant\s+Look/.test(f));
  await press('up');
  await frameMatching(ui, f => previewed(f) === 'go');
  let frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(previewed(frame)).toBe('go');
  await press('down');
  await press('down');
  await press('down');
  await press('down');
  frame = await frameMatching(ui, f => previewed(f) === 'done');
  fake.reply({ chunks: ['Again'], calls: [bash('ls')], delay: 0.3 });
  fake.reply({ chunks: ['end'] });
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('more');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete') && /Assistant\s+end/.test(f) && previewed(f) === 'end');
});

test('Esc while the answer streams: it completes, its calls wait, even allowed ones; Enter runs them', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Look'], calls: [bash('ls')], delay: 0.3 });
  await write('go');
  await frameMatching(ui, f => /Assistant\s+Look/.test(f));
  await escape();
  await frameMatching(ui, f => f.includes('model is responding · stops after this answer'));
  await frameMatching(ui, f => f.includes('stopped – make your changes, Enter goes on'));
  expect(events().filter(e => e.kind === 'Tool Result')).toEqual([]);
  expect(events().find(e => e.kind === 'Assistant')).toEqual({ type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Look' });
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.kind === 'Tool Result')).toHaveLength(1);
});

test('stopped at a call the rules ask for: Enter still asks for approval', async () => {
  await start();
  fake.reply({ chunks: ['Look'], calls: [bash('touch x.txt')], delay: 0.3 });
  await write('go');
  await frameMatching(ui, f => /Assistant\s+Look/.test(f));
  await escape();
  await frameMatching(ui, f => f.includes('stopped – make your changes, Enter goes on'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('Tool Calls await approval'));
});

test('a command running into the timeout ends with ⚠ timeout', async () => {
  const { events } = await asked(['sleep 5'], { timeout: 0.3 });
  await press('y');
  const frame = await frameMatching(ui, f => f.includes('⚠ timeout – review the results'));
  expect(line(frame, /Tool Result/)).toMatch(/⚠ timeout/);
  expect(events().at(-1)).toMatchObject({ content: '[timeout after 0.3 s]', stopped: 'timeout' });
});

test('an answer cut off at max_tokens runs no call; calls that are no bash command are not run', async () => {
  const { events } = await start();
  fake.reply({ chunks: ['Hm'], calls: [bash('ls')], finish: 'length' });
  await write('go');
  let frame = await frameMatching(ui, f => f.includes('cut off at max_tokens'));
  expect(frame).not.toContain('Tool Call');
  expect(events().at(-2)).toEqual({ type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Hm\nbash {"command":"ls"}', cutOff: true });
  fake.reply({ chunks: [], calls: [{ name: 'python', arguments: '{}' }, bash('pwd')] });
  await write('again');
  frame = await frameMatching(ui, f => f.includes('tool call not run: unknown tool python'));
  expect(line(frame, /python/)).toMatch(/Assistant\s+python \{\}/);
  expect(line(frame, /Tool Call/)).toMatch(/Tool Call\s+pwd\s.*\? approve/);
});

test('a Tool Call awaiting approval is edited; y runs the edited command', async () => {
  const { events } = await asked(['echo wrong']);
  fixture.editor = async () => 'echo right\n';
  await press('e');
  let frame = await frameMatching(ui, f => f.includes('revision 2'));
  expect(line(frame, /Tool Call/)).toMatch(/4\s+Tool Call\s+echo right\s+\d+\s+[●○]?\s+✎2 \? approve/);
  fake.reply({ chunks: ['ok'] });
  await press('y');
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().find(e => e.kind === 'Tool Result')).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'right\n[exit 0]', call: 4 });
});

test('allowed calls run without asking; then their results are sent', async () => {
  const { events } = await start();
  fake.reply({ chunks: [], calls: [bash('ls -d .'), bash('git status --short | wc -l')] });
  fake.reply({ chunks: ['ok'] });
  await write('go');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('? approve');
  expect(events().filter(e => e.kind === 'Tool Result').map(e => [e.call, e.content])).toEqual([[4, '.\n[exit 0]'], [5, expect.stringMatching(/\[exit 0\]$/)]]);
  expect(fake.chatRequests).toHaveLength(2);
});

test('a result held back (rejected, denied, killed, timeout) stops the tool loop: Enter sends', async () => {
  await asked(['echo one', 'echo two']);
  await press('n');
  await frameMatching(ui, f => f.includes('? approve –') && /^ask\s+echo two\s/.test(previewed(f)));
  await press('y');
  await frameMatching(ui, f => f.includes('tool loop paused – review the results, Enter sends'));
  expect(fake.chatRequests).toHaveLength(1);
});

test('a denied call is not run: its result says "denied by rule", the next call is still decided', async () => {
  const { events } = await answered(['touch denied.txt', 'echo next'], { global: { 'touch *': 'deny' } });
  const frame = await frameMatching(ui, f => f.includes('⚠ denied by rule: touch denied.txt · ? approve'));
  expect(line(frame, /echo next/)).toMatch(/\? approve/);
  expect(await Bun.file(join(project, 'denied.txt')).exists()).toBe(false);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'denied by rule', call: 4 });
});

test('/auto runs the call awaiting approval at once and every later one a rule asks for; a deny stays; /auto again asks', async () => {
  const { events } = await asked(['touch one.txt', 'touch denied.txt', 'touch two.txt'], { global: { 'touch denied.txt': 'deny' } });
  await write('/auto');
  let frame = await frameMatching(ui, f => f.includes('review the results, Enter sends'));
  expect(frame).toContain('auto-approve on – Tool Calls run without asking, deny rules still apply');
  expect(line(frame, /default/)).toMatch(/default · thinking off · auto-approve +/);
  expect(frame).not.toContain('? approve');
  expect(events().filter(e => e.kind === 'Tool Result').map(e => e.content)).toEqual(['[exit 0]', 'denied by rule', '[exit 0]']);
  expect(await Bun.file(join(project, 'two.txt')).exists()).toBe(true);
  expect(events().filter(e => e.type === 'AllowRuleAdded')).toEqual([]);
  fake.reply({ chunks: [], calls: [bash('touch three.txt')] });
  ui.mockInput.pressEnter();
  fake.reply({ chunks: ['ok'] });
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(await Bun.file(join(project, 'three.txt')).exists()).toBe(true);
  await write('/auto');
  frame = await frameMatching(ui, f => f.includes('auto-approve off'));
  expect(line(frame, /default/)).not.toContain('auto-approve');
  fake.reply({ chunks: [], calls: [bash('touch four.txt')] });
  await write('again');
  await frameMatching(ui, f => f.includes('? approve –'));
  expect(await Bun.file(join(project, 'four.txt')).exists()).toBe(false);
});

test('/auto with nothing awaiting approval only switches it', async () => {
  await start();
  await write('/auto');
  await frameMatching(ui, f => f.includes('auto-approve on'));
  expect(fake.chatRequests).toHaveLength(0);
});

test('the preview of a pending call shows each sub-command with the rule deciding it', async () => {
  await asked(['ls && touch x.txt', 'cat /etc/hostname']);
  const frame = ui.captureCharFrame();
  expect(frame).toMatch(/┃ allow\s+ls\s+built-in rule "ls \*"/);
  expect(frame).toMatch(/┃ ask\s+touch x\.txt\s+no rule → default ask/);
  expect(frame).toContain('┃ a allows "touch *" for this session');
});

test('a logs the session rule the preview shows and runs the call; every later match runs too, then the results are sent', async () => {
  const { events } = await asked(['touch one.txt', 'touch two.txt']);
  expect(ui.captureCharFrame()).toContain('┃ a allows "touch *" for this session');
  fake.reply({ chunks: ['ok'] });
  await press('a');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('? approve');
  expect(events().filter(e => e.type === 'AllowRuleAdded' || e.kind === 'Tool Result').map(e => e.pattern ?? e.content)).toEqual(['touch *', '[exit 0]', '[exit 0]']);
  expect(await Bun.file(join(project, 'two.txt')).exists()).toBe(true);
  expect(fake.chatRequests).toHaveLength(2);
});

test('a is not offered where an argument points outside the project', async () => {
  const { events } = await asked(['cat /etc/hostname']);
  await press('a');
  await frameMatching(ui, f => f.includes('cannot allow for session: argument outside project: /etc/hostname – y runs'));
  expect(events().some(e => e.type === 'AllowRuleAdded')).toBe(false);
});

test('e on a pending call: the new Revision is decided again by the rules', async () => {
  const { events } = await asked(['touch edited.txt']);
  fixture.editor = async () => 'ls -d .\n';
  fake.reply({ chunks: ['ok'] });
  await press('e');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().slice(-5, -3)).toEqual([
    { type: 'Edit', id: 4, revision: 2, content: 'ls -d .', by: 'user' },
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: '.\n[exit 0]', call: 4 },
  ]);
});

test('calls pending when the Gate opens are decided by the rules at once', async () => {
  const { events } = await start({ users: ['go'], calls: ['ls -d .', 'touch resumed.txt'] });
  await frameMatching(ui, f => f.includes('? approve –') && /Tool Call\s+touch resumed\.txt.*\? approve/.test(f));
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: '.\n[exit 0]', call: 4 });
});

test('project allow entries are ignored; the Gate says so', async () => {
  await start({ project: { 'touch *': 'allow', 'curl *': 'deny' } });
  expect(ui.captureCharFrame()).toContain('project config: allow "touch *" ignored (project config may only tighten)');
  fake.reply({ chunks: [], calls: [bash('touch project.txt')] });
  await write('go');
  await frameMatching(ui, f => f.includes('? approve –'));
  expect(await Bun.file(join(project, 'project.txt')).exists()).toBe(false);
});

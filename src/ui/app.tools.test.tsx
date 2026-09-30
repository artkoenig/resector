// UI tests: the tool loop: approval, rules, /auto, stopping and killing calls.
import { expect, test } from 'bun:test';
import { frameMatching } from '../../test/frames';
import { asked, bash, escape, fake, line, press, previewed, type Sent, start, ui, useHarness, withUsers, write } from './app.harness';

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

test('a Tool Call waits at ? approve; y runs it, its Tool Result row follows and the result is sent', async () => {
  await asked(['echo hello'], { text: 'Let me look.' });
  let frame = ui.captureCharFrame();
  expect(line(frame, /Let me look/)).toMatch(/4\s+Assistant\s+Let me look\./);
  expect(line(frame, /Tool Call/)).toMatch(/5\s+Tool Call\s+echo hello\s+\d+\s+[●○]\s+\? approve/);
  expect(frame).toMatch(/y run once.*n reject/);
  fake.reply({ chunks: ['done'] });
  await press('y');
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(line(frame, /Tool Result/)).toMatch(/6\s+Tool Result\s+→ echo hello\s+\d+/);
  expect(line(frame, /Tool Call/)).not.toContain('? approve');
  // The real runner ran it.
  expect((fake.chatRequests[1] as Sent).messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'hello\n[exit 0]' });
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

test('a result held back (rejected, denied, killed, timeout) stops the tool loop: Enter sends', async () => {
  await asked(['echo one', 'echo two']);
  await press('n');
  await frameMatching(ui, f => f.includes('? approve –') && /^ask\s+echo two\s/.test(previewed(f)));
  await press('y');
  await frameMatching(ui, f => f.includes('tool loop paused – review the results, Enter sends'));
  expect(fake.chatRequests).toHaveLength(1);
});

test('/auto shows auto-approve in the header until switched off', async () => {
  await start();
  await write('/auto');
  let frame = await frameMatching(ui, f => f.includes('auto-approve on'));
  expect(line(frame, /default/)).toMatch(/default · thinking off · auto-approve +/);
  await write('/auto');
  frame = await frameMatching(ui, f => f.includes('auto-approve off'));
  expect(line(frame, /default/)).not.toContain('auto-approve');
});

test('the preview of a pending call shows each sub-command with the rule deciding it', async () => {
  await asked(['ls && touch x.txt', 'cat /etc/hostname']);
  const frame = ui.captureCharFrame();
  expect(frame).toMatch(/┃ allow\s+ls\s+built-in rule "ls \*"/);
  expect(frame).toMatch(/┃ ask\s+touch x\.txt\s+no rule → default ask/);
  expect(frame).toContain('┃ a allows "touch *" for this session');
});

test('a is not offered where an argument points outside the project', async () => {
  const { events } = await asked(['cat /etc/hostname']);
  await press('a');
  await frameMatching(ui, f => f.includes('cannot allow for session: argument outside project: /etc/hostname – y runs'));
  expect(events().some(e => e.type === 'AllowRuleAdded')).toBe(false);
});

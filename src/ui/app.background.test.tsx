// UI tests: Background Processes: the flag on the call's row, the live log in its Tool Result's preview.
import { TOOLS } from '../core/tools/catalog';
import { expect, test } from 'bun:test';
import { frameMatching } from '../../test/frames';
import { fake, line, press, start, ui, useHarness, write } from './app.harness';

useHarness();

const background = (command: string) => ({ name: 'bash', arguments: JSON.stringify({ command, background: true }) });

// The model starts `command` in the background; it runs without asking, the answer `up` follows.
async function started(command: string) {
  await start({ global: { '*': 'allow' }, background: 0.3 });
  fake.reply({ chunks: [], calls: [background(command)] });
  fake.reply({ chunks: ['up'] });
  await write('go');
  return frameMatching(ui, f => f.includes('answer complete'));
}

test('the call’s row shows its Background Process running, then how it ended', async () => {
  const frame = await started('sleep 1; exit 3');
  expect(line(frame, /Tool Call/)).toMatch(/Tool Call\s+sleep 1; exit 3.*▶ running/);
  const ended = await frameMatching(ui, f => /Tool Call.*■ exited 3/.test(f));
  expect(line(ended, /Tool Call/)).not.toContain('running');
});

test('the preview of its Tool Result shows the log, live while it runs', async () => {
  await started('echo one; sleep 0.6; echo two; sleep 30');
  // From the answer up to the Tool Result.
  await press('up');
  const frame = await frameMatching(ui, f => /^┃ Tool Result {2}#\d+/m.test(f) && /^┃ one\s/m.test(f));
  expect(frame).not.toMatch(/^┃ two\s/m);
  expect(frame).toMatch(/\.log · running/);
  // It follows the log's end.
  await frameMatching(ui, f => /^┃ one\s/m.test(f) && /^┃ two\s/m.test(f));
});

test('k on the row of a running Background Process kills it; the hint shows only there', async () => {
  const frame = await started('sleep 30');
  // On the answer: nothing to kill.
  expect(frame).not.toContain('k kill');
  await press('up');
  await press('up');
  await frameMatching(ui, f => /^┃ Tool Call/m.test(f) && f.includes('k kill'));
  await press('k');
  const ended = await frameMatching(ui, f => /Tool Call.*■ stopped/.test(f));
  expect(ended).not.toContain('k kill');
});

test('k kills it while another call runs', async () => {
  await start({ global: { '*': 'allow' }, background: 0.3 });
  fake.reply({ chunks: [], calls: [background('sleep 30')] });
  fake.reply({ chunks: [], calls: [{ name: 'bash', arguments: JSON.stringify({ command: 'sleep 3' }) }] });
  fake.reply({ chunks: ['done'] });
  await write('go');
  // The selection follows the running call's result; from there up to the Background Process's call.
  await frameMatching(ui, f => /^┃\s+7\s+Tool Result/m.test(f) && f.includes('esc stop after'));
  for (let i = 0; i < 3; i++) await press('up');
  await frameMatching(ui, f => /^┃ Tool Call/m.test(f) && f.includes('k kill'));
  await press('k');
  await frameMatching(ui, f => /Tool Call.*■ stopped/.test(f));
});

test('a Background Process ending while the Session is at rest: its exit Note and the answer appear without a key press, a begun prompt stays', async () => {
  const started = await start({ global: { '*': 'allow' }, background: 0.3 });
  fake.reply({ chunks: [], calls: [background('sleep 1; exit 3')] });
  fake.reply({ chunks: ['up'] });
  fake.reply({ chunks: ['it failed'] });
  await write('go');
  await frameMatching(ui, f => f.includes('answer complete'));
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('and then');
  const frame = await frameMatching(ui, f => /Assistant +it failed/.test(f));
  expect(line(frame, /Note/)).toMatch(/Background Process pid \d+/);
  expect(frame).toContain('and then');
  expect(started.events().some(e => e.kind === 'User' && e.content === 'and then')).toBe(false);
});

// At rest with a process about to end, the draft `and then` begun; `reply` answers its exit Note.
async function writingAtExit(...replies: Parameters<typeof fake.reply>[0][]) {
  const started = await start({ tools: TOOLS, global: { '*': 'allow' }, background: 0.3 });
  fake.reply({ chunks: [], calls: [background('sleep 1')] });
  fake.reply({ chunks: ['up'] });
  for (const reply of replies) fake.reply(reply);
  await write('go');
  await frameMatching(ui, f => f.includes('answer complete'));
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('and then');
  return started;
}

test('Enter in the prompt while the request of an exit Note is under way sends nothing: the text stays for after the answer', async () => {
  const started = await writingAtExit({ chunks: ['it ', 'ended'], delay: 0.5 }, { chunks: ['sure'] });
  await frameMatching(ui, f => f.includes('tab/esc back') && !f.includes('enter send') && f.includes('and then'));
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => /Assistant +it ended/.test(f) && f.includes('enter send'));
  expect(frame).toContain('and then');
  expect(started.events().some(e => e.kind === 'User' && e.content === 'and then')).toBe(false);
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => /Assistant +sure/.test(f));
  expect(started.events().some(e => e.kind === 'User' && e.content === 'and then')).toBe(true);
});

test('a Question answering an exit Note sets the begun text aside; it is back once answered', async () => {
  const questions = [{ question: 'Restart it?', header: 'Restart', options: [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }], recommended: 'Yes' }];
  await writingAtExit({ chunks: [], calls: [{ name: 'question', arguments: JSON.stringify({ questions }) }] }, { chunks: ['restarted'] });
  await frameMatching(ui, f => f.includes('Restart it?') && !f.includes('and then'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => /Assistant +restarted/.test(f) && f.includes('and then'));
});

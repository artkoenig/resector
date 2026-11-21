// UI tests: Background Processes: the flag on the call's row, the live log in its Tool Result's preview.
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

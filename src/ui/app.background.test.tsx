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

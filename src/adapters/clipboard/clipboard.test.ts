import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyCommand, createClipboard } from './clipboard';

test('the platform copy command: pbcopy, wl-copy on Wayland, else xclip; none elsewhere', () => {
  expect(copyCommand('darwin', {})).toEqual(['pbcopy']);
  expect(copyCommand('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toEqual(['wl-copy']);
  expect(copyCommand('linux', {})).toEqual(['xclip', '-selection', 'clipboard']);
  expect(copyCommand('win32', {})).toBeNull();
});

test('copies via OSC 52 and pipes the text into the copy command', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'resector-clipboard-')), 'copied');
  const osc52: string[] = [];
  const copy = createClipboard({ osc52: text => void osc52.push(text), command: ['sh', '-c', `cat > ${file}`] });
  await copy('héllo\nworld');
  expect(osc52).toEqual(['héllo\nworld']);
  expect(readFileSync(file, 'utf8')).toBe('héllo\nworld');
});

test('without a copy command OSC 52 alone; a failing or missing command is ignored', async () => {
  const osc52: string[] = [];
  await createClipboard({ osc52: text => void osc52.push(text), command: null })('a');
  await createClipboard({ osc52: text => void osc52.push(text), command: ['sh', '-c', 'exit 3'] })('b');
  await createClipboard({ osc52: text => void osc52.push(text), command: ['resector-no-such-command'] })('c');
  expect(osc52).toEqual(['a', 'b', 'c']);
});

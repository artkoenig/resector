// Input tests without a renderer: a dropped file read back as an @path reference.
import { expect, test } from 'bun:test';
import { gateWith, settled } from './gate.harness';

test('a dropped image in the Project becomes its @path reference, which sends the image', async () => {
  const g = gateWith({ files: { 'My Shot.png': '' } });
  const dropped = g.gate.dropped("'/project/My Shot.png'");
  expect(dropped).toBe('@"My Shot.png"');
  g.reply({ content: 'a cat' });
  g.gate.submit(`${dropped} what is it?`);
  await settled(g.gate);
  expect(g.sent[0]!.request.messages[1]).toEqual({
    role: 'user', content: [{ type: 'text', text: '[My Shot.png]' }, { type: 'image_url', image_url: { url: 'data:copy-My Shot.png' } }],
  });
});

test('a dropped image outside the Project keeps its absolute path; a missing or binary file pastes as it is', () => {
  const g = gateWith({ files: { '/Users/me/Desktop/a.png': '', 'data.bin': 'a\0' } });
  expect(g.gate.dropped('file:///Users/me/Desktop/a.png')).toBe('@/Users/me/Desktop/a.png');
  expect(g.gate.dropped('/project/gone.png')).toBeNull();
  expect(g.gate.dropped('/project/data.bin')).toBeNull();
});

test('a dropped text file becomes its @path reference, which sends its content', async () => {
  const g = gateWith({ files: { 'notes.md': 'one\n' } });
  const dropped = g.gate.dropped('/project/notes.md');
  expect(dropped).toBe('@notes.md');
  g.reply({ content: 'ok' });
  g.gate.submit(`${dropped} what is it?`);
  await settled(g.gate);
  expect(g.sent[0]!.request.messages[1]).toEqual({ role: 'user', content: '[notes.md]\none\n' });
});

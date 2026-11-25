// UI tests: @path references, the environment Note and project instructions.
import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameMatching } from '../../test/frames';
import { fake, fixture, line, messages, openedFiles, press, project, start, ui, useHarness, write } from './app.harness';

useHarness();

test('@adds a reference row, not sent; e opens the file; on send it becomes a snapshot Note', async () => {
  writeFileSync(join(project, 'notes.txt'), 'one\ntwo\nthree\n');
  const { events } = await start();
  await write('@notes.txt:2-3');
  let frame = await frameMatching(ui, f => f.includes('1 file reference added') && f.includes('@path reference – read at send'));
  expect(line(frame, /@notes/)).toMatch(/3\s+Note\s+@notes\.txt:2-3\s+.*@ read at send/);
  expect(frame).toContain('@path reference – read at send');
  expect(frame).toContain('[notes.txt:2-3]');
  expect(fake.chatRequests).toEqual([]);
  expect(events().at(-1)).toEqual({ type: 'FileReferenced', id: 3, file: 'notes.txt:2-3' });
  ui.mockInput.pressKey('e');
  await frameMatching(ui, f => f.includes('notes.txt – read at send'));
  expect(openedFiles).toEqual(['notes.txt']);
  writeFileSync(join(project, 'notes.txt'), 'one\nTWO\nthree\n');
  fake.reply({ chunks: ['ok'] });
  await write('explain');
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(line(frame, /@notes/)).not.toContain('@ read at send');
  expect(events().slice(4, 6)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'User', origin: 'user', content: 'explain' },
    { type: 'FileRead', id: 3, content: '[notes.txt:2-3]\n2: TWO\n3: three' },
  ]);
  expect(messages(0).slice(1)).toEqual([
    { role: 'user', content: '[notes.txt:2-3]\n2: TWO\n3: three' },
    { role: 'user', content: 'explain' },
  ]);
});

test('an @path is completed from the project files: ↑↓ choose, Tab or Enter complete', async () => {
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'docs/complete-me.md'), 'x\n');
  writeFileSync(join(project, 'complete-too.txt'), 'y\n');
  const { events } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('@compl');
  let frame = await frameMatching(ui, f => f.includes('docs/complete-me.md') && f.includes('complete-too.txt'));
  expect(frame).toContain('↑↓ choose  tab/enter complete  esc back');
  await press('down');
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('┃ @docs/complete-me.md ') && !f.includes('complete-too.txt'));
  expect(events().some(e => e.type === 'FileReferenced')).toBe(false);
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('1 file reference added'));
  expect(events().at(-1)).toEqual({ type: 'FileReferenced', id: 3, file: 'docs/complete-me.md' });
});

test('↑↓ scroll past the shown @path suggestions; a path with spaces completes quoted', async () => {
  for (let i = 0; i < 10; i++) writeFileSync(join(project, `f${i}.md`), 'x\n');
  writeFileSync(join(project, 'my long screenshot.png'), 'png');
  await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('@');
  let frame = await frameMatching(ui, f => f.includes('f0.md'));
  expect(frame).not.toContain('my long screenshot.png');
  await press('up');
  frame = await frameMatching(ui, f => f.includes('my long screenshot.png'));
  expect(frame).not.toContain('f0.md');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('┃ @"my long screenshot.png" '));
  // The project is shared: these files would be offered in the other tests.
  for (let i = 0; i < 10; i++) rmSync(join(project, `f${i}.md`));
  rmSync(join(project, 'my long screenshot.png'));
});

test('a referenced file missing at send aborts sending', async () => {
  const { events } = await start();
  await write('@gone.txt what is in it?');
  const frame = await frameMatching(ui, f => f.includes('✗ file not found') && f.includes('gone.txt – sending aborted'));
  expect(line(frame, /@gone/)).toMatch(/3\s+Note\s+@gone\.txt\s+.*⚠ not found/);
  expect(fake.chatRequests).toEqual([]);
  expect(events().map(e => e.type)).not.toContain('RequestSent');
});

test('the environment Note follows the Tools Block; a changed environment is a new Revision in place before sending', async () => {
  const { events } = await start({ notes: { environment: 'date: 2026-09-26' } });
  let frame = ui.captureCharFrame();
  expect(line(frame, /Environment/)).toMatch(/3\s+Note\s+Environment\s+\d+/);
  fake.reply({ chunks: ['ok'] });
  await write('hi');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.type === 'Edit')).toEqual([]);
  fixture.environment = 'date: 2026-09-27';
  fake.reply({ chunks: ['ok'] });
  await write('again');
  frame = await frameMatching(ui, f => f.includes('answer complete') && /6\s+User\s+again/.test(f));
  expect(events().filter(e => e.type === 'Edit')).toEqual([{ type: 'Edit', id: 3, revision: 2, content: 'date: 2026-09-27', harness: true }]);
  expect(frame.search(/3\s+Note\s+Environment/)).toBeLessThan(frame.search(/4\s+User\s+hi/));
  expect(messages(1)[1]).toEqual({ role: 'user', content: 'date: 2026-09-27' });
});

test('the project instructions are a Note after the environment', async () => {
  await start({ notes: { environment: 'cwd: /p', instructions: [{ file: 'AGENTS.md', content: '# Rules' }] } });
  const frame = ui.captureCharFrame();
  expect(line(frame, /AGENTS/)).toMatch(/4\s+Note\s+@AGENTS\.md\s+\d+/);
});

test('the Notes a new session starts with ask for no answer', async () => {
  await start({ notes: { environment: 'cwd: /p', instructions: [{ file: 'AGENTS.md', content: '# Rules' }] } });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  expect(fake.chatRequests).toEqual([]);
});

test('a file reference alone whose send failed can be sent again', async () => {
  writeFileSync(join(project, 'again.txt'), 'content');
  await start({ notes: { environment: 'cwd: /p' } });
  await write('@again.txt');
  await frameMatching(ui, f => f.includes('1 file reference added'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('no scripted reply'));
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(messages(0).at(-1)).toEqual({ role: 'user', content: '[again.txt]\ncontent' });
});

test('a file reference alone is sent with Enter, the file as the last user message', async () => {
  writeFileSync(join(project, 'alone.txt'), 'content');
  await start();
  await write('@alone.txt');
  await frameMatching(ui, f => f.includes('1 file reference added'));
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(messages(0).at(-1)).toEqual({ role: 'user', content: '[alone.txt]\ncontent' });
});

test('@image.png adds an Image row; on send the image goes as a data URL after its reference', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  writeFileSync(join(project, 'shot.png'), png);
  const { events } = await start();
  await write('@shot.png');
  let frame = await frameMatching(ui, f => f.includes('1 file reference added'));
  expect(line(frame, /@shot/)).toMatch(/3\s+Image\s+@shot\.png\s+.*@ read at send/);
  fake.reply({ chunks: ['a red square'] });
  await write('what is this?');
  frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().slice(4, 6)).toEqual([
    { type: 'BlockAdded', id: 4, kind: 'User', origin: 'user', content: 'what is this?' },
    { type: 'ImageRead', id: 3, image: `${new Bun.CryptoHasher('sha256').update(png).digest('hex')}.png` },
  ]);
  expect(messages(0).slice(1)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '[shot.png]' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] },
    { role: 'user', content: 'what is this?' },
  ]);
});

test('an @image that is gone at send stops the send', async () => {
  await start();
  await write('@gone.png');
  const frame = await frameMatching(ui, f => f.includes('1 file reference added'));
  expect(line(frame, /@gone/)).toContain('not found');
  await write('look');
  await frameMatching(ui, f => f.includes('sending aborted'));
  expect(fake.chatRequests).toEqual([]);
});

test('an image dropped onto the input goes in as its @path reference; any other paste as it is', async () => {
  writeFileSync(join(project, 'Screen Shot.png'), 'png');
  await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('look');
  await ui.mockInput.pasteBracketedText(`${project}/Screen\\ Shot.png`);
  await frameMatching(ui, f => f.includes('┃ look @"Screen Shot.png" '));
  await ui.mockInput.pasteBracketedText('/elsewhere/gone.png');
  await frameMatching(ui, f => f.includes('@"Screen Shot.png" /elsewhere/gone.png'));
  rmSync(join(project, 'Screen Shot.png'));
});

test('an image dropped onto the Context opens the input with its @path reference', async () => {
  writeFileSync(join(project, 'shot.png'), 'png');
  await start();
  await ui.mockInput.pasteBracketedText(`file://${project}/shot.png`);
  await frameMatching(ui, f => f.includes('┃ @shot.png '));
  rmSync(join(project, 'shot.png'));
});

test('a text file dropped onto the input or the Context goes in as its @path reference', async () => {
  writeFileSync(join(project, 'dropped.md'), 'text\n');
  await start();
  await ui.mockInput.pasteBracketedText(`${project}/dropped.md`);
  await frameMatching(ui, f => f.includes('┃ @dropped.md '));
  await ui.mockInput.pasteBracketedText(`file://${project}/dropped.md`);
  await frameMatching(ui, f => f.includes('┃ @dropped.md @dropped.md '));
  rmSync(join(project, 'dropped.md'));
});

// UI tests: the / commands: suggestions, /rename, /tools, /thinking.
import { expect, test } from 'bun:test';
import { frameMatching } from '../../test/frames';
import type { Tool } from '../core/log/events';
import { bash, fake, line, messages, press, type Sent, start, ui, until, useHarness, withUsers, write } from './app.harness';

useHarness();

test('/thinking sets the thinking mode, shown in the header', async () => {
  await withUsers('question');
  expect(line(await frameMatching(ui, f => f.includes('default')), /default/)).toContain('default · thinking off');
  await write('/thinking on');
  await frameMatching(ui, f => f.includes('default · thinking on'));
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  // The adapter turns it into the chat template's switch.
  expect(fake.chatRequests[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
  await write('/thinking off');
  await frameMatching(ui, f => f.includes('default · thinking off'));
});

test('/thinking offers the modes of the chat template', async () => {
  const { events } = await start({ template: "{% if reasoning_effort not in ('xhigh', 'low') %}{% endif %}" });
  await write('/thinking on:low');
  await frameMatching(ui, f => f.includes('default · thinking on:low'));
  await write('/thinking on:xhigh');
  await frameMatching(ui, f => f.includes('default · thinking on:xhigh'));
  await write('/thinking on:low');
  await frameMatching(ui, f => f.includes('default · thinking on:low'));
  expect(events().filter(e => e.type === 'ThinkingSet').map(e => e.thinking)).toEqual(['low', 'xhigh', 'low']);
});

test('a chat template without thinking: /thinking says so and logs nothing', async () => {
  const { events } = await start({ template: '{{ messages }}' });
  await write('/thinking');
  await frameMatching(ui, f => f.includes('the chat template has no thinking switch'));
  expect(events().some(e => e.type === 'ThinkingSet')).toBe(false);
});

test('typing / suggests the commands, filtered while typing; ↑↓ choose, Enter runs', async () => {
  const { opened } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/');
  let frame = await frameMatching(ui, f => f.includes('/filter'));
  expect(frame).toContain('↑↓ choose  tab complete  enter run  esc back');
  expect(frame).not.toContain('/reload');
  expect(line(frame, /\/sessions/)).toMatch(/\/sessions\s+list, resume, rename, delete sessions/);
  expect(line(frame, /\/rename/)).toMatch(/\/rename <title>\s+rename session/);
  await ui.mockInput.typeText('re');
  frame = await frameMatching(ui, f => !f.includes('/sessions'));
  expect(frame).toContain('/rename');
  ui.mockInput.pressBackspace();
  ui.mockInput.pressBackspace();
  await frameMatching(ui, f => f.includes('/sessions'));
  await press('down');
  // A command with an argument is completed first, then run.
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('┃ /rename') && !f.includes('rename session'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('session title reset'));
  await write('/sessions');
  await until(() => opened.length > 0);
  await write('/nope');
  await frameMatching(ui, f => f.includes('✗ unknown command /nope') && f.includes('/sessions /rename /tools /filter /policy /auto /thinking'));
  // Config is read when a session opens: a change needs a restart (ADR 0001).
  await write('/reload');
  await frameMatching(ui, f => f.includes('✗ unknown command /reload'));
});

test('/ in the Context starts a command in the input line', async () => {
  await start();
  await ui.mockInput.typeText('/');
  const frame = await frameMatching(ui, f => f.includes('/filter'));
  expect(frame).toContain('┃ /');
  await ui.mockInput.typeText('ren');
  await frameMatching(ui, f => f.includes('rename session') && !f.includes('/sessions'));
});

test('Tab completes a command; /rename sets the session title, empty resets it', async () => {
  const { events } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/ren');
  await frameMatching(ui, f => f.includes('rename session'));
  ui.mockInput.pressTab();
  await frameMatching(ui, f => f.includes('┃ /rename '));
  await ui.mockInput.typeText('my  title');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('session renamed: my  title'));
  expect(events().at(-1)).toEqual({ type: 'SessionRenamed', title: 'my  title' });
  await write('/rename');
  await frameMatching(ui, f => f.includes('session title reset to the first User message'));
  expect(events().at(-1)).toEqual({ type: 'SessionRenamed', title: '' });
});

test('/tools completes the tool names and switches one off and on; off, it is not sent', async () => {
  const { events } = await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/tools b');
  let frame = await frameMatching(ui, f => /^ {2}bash\s+on → off/m.test(f));
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('bash off · u = undo'));
  expect(line(frame, /Tools/)).toMatch(/2\s+Tools\s+no tools/);
  expect(events().at(-1)).toMatchObject({ type: 'Edit', id: 2, content: '[]', by: 'user' });
  fake.reply({ chunks: ['ok'] });
  await write('hi');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect((fake.chatRequests[0] as Sent).tools).toBeUndefined();
  await write('/tools bash');
  frame = await frameMatching(ui, f => f.includes('bash on · u = undo'));
  expect(line(frame, /Tools/)).toMatch(/2\s+Tools\s+bash/);
  await write('/tools');
  await frameMatching(ui, f => f.includes('tools: bash · /tools <tool> switches one'));
  await write('/tools python');
  await frameMatching(ui, f => f.includes('unknown tool python – bash search'));
});

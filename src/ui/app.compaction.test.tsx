// UI tests: Compaction: instruction, proposal, review.
import { expect, test } from 'bun:test';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { frameMatching } from '../../test/frames';
import { connectLlamaCpp } from '../adapters/backend/llamacpp';
import { cache, escape, fake, fixture, line, messages, order, press, previewed, type Sent, start, ui, useHarness, withUsers } from './app.harness';

useHarness();

test('c opens the instruction line with header and the default instruction as hint; Tab copies it, Esc cancels', async () => {
  await withUsers('one', 'two');
  await press('c');
  let frame = await frameMatching(ui, f => /◇ Compact 1 block \(6 tok\) · default · request \d+ \/ 4k/.test(f));
  expect(frame).toContain('instruction > keep the gist');
  expect(frame).toMatch(/enter compact\s+tab default\s+esc back/);
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText(' and paths');
  frame = await frameMatching(ui, f => f.includes('instruction > keep the gist and paths'));
  await escape();
  frame = await frameMatching(ui, f => f.includes('compaction cancelled'));
  expect(frame).not.toContain('instruction >');
  expect(fake.chatRequests).toEqual([]);
});

test('the proposal streams at the first source; Enter accepts it as one Note, u restores the sources', async () => {
  const { events } = await withUsers('one', 'two', 'three');
  await press('up');
  await press('up');
  await press(' ');
  await press(' ');
  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 2 blocks'));
  fake.reply({ chunks: ['one', ' and two'], hang: true });
  ui.mockInput.pressEnter();
  let frame = await frameMatching(ui, f => /3\s+Note\s+◇ proposal · 2 blocks/.test(f) && f.includes('one and two'));
  expect(frame).toContain('compacting with default');
  expect(line(frame, /User\s+one/)).toMatch(/◇ proposed/);
  expect(line(frame, /User\s+two/)).toMatch(/◇ proposed/);
  expect(frame).toMatch(/#3 · ◇ proposal · attempt 1 · replaces #4 #5 · "keep the gist"/);
  expect((fake.chatRequests[0] as Sent)).toMatchObject({
    messages: [{ role: 'system' }, { role: 'user', content: '# User\none\n\n# User\ntwo\n\nInstruction: keep the gist' }],
  });
  expect((fake.chatRequests[0] as Sent).tools).toBeUndefined();
  await escape();
  frame = await frameMatching(ui, f => f.includes('compaction aborted – Context unchanged'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two', '5 three']);

  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 2 blocks'));
  fake.reply({ chunks: ['both'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => /◇ 12 → 6 tok \(−50%\) · Context 70 → 64 \/ 4k\s+┃ session cache cold \(same model\/slot\) · cold from #3 after accept/.test(f));
  expect(line(frame, /Note/)).toMatch(/◇ proposal · 2 blocks · att…\s+6\b/);
  expect(frame).toMatch(/enter accept\s+x discard\s+i instruction\s+e edit/);
  await press('d');
  expect(events().at(-1).type).toBe('BlockAdded');
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('◇ accepted: 12 → 6 tok · u = undo'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 ◇', '4 three']);
  frame = await frameMatching(ui, f => /3\s+Note\s+◇ 2 blocks compacted\s+6\b/.test(f));
  expect(frame).not.toContain('●');
  expect(events().at(-1)).toEqual({ type: 'Compact', sources: [3, 4], instruction: 'keep the gist', noteId: 6, content: 'both', by: 'user' });
  await press('u');
  frame = await frameMatching(ui, f => f.includes('undone: compact'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two', '5 three']);
});

test('x discards the proposal; i runs again from the sources with a changed instruction; e edits the proposal', async () => {
  const { events } = await withUsers('one', 'two');
  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 1 block'));
  fake.reply({ chunks: ['first try'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('cold from #4 after accept'));
  await press('x');
  let frame = await frameMatching(ui, f => f.includes('proposal discarded – Context unchanged'));
  expect(order(frame)).toEqual(['1 System', '2 bash', '3 one', '4 two']);

  await press('c');
  await frameMatching(ui, f => f.includes('◇ Compact 1 block'));
  await ui.mockInput.typeText('shorter');
  fake.reply({ chunks: ['first try'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('cold from #4 after accept'));
  await press('i');
  frame = await frameMatching(ui, f => f.includes('instruction > shorter'));
  await escape();
  await frameMatching(ui, f => f.includes('attempt 1 ·') && f.includes('enter accept'));
  await press('i');
  await frameMatching(ui, f => f.includes('instruction > shorter'));
  await ui.mockInput.typeText('!');
  fake.reply({ chunks: ['2nd'] });
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('#4 · ◇ proposal · attempt 2 · replaces #5 · "shorter!"') && f.includes('cold from #4'));
  expect((fake.chatRequests.at(-1) as Sent).messages[1]).toEqual({ role: 'user', content: '# User\ntwo\n\nInstruction: shorter!' });
  fixture.editor = async text => `${text} edited\n`;
  await press('e');
  frame = await frameMatching(ui, f => f.includes('proposal edited by hand') && f.includes('cold from #4'));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('◇ accepted'));
  expect(events().at(-1)).toEqual({ type: 'Compact', sources: [4], instruction: 'shorter!', noteId: 5, content: '2nd edited', by: 'user' });
});

test('a request too big for the compaction window is blocked; Compaction runs on compactionProfile, leaving the session cache', async () => {
  const small = startFakeLlamaCpp({ nCtx: 80 });
  try {
    const backend = await connectLlamaCpp(small.url);
    await start({ compactor: async () => ({ profile: 'small', backend }), users: ['a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(2), 'short'] });
    await press('down');
    await press('down');
    await press('c');
    await frameMatching(ui, f => /◇ Compact 1 block \(\d+ tok\) · small · request \d+ ≥ window 80 – does not fit/.test(f));
    ui.mockInput.pressEnter();
    let frame = await frameMatching(ui, f => /compaction request \d+ ≥ window 80 of small – shrink the selection/.test(f));
    expect(small.chatRequests).toEqual([]);
    await escape();
    await press('down');
    await frameMatching(ui, f => previewed(f) === 'short');
    await press('c');
    frame = await frameMatching(ui, f => /request \d+ \/ 80/.test(f));
    const request = Number(/request (\d+) \/ 80/.exec(frame)![1]);
    small.reply({ chunks: ['s'] });
    ui.mockInput.pressEnter();
    frame = await frameMatching(ui, f => f.includes('session cache untouched'));
    expect(small.chatRequests).toHaveLength(1);
    // The proposal may use the rest of the Compaction profile's window.
    expect(small.chatRequests[0]).toMatchObject({ max_tokens: 80 - request });
    expect(fake.chatRequests).toEqual([]);
  } finally {
    small.stop();
  }
});

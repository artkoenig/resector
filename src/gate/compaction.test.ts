// The user's Compaction without a renderer: instruction, proposal, accept, discard, refine, edit, window.
import { expect, test } from 'bun:test';
import { gateWith, ofType, scriptedBackend, settled, until } from './gate.harness';

// The Gate with User blocks 3.., Compaction opened on the marked ones.
async function compacting(users: string[], marked: number[], setup: Parameters<typeof gateWith>[0] = {}) {
  const g = gateWith({ users, ...setup });
  await until(() => g.gate.budget() !== null);
  g.mark(...marked);
  g.gate.startCompaction();
  await until(() => g.gate.compacting()?.phase === 'instruction');
  return g;
}
const order = (g: ReturnType<typeof gateWith>) => g.gate.context().blocks.map(b => b.id);

test('the proposal is asked for the sources with the default instruction; Esc aborts it, the Context unchanged', async () => {
  const g = await compacting(['one', 'two', 'three'], [3, 4]);
  g.reply({ content: 'one and two', hang: true });
  g.gate.runCompaction('');
  await until(() => g.gate.compacting()?.text === 'one and two');
  expect(g.sent[0]!.request).toMatchObject({
    messages: [{ role: 'system' }, { role: 'user', content: '# User\none\n\n# User\ntwo\n\nInstruction: keep the gist' }],
    tools: [],
  });
  g.gate.abort();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('compaction aborted – Context unchanged');
  expect(g.gate.compacting()).toBeNull();
  expect(order(g)).toEqual([1, 2, 3, 4, 5]);
});

test('Enter accepts the proposal as one Note attributed to the user; u restores the sources', async () => {
  const g = await compacting(['one', 'two', 'three'], [3, 4]);
  g.reply({ content: 'both' });
  g.gate.runCompaction('');
  await until(() => g.gate.review() !== null);
  expect(g.gate.review()).toMatchObject({ tokens: '20 → 10 tok (−50%) · Context 50 → 40 / 4k', cold: true });
  g.gate.acceptCompaction();
  expect(g.gate.status()?.text).toBe('◇ accepted: 20 → 10 tok · u = undo');
  expect(g.events.at(-1)).toEqual({ type: 'Compact', sources: [3, 4], instruction: 'keep the gist', noteId: 6, content: 'both', by: 'user' });
  expect(order(g)).toEqual([1, 2, 6, 5]);
  g.gate.undo();
  expect(order(g)).toEqual([1, 2, 3, 4, 5]);
});

test('x discards the proposal; Esc on a first instruction cancels', async () => {
  const g = await compacting(['one', 'two'], [4]);
  g.reply({ content: 'first try' });
  g.gate.runCompaction('');
  await until(() => g.gate.review() !== null);
  g.gate.discardCompaction();
  expect(g.gate.status()?.text).toBe('proposal discarded – Context unchanged');
  expect(order(g)).toEqual([1, 2, 3, 4]);
  g.gate.startCompaction();
  await until(() => g.gate.compacting()?.phase === 'instruction');
  g.gate.leaveInstruction();
  expect(g.gate.status()?.text).toBe('compaction cancelled');
  expect(ofType(g.events, 'Compact')).toEqual([]);
});

test('i runs again from the sources with a changed instruction; e edits the proposal, which accept adds', async () => {
  const g = await compacting(['one', 'two'], [4], { editor: async text => `${text} edited\n` });
  g.reply({ content: 'first try' }, { content: '2nd' });
  g.gate.runCompaction('shorter');
  await until(() => g.gate.review() !== null);
  g.gate.refine();
  expect(g.gate.compacting()).toMatchObject({ phase: 'instruction', draft: 'shorter' });
  g.gate.leaveInstruction();
  expect(g.gate.compacting()).toMatchObject({ phase: 'review', attempt: 1 });
  g.gate.refine();
  g.gate.runCompaction('shorter!');
  await until(() => g.gate.compacting()?.attempt === 2 && g.gate.review() !== null);
  expect(g.sent.at(-1)!.request.messages[1]).toEqual({ role: 'user', content: '# User\ntwo\n\nInstruction: shorter!' });
  g.gate.editProposal();
  await until(() => g.gate.status()?.text === 'proposal edited by hand');
  await until(() => g.gate.review() !== null);
  g.gate.acceptCompaction();
  expect(g.events.at(-1)).toEqual({ type: 'Compact', sources: [4], instruction: 'shorter!', noteId: 5, content: '2nd edited', by: 'user' });
});

test('a request too big for the compaction window is blocked; Compaction runs on compactionProfile, leaving the session cache', async () => {
  const small = scriptedBackend({ window: 8 });
  const g = await compacting(['long', 'short'], [3], { compactor: { profile: 'small', backend: small.backend } });
  g.gate.runCompaction('');
  await until(() => g.gate.compacting()?.phase === 'instruction');
  expect(g.gate.status()?.text).toBe('compaction request 10 ≥ window 8 of small – shrink the selection (Esc, then d / e)');
  expect(small.sent).toEqual([]);
  small.backend.window = 80;
  small.reply({ content: 's' });
  g.gate.runCompaction('');
  await until(() => g.gate.review() !== null);
  expect(g.gate.review()).toMatchObject({ cold: false, cache: expect.stringContaining('session cache untouched') });
  // The proposal may use the rest of the Compaction profile's window.
  expect(small.sent[0]!.maxTokens).toBe(80 - 10);
  expect(g.sent).toEqual([]);
});

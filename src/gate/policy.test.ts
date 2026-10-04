// Context Policy tests without a renderer (ADR 0001): passes before each request, attribution, failures, Compaction.
import { expect, test } from 'bun:test';
import { BUILT_IN } from '../core/policy/built-in';
import { LEAD } from '../core/policy/lean-compact';
import type { Policy, PolicyOperation } from '../core/policy/policy';
import { bash, gateWith, ofType, scriptedBackend, settled, until } from './gate.harness';

// A policy returning `passes` in turn, then nothing; `seen`: the block ids of each Context it was called with.
function scripted(name: string, passes: PolicyOperation[][], seen: number[][] = []): Policy {
  let pass = 0;
  return { name, run: context => (seen.push(context.blocks.map(b => b.id)), passes[pass++] ?? []) };
}

// The Gate with the policies, the first one switched on.
function policed(setup: Parameters<typeof gateWith>[0] & { policies: Policy[] }) {
  const g = gateWith(setup);
  g.gate.submit(`/policy ${setup.policies[0]!.name}`);
  return g;
}

test('the active policy edits the Context before the request, attributed to it, until it returns nothing', async () => {
  const seen: number[][] = [];
  const g = policed({ users: ['old', 'older'], policies: [scripted('trim', [[{ op: 'remove', id: 3 }], [{ op: 'edit', id: 4, content: 'newer' }]], seen)] });
  g.reply({ content: 'ok' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('trim: 1 User removed, 1 block edited · answer complete');
  expect(seen).toEqual([[1, 2, 3, 4], [1, 2, 4], [1, 2, 4]]);
  expect(g.events.slice(5, 7)).toEqual([{ type: 'Remove', id: 3, by: 'trim' }, { type: 'Edit', id: 4, revision: 2, content: 'newer', by: 'trim' }]);
  expect(JSON.stringify(g.sent[0]!.request)).not.toContain('old');
});

test('the policy runs before every request, the follow-ups of the tool loop too; an undone operation comes back', async () => {
  const seen: number[][] = [];
  const drop: Policy = { name: 'drop', run: context => (seen.push([]), context.blocks.filter(b => b.kind === 'User' && b.content === 'drop me').map(b => ({ op: 'remove', id: b.id }))) };
  const g = policed({ users: ['drop me'], policies: [drop] });
  g.reply({ calls: [bash('ls -d .')] }, { content: 'ok' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.sent).toHaveLength(2);
  expect(seen).toHaveLength(3);
  g.gate.undo();
  expect(g.gate.status()?.text).toStartWith('undone: remove');
  g.reply({ content: 'again' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('drop: 1 User removed · answer complete');
  expect(ofType(g.events, 'Remove')).toEqual([{ type: 'Remove', id: 3, by: 'drop' }, { type: 'Remove', id: 3, by: 'drop' }]);
});

test('a policy that throws, or still changes the Context after 8 passes, stops the Gate: nothing is sent', async () => {
  const boom: Policy = { name: 'boom', run: () => { throw new Error('bad rule'); } };
  const endless: Policy = { name: 'endless', run: context => [{ op: 'edit', id: 3, content: `${context.blocks.find(b => b.id === 3)!.content}!` }] };
  const g = policed({ users: ['hi'], policies: [boom, endless] });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()).toMatchObject({ text: 'policy boom: failed: bad rule – not sent', tone: 'error' });
  g.gate.submit('/policy endless');
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('policy endless: still changing the Context after 8 passes – not sent · endless: 8 blocks edited');
  expect(g.sent).toEqual([]);
  expect(ofType(g.events, 'RequestSent')).toEqual([]);
  expect(ofType(g.events, 'Edit').at(-1)).toMatchObject({ content: 'hi!!!!!!!!', by: 'endless' });
});

test('an operation the rules refuse stops the Gate and names it', async () => {
  const g = policed({ users: ['hi'], policies: [scripted('bad', [[{ op: 'remove', id: 1 }]])] });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('policy bad: remove 1: System prompt cannot be removed – not sent');
  expect(g.sent).toEqual([]);
});

test('a policy compacts: the Compaction runs without review, its Note is attributed; the request follows', async () => {
  const g = policed({ users: ['a', 'b', 'c'], policies: [scripted('squash', [[{ op: 'compact', sources: [3, 4], instruction: 'merge' }]])] });
  g.reply({ content: 'a and b' }, { content: 'ok' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('squash: 2 User → 1 Note · answer complete');
  expect(ofType(g.events, 'Compact')).toEqual([{ type: 'Compact', sources: [3, 4], instruction: 'merge', noteId: 6, content: 'a and b', by: 'squash' }]);
  expect(g.sent).toHaveLength(2);
  expect(JSON.stringify(g.sent[0]!.request)).toContain('Instruction: merge');
  expect(JSON.stringify(g.sent[1]!.request)).toContain('a and b');
});

test('a policy Compaction that writes nothing stops the Gate: nothing is sent', async () => {
  const g = policed({ users: ['a', 'b'], policies: [scripted('squash', [[{ op: 'compact', sources: [3], instruction: 'merge' }]])] });
  g.reply({ content: ' ' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('policy squash: compact 3: compaction failed: empty Note – not sent');
  expect(g.sent).toHaveLength(1);
  expect(g.events.some(e => e.type === 'Compact' || e.type === 'RequestSent')).toBe(false);
});

test('Esc while the policy runs stops the loop after the answer that follows', async () => {
  const squash: Policy = { name: 'squash', run: c => (c.blocks.some(b => b.id === 3) ? [{ op: 'compact', sources: [3], instruction: 'merge' }] : []) };
  const g = policed({ users: ['long', 'short'], policies: [squash] });
  g.reply({ content: 'brief', delay: 100 }, { calls: [bash('ls -d .')] });
  const sending = g.gate.send();
  await until(() => g.sent.length === 1);
  g.gate.abort();
  expect(g.gate.stopping()).toBe(true);
  await sending;
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('squash: 1 User → 1 Note · stopped – make your changes, Enter goes on');
  expect(g.ran).toEqual([]);
});

test('a policy Compaction runs on compactionProfile; too big for its window, cut off or aborted, it stops the Gate', async () => {
  const small = scriptedBackend({ window: 8 });
  const squash = (id: number): Policy => ({ name: `squash${id}`, run: c => (c.blocks.some(b => b.id === id) ? [{ op: 'compact', sources: [id], instruction: 'merge' }] : []) });
  const g = policed({ compactor: { profile: 'small', backend: small.backend }, users: ['long', 'short'], policies: [squash(3), squash(4)] });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('policy squash3: compact 3: compaction failed: request 10 ≥ window 8 – not sent');
  small.backend.window = 4096;
  g.gate.submit('/policy squash4');
  small.reply({ content: 'cut', finish: 'length' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('policy squash4: compact 4: compaction failed: cut off at max_tokens – not sent');
  small.reply({ content: 'wait', hang: true });
  const sending = g.gate.send();
  await until(() => small.sent.length === 2);
  g.gate.abort();
  expect(g.gate.stopping()).toBe(true);
  g.gate.abort();
  await sending;
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('policy squash4: compact 4: compaction failed: aborted – not sent');
  small.reply({ content: 'brief' });
  g.reply({ content: 'ok' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()?.text).toBe('squash4: 1 User → 1 Note · answer complete');
  expect(small.sent).toHaveLength(3);
  expect(g.sent).toHaveLength(1);
  expect(ofType(g.events, 'Compact')).toMatchObject([{ sources: [4], content: 'brief', by: 'squash4' }]);
});

test('a request failing after the policy ran still says what the policy did', async () => {
  const g = policed({ users: ['old', 'new'], policies: [scripted('trim', [[{ op: 'remove', id: 3 }]])] });
  g.reply({ error: 'server overloaded' });
  await g.gate.send();
  await settled(g.gate);
  expect(g.gate.status()?.text).toContain('backend error');
  expect(g.gate.status()?.text).toContain('trim: 1 User removed');
});

test('lean-compact: the Note of its Compaction is sent led by the lead, which says it is the model\'s own work', async () => {
  const g = policed({ window: 90, users: ['fix x'], policies: BUILT_IN });
  g.reply({ content: 'fixed' }, { content: '## Goal\nfix x' }, { content: 'ok' });
  await g.gate.send();
  await settled(g.gate);
  g.gate.submit('next');
  await settled(g.gate);
  const messages = g.sent.at(-1)!.request.messages.map(m => m.content);
  expect(messages.slice(-3)).toEqual([LEAD, '## Goal\nfix x', 'next']);
});

test('guided-compaction: the model compacts the Context as sent, the first User message and the reads it keeps stay, the others go', async () => {
  const g = policed({ window: 160, users: ['fix x'], policies: [BUILT_IN.find(p => p.name === 'guided-compaction')!] });
  g.reply({ calls: [bash('cat a.ts')] }, { calls: [bash('cat b.ts')] }, { content: 'fixed' }, { content: 'x\n## Keep\n- b.ts' }, { content: 'ok' });
  await g.gate.send();
  await settled(g.gate);
  g.gate.submit('next');
  await settled(g.gate);
  const [compaction, last] = g.sent.slice(-2).map(s => s.request.messages.map(m => m.content));
  expect(compaction!.at(-1)).toStartWith('Accumulate the knowledge in this conversation');
  expect(JSON.stringify(compaction)).toContain('ran cat a.ts');
  expect(last!.slice(1)).toEqual(['fix x', '', 'ran cat b.ts\n[exit 0]', LEAD, '## Facts\nx\n## Keep\n- b.ts', 'next']);
  expect(JSON.stringify(last)).not.toContain('ran cat a.ts');
  expect(g.gate.status()?.text).toBe('guided-compaction: 1 Assistant → 1 Note, 1 Note added, 1 Tool Pair removed · answer complete');
});

// UI tests: Context Policies (ADR 0001).
import { expect, test } from 'bun:test';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { frameMatching } from '../../test/frames';
import { connectLlamaCpp } from '../adapters/backend/llamacpp';
import type { Policy, PolicyOperation } from '../core/policy/policy';
import { bash, escape, fake, line, press, start, ui, useHarness, write } from './app.harness';

useHarness();

// A policy returning `passes` in turn, then nothing; `seen`: the block ids of each Context it was called with.
function scripted(name: string, passes: PolicyOperation[][], seen: number[][] = []): Policy {
  let pass = 0;
  return { name, run: context => (seen.push(context.blocks.map(b => b.id)), passes[pass++] ?? []) };
}

async function policyOn(name: string) {
  await write(`/policy ${name}`);
  await frameMatching(ui, f => f.includes(`policy ${name} on`));
}

test('/policy suggests the policies with their description, switches one on and off; the header shows the active one (ADR 0001)', async () => {
  await start({ policies: [{ ...scripted('trail', []), description: 'keeps a trail' }, scripted('tidy', [])] });
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/policy ');
  let frame = await frameMatching(ui, f => f.includes('switch on'));
  expect(line(frame, /trail/)).toMatch(/trail +keeps a trail/);
  expect(line(frame, /tidy/)).toMatch(/tidy +switch on/);
  expect(frame).not.toMatch(/off +no policy/);
  ui.mockInput.pressEnter();
  frame = await frameMatching(ui, f => f.includes('policy trail on – edits the Context before every request'));
  expect(line(frame, /default/)).toMatch(/default · thinking off · policy trail +52/);
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/policy ');
  frame = await frameMatching(ui, f => f.includes('no policy'));
  expect(frame).toMatch(/trail +active · keeps a trail/);
  await escape();
  await escape();
  await write('/policy');
  await frameMatching(ui, f => f.includes('policy trail · /policy off trail tidy'));
  await write('/policy nope');
  await frameMatching(ui, f => f.includes('unknown policy nope') && f.includes('off trail tidy'));
  await write('/policy off');
  frame = await frameMatching(ui, f => f.includes('policy off'));
  expect(line(frame, /default/)).toMatch(/default · thinking off +52/);
});

test('the active policy edits the Context before the request, attributed to it, until it returns nothing', async () => {
  const seen: number[][] = [];
  const { events } = await start({ users: ['old', 'older'], policies: [scripted('trim', [[{ op: 'remove', id: 3 }], [{ op: 'edit', id: 4, content: 'newer' }]], seen)] });
  await policyOn('trim');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).toContain('trim: 1 User removed, 1 block edited · answer complete');
  expect(seen).toEqual([[1, 2, 3, 4], [1, 2, 4], [1, 2, 4]]);
  expect(events().slice(5, 7)).toEqual([{ type: 'Remove', id: 3, by: 'trim' }, { type: 'Edit', id: 4, revision: 2, content: 'newer', by: 'trim' }]);
  expect(JSON.stringify(fake.chatRequests[0])).not.toContain('old');
});

test('the policy runs before every request, the follow-ups of the tool loop too; an undone operation comes back', async () => {
  const seen: number[][] = [];
  const again: Policy = { name: 'drop', run: context => (seen.push([]), context.blocks.filter(b => b.kind === 'User' && b.content === 'drop me').map(b => ({ op: 'remove', id: b.id }))) };
  const { events } = await start({ users: ['drop me'], policies: [again] });
  await policyOn('drop');
  fake.reply({ chunks: [], calls: [bash('ls -d .')] });
  fake.reply({ chunks: ['ok'] });
  await write('go');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(fake.chatRequests).toHaveLength(2);
  expect(seen).toHaveLength(3);
  await press('u');
  await frameMatching(ui, f => f.includes('undone: remove'));
  fake.reply({ chunks: ['again'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('drop: 1 User removed · answer complete'));
  expect(events().filter(e => e.type === 'Remove')).toEqual([{ type: 'Remove', id: 3, by: 'drop' }, { type: 'Remove', id: 3, by: 'drop' }]);
});

test('a policy that throws, or still changes the Context after 8 passes, stops the Gate: nothing is sent', async () => {
  const boom: Policy = { name: 'boom', run: () => { throw new Error('bad rule'); } };
  const endless: Policy = { name: 'endless', run: context => [{ op: 'edit', id: 3, content: `${context.blocks.find(b => b.id === 3)!.content}!` }] };
  const { events } = await start({ users: ['hi'], policies: [boom, endless] });
  await policyOn('boom');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('✗ policy boom') && f.includes('failed: bad rule – not sent'));
  await policyOn('endless');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('✗ policy endless') && f.includes('still changing the Context after 8 passes – not sent · endless: 8 blocks'));
  expect(fake.chatRequests).toHaveLength(0);
  expect(events().filter(e => e.type === 'RequestSent')).toEqual([]);
  expect(events().filter(e => e.type === 'Edit').at(-1)).toMatchObject({ content: 'hi!!!!!!!!', by: 'endless' });
});

test('an operation the rules refuse stops the Gate and names it', async () => {
  await start({ users: ['hi'], policies: [scripted('bad', [[{ op: 'remove', id: 1 }]])] });
  await policyOn('bad');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('✗ policy bad') && f.includes('remove 1: System prompt cannot be removed – not sent'));
  expect(fake.chatRequests).toHaveLength(0);
});

test('a policy compacts: the Compaction runs without review, its Note is attributed; the request follows', async () => {
  const { events } = await start({ users: ['a', 'b', 'c'], policies: [scripted('squash', [[{ op: 'compact', sources: [3, 4], instruction: 'merge' }]])] });
  await policyOn('squash');
  fake.reply({ chunks: ['a and b'] });
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).toContain('squash: 2 User → 1 Note · answer complete');
  expect(events().find(e => e.type === 'Compact')).toEqual({ type: 'Compact', sources: [3, 4], instruction: 'merge', noteId: 6, content: 'a and b', by: 'squash' });
  expect(fake.chatRequests).toHaveLength(2);
  expect(JSON.stringify(fake.chatRequests[0])).toContain('Instruction: merge');
  expect(JSON.stringify(fake.chatRequests[1])).toContain('a and b');
});

test('a policy Compaction that writes nothing stops the Gate: nothing is sent', async () => {
  const { events } = await start({ users: ['a', 'b'], policies: [scripted('squash', [[{ op: 'compact', sources: [3], instruction: 'merge' }]])] });
  await policyOn('squash');
  fake.reply({ chunks: [' '] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('✗ policy squash') && f.includes('compact 3: compaction failed: empty Note – not sent'));
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().some(e => e.type === 'Compact' || e.type === 'RequestSent')).toBe(false);
});

test('a policy Compaction runs on compactionProfile; too big for its window, cut off or aborted, it stops the Gate', async () => {
  const small = startFakeLlamaCpp({ nCtx: 80 });
  try {
    const backend = await connectLlamaCpp(small.url);
    const long = 'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(2);
    const squash = (id: number): Policy => ({ name: `squash${id}`, run: c => (c.blocks.some(b => b.id === id) ? [{ op: 'compact', sources: [id], instruction: 'merge' }] : []) });
    const { events } = await start({ compactor: async () => ({ profile: 'small', backend }), users: [long, 'short'], policies: [squash(3), squash(4)] });
    await policyOn('squash3');
    ui.mockInput.pressEnter();
    await frameMatching(ui, f => /compact 3: compaction failed: request \d+ ≥ window 80/.test(f));
    await policyOn('squash4');
    small.reply({ chunks: ['cut'], finish: 'length' });
    ui.mockInput.pressEnter();
    await frameMatching(ui, f => f.includes('compaction failed: cut off at max_tokens – not sent'));
    small.reply({ chunks: ['wait'], hang: true });
    ui.mockInput.pressEnter();
    await frameMatching(ui, f => /[\u2800-\u28ff] policy squash4 running/.test(f));
    await escape();
    await frameMatching(ui, f => f.includes('compaction failed: aborted – not sent'));
    small.reply({ chunks: ['brief'] });
    fake.reply({ chunks: ['ok'] });
    ui.mockInput.pressEnter();
    await frameMatching(ui, f => f.includes('squash4: 1 User → 1 Note · answer complete'));
    expect(small.chatRequests).toHaveLength(3);
    expect(fake.chatRequests).toHaveLength(1);
    expect(events().find(e => e.type === 'Compact')).toMatchObject({ sources: [4], content: 'brief', by: 'squash4' });
  } finally {
    small.stop();
  }
});

test('a request failing after the policy ran still says what the policy did', async () => {
  await start({ users: ['old', 'new'], policies: [scripted('trim', [[{ op: 'remove', id: 3 }]])] });
  await policyOn('trim');
  fake.reply({ chunks: [], error: 'server overloaded' });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('backend error') && f.includes('trim: 1 User removed'));
});

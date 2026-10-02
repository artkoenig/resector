// UI tests: Context Policies (ADR 0001).
import { expect, test } from 'bun:test';
import { frameMatching } from '../../test/frames';
import type { Policy, PolicyOperation } from '../core/policy/policy';
import { escape, fake, line, start, ui, useHarness, write } from './app.harness';

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

test('an operation the rules refuse stops the Gate and names it', async () => {
  await start({ users: ['hi'], policies: [scripted('bad', [[{ op: 'remove', id: 1 }]])] });
  await policyOn('bad');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('✗ policy bad') && f.includes('remove 1: System prompt cannot be removed – not sent'));
  expect(fake.chatRequests).toHaveLength(0);
});

test('Esc while the policy runs: the status and the hint say the loop stops after the answer', async () => {
  let done = () => {};
  const slow: Policy = { name: 'slow', run: () => new Promise(resolve => (done = () => resolve([]))) };
  await start({ users: ['hi'], policies: [slow] });
  await policyOn('slow');
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  expect(await frameMatching(ui, f => f.includes('policy slow running'))).toContain('esc stop after');
  await escape();
  expect(await frameMatching(ui, f => f.includes('policy slow running · stops after this answer'))).toContain('esc abort');
  done();
  await frameMatching(ui, f => f.includes('answer complete'));
});

// UI tests: the Question dock (#33–#36).
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { frameMatching } from '../../test/frames';
import { BASH_TOOLS } from '../../test/requests';
import { TOOLS } from '../core/toolcall/bash';
import type { Tool } from '../core/log/events';
import { bash, escape, fake, fixture, line, press, project, type Sent, start, ui, useHarness, write } from './app.harness';

useHarness();

const RUNTIME = { question: 'Which runtime should we use?', header: 'Runtime', options: [{ label: 'Node', description: 'common' }, { label: 'Bun', description: 'fast' }], recommended: 'Bun' };

const questionCall = (...questions: object[]) => ({ name: 'question', arguments: JSON.stringify({ questions }) });

// The model answers `go` with a Question; the dock opens.
async function questioned(...questions: object[]) {
  const started = await start({ tools: TOOLS });
  fake.reply({ chunks: [], calls: [questionCall(...questions)] });
  await write('go');
  await frameMatching(ui, f => f.includes('own answer'));
  return started;
}

// The Tool Result the model got for the Question.
const answerSent = () => (fake.chatRequests[1] as Sent).messages.at(-1);

// Moves the dock's cursor `downs` rows down, then Enter picks that row.
async function choose(downs: number) {
  for (let i = 0; i < downs; i++) await press('down');
  ui.mockInput.pressEnter();
  await ui.flush();
}

test('a Question opens the dock: the Recommended Option on top, marked and preselected; Enter answers and sends (#33)', async () => {
  const { events } = await questioned(RUNTIME);
  const frame = ui.captureCharFrame();
  expect((fake.chatRequests[0] as Sent).tools!.map(t => t.function.name)).toEqual(['bash', 'question']);
  expect(line(frame, /Tool Call/)).toMatch(/4\s+Tool Call\s+question Which runtime shou….*\? answer/);
  expect(frame).not.toContain('? approve');
  expect(frame).toContain('Which runtime should we use?');
  expect(line(frame, /› Bun/)).toMatch(/› Bun .*recommended.*fast/);
  expect(line(frame, /┃ +Node/)).toMatch(/^┃ +Node .*common/);
  expect(line(frame, /own answer/)).toMatch(/^┃ +own answer/);
  // The dock takes the prompt band's place: nothing can be written there.
  expect(frame).not.toContain('Tab to write');
  fake.reply({ chunks: ['great'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(ui.captureCharFrame()).not.toContain('own answer');
  expect(events().filter(e => e.kind === 'Tool Result')).toEqual([
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'user', content: 'Which runtime should we use?: Bun', call: 4 },
  ]);
  expect(answerSent()).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'Which runtime should we use?: Bun' });
});

test('↑↓ move, Enter picks; own answer takes free text (#33)', async () => {
  await questioned(RUNTIME);
  fake.reply({ chunks: ['ok'] });
  await choose(1);
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(answerSent()).toMatchObject({ content: 'Which runtime should we use?: Node' });
  ui.renderer.destroy();
  fake.stop();

  await questioned(RUNTIME);
  await press('down');
  await press('down');
  await press('up');
  await press('down');
  await frameMatching(ui, f => /› own answer/.test(f));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer >'));
  await ui.mockInput.typeText('Deno 2');
  // Typed in the own answer's row.
  expect(line(await frameMatching(ui, f => f.includes('Deno 2')), /answer >/)).toMatch(/^┃ +› answer > Deno 2/);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(answerSent()).toMatchObject({ content: 'Which runtime should we use?: Deno 2' });
});

test('a Question without a valid Recommended Option goes back to the model as error; the user never sees it (#33)', async () => {
  const { events } = await start({ tools: TOOLS });
  fake.reply({ chunks: [], calls: [questionCall({ ...RUNTIME, recommended: 'Deno' })] });
  fake.reply({ chunks: ['sorry'] });
  await write('go');
  const frame = await frameMatching(ui, f => f.includes('answer complete'));
  expect(frame).not.toContain('own answer');
  expect(answerSent()).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'error: question 1: recommended "Deno" is not an option label' });
  expect(events().filter(e => e.kind === 'Tool Result')).toEqual([
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'error: question 1: recommended "Deno" is not an option label', call: 4 },
  ]);
});

test('questions given as a JSON string open the dock like a list', async () => {
  await start({ tools: TOOLS });
  fake.reply({ chunks: [], calls: [{ name: 'question', arguments: JSON.stringify({ questions: JSON.stringify([RUNTIME]) }) }] });
  await write('go');
  expect(await frameMatching(ui, f => f.includes('own answer'))).toContain('Which runtime should we use?');
});

test('a Question the dock cannot show goes back to the model as error, not as a crash', async () => {
  const { events } = await start({ tools: TOOLS });
  fake.reply({ chunks: [], calls: [{ name: 'question', arguments: JSON.stringify({ questions: [{ ...RUNTIME, options: 'Node or Bun' }] }) }] });
  fake.reply({ chunks: ['sorry'] });
  await write('go');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.kind === 'Tool Result')).toEqual([
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'error: question 1: at least 2 options', call: 4 },
  ]);
});

// Question: several questions & multi-select (#34) ------------------------------------------------------------
const LINTERS = {
  question: 'Which linters should run?',
  header: 'Linters',
  options: [{ label: 'ESLint', description: 'plugins' }, { label: 'Biome', description: 'fast' }, { label: 'Oxlint', description: 'faster' }],
  multiple: true,
  recommended: ['Biome', 'Oxlint'],
};

test('several questions: one tab each plus Confirm; `multiple` toggles, its Recommended Options preselected (#34)', async () => {
  await questioned(RUNTIME, LINTERS);
  let frame = ui.captureCharFrame();
  expect(line(frame, /Confirm/)).toMatch(/Runtime.*Linters.*Confirm/);
  expect(line(frame, /› Bun/)).toMatch(/› Bun .*recommended/);
  await choose(0);
  frame = await frameMatching(ui, f => f.includes('[✓]'));
  expect(frame).toContain('Which linters should run?');
  expect(line(frame, /Biome/)).toMatch(/› \[✓\] Biome .*recommended/);
  expect(line(frame, /Oxlint/)).toMatch(/ \[✓\] Oxlint .*recommended/);
  expect(line(frame, /ESLint/)).toMatch(/ \[ \] ESLint/);
  await choose(2);
  await press('up');
  await press('up');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => /\[✓\] ESLint/.test(f) && /\[ \] Biome/.test(f));
  ui.mockInput.pressArrow('right');
  frame = await frameMatching(ui, f => f.includes('enter sends'));
  expect(line(frame, /^┃\s+Runtime/)).toMatch(/Runtime\s+Bun/);
  expect(line(frame, /^┃\s+Linters/)).toMatch(/Linters\s+ESLint, Oxlint/);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(answerSent()).toMatchObject({ content: `${RUNTIME.question}: Bun\nWhich linters should run?: ESLint, Oxlint` });
});

test('skipped questions come back as Unanswered; ←→ switch tabs (#34)', async () => {
  await questioned(RUNTIME, LINTERS);
  ui.mockInput.pressArrow('right');
  await ui.flush();
  await frameMatching(ui, f => f.includes('Which linters should run?'));
  ui.mockInput.pressArrow('left');
  await ui.flush();
  await frameMatching(ui, f => f.includes('Which runtime should we use?'));
  ui.mockInput.pressArrow('right');
  await frameMatching(ui, f => f.includes('Which linters should run?'));
  await choose(0);
  await choose(1);
  ui.mockInput.pressArrow('right');
  await frameMatching(ui, f => f.includes('enter sends'));
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(answerSent()).toMatchObject({ content: `${RUNTIME.question}: Unanswered\nWhich linters should run?: Unanswered` });
});

test('r fills the unanswered questions with their Recommended Options and jumps to Confirm; own answers join the toggles (#34)', async () => {
  await questioned(RUNTIME, LINTERS, { ...RUNTIME, question: 'Which package manager?', header: 'Packages' });
  await choose(1);
  await frameMatching(ui, f => f.includes('Which linters should run?'));
  await choose(3);
  await frameMatching(ui, f => f.includes('answer >'));
  await ui.mockInput.typeText('Prettier');
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => /\[✓\] own answer: Prettier/.test(f));
  await press('r');
  const frame = await frameMatching(ui, f => f.includes('enter sends'));
  expect(line(frame, /^┃\s+Packages/)).toMatch(/Packages\s+Bun/);
  fake.reply({ chunks: ['ok'] });
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(answerSent()).toMatchObject({ content: `${RUNTIME.question}: Node\nWhich linters should run?: Biome, Oxlint, Prettier\nWhich package manager?: Bun` });
});

// Question: decline, resume, ordering (#35) --------------------------------------------------------------------
test('Esc declines the Question: its Tool Result says declined, the loop stops at the Gate (#35)', async () => {
  const { events } = await questioned(RUNTIME, LINTERS);
  await escape();
  const frame = await frameMatching(ui, f => f.includes('question declined – review the results, Enter sends'));
  expect(frame).not.toContain('own answer');
  expect(fake.chatRequests).toHaveLength(1);
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'declined', call: 4 });
});

test('resuming with an unanswered Question reopens the dock, after the earlier calls are decided (#35)', async () => {
  const { events } = await start({ tools: TOOLS, users: ['go'], calls: ['ls -d .', { tool: 'question', content: JSON.stringify({ questions: [RUNTIME] }) }] });
  const frame = await frameMatching(ui, f => f.includes('own answer'));
  expect(line(frame, /› Bun/)).toMatch(/› Bun .*recommended/);
  expect(events().at(-1)).toMatchObject({ kind: 'Tool Result', content: '.\n[exit 0]', call: 4 });
  fake.reply({ chunks: ['ok'] });
  await choose(1);
  await frameMatching(ui, f => f.includes('answer complete'));
  expect((fake.chatRequests[0] as Sent).messages.at(-1)).toMatchObject({ role: 'tool', content: 'Which runtime should we use?: Node' });
});

test('mixed bash and question calls are decided in order: the Question waits for the earlier calls, later ones wait for it (#35)', async () => {
  const { events } = await start({ tools: TOOLS });
  fake.reply({ chunks: [], calls: [bash('touch first.txt'), questionCall(RUNTIME), bash('touch last.txt')] });
  await write('go');
  let frame = await frameMatching(ui, f => /Tool Call\s+touch first\.txt.*\? approve/.test(f));
  expect(frame).not.toContain('own answer');
  await press('y');
  await frameMatching(ui, f => f.includes('own answer'));
  expect(await Bun.file(join(project, 'last.txt')).exists()).toBe(false);
  await choose(0);
  frame = await frameMatching(ui, f => /Tool Call\s+touch last\.txt.*\? approve/.test(f));
  expect(frame).not.toContain('own answer');
  fake.reply({ chunks: ['ok'] });
  await press('y');
  await frameMatching(ui, f => f.includes('answer complete'));
  expect(events().filter(e => e.kind === 'Tool Result').map(e => [e.call, e.content])).toEqual([
    [4, '[exit 0]'],
    [5, 'Which runtime should we use?: Bun'],
    [6, '[exit 0]'],
  ]);
});

test('the answer is a normal Context Block: e makes a new Revision; d removes the Tool Pair as a whole (#35)', async () => {
  const { events } = await questioned(RUNTIME);
  fake.reply({ chunks: ['ok'] });
  await choose(1);
  await frameMatching(ui, f => f.includes('answer complete'));
  await press('up');
  await frameMatching(ui, f => f.includes('┃ Tool Result  #5'));
  fixture.editor = async () => 'Which runtime should we use?: Deno\n';
  await press('e');
  let frame = await frameMatching(ui, f => f.includes('┃ Which runtime should we use?: Deno'));
  expect(events().at(-1)).toEqual({ type: 'Edit', id: 5, revision: 2, content: 'Which runtime should we use?: Deno', by: 'user' });
  await press('d');
  frame = await frameMatching(ui, f => f.includes('(whole Tool Pair)'));
  expect(line(frame, /Tool Call/)).toMatch(/Tool Call\s+question .*removed/);
  expect(events().at(-1)).toEqual({ type: 'Remove', id: 5, by: 'user' });
});

// Question: switch off via Permission Rules (#36) ------------------------------------------------------------
test('a deny rule for question takes it out of the Tools Block; a call anyway is "denied by rule", no dock (#36)', async () => {
  const { events } = await start({ tools: TOOLS, global: { question: 'allow' }, project: { question: 'deny' } });
  expect(events().at(-1)).toEqual({ type: 'Edit', id: 2, revision: 2, content: BASH_TOOLS, harness: true });
  await frameMatching(ui, f => /Tools\s+bash\s/.test(f) && f.includes('52 / 4k'));
  fake.reply({ chunks: [], calls: [questionCall(RUNTIME)] });
  await write('go');
  const frame = await frameMatching(ui, f => f.includes('⚠ denied by rule: question'));
  expect(frame).not.toContain('own answer');
  expect((fake.chatRequests[0] as Sent).tools!.map(t => t.function.name)).toEqual(['bash']);
  expect(events().filter(e => e.kind === 'Tool Result')).toEqual([
    { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'denied by rule', call: 4 },
  ]);
  await write('/tools question');
  await frameMatching(ui, f => f.includes('question is denied by rule'));
});

test('ask never pauses a Question; a Question still open at a resume is denied once a rule denies it (#36)', async () => {
  await start({ tools: TOOLS, global: { question: 'ask' } });
  fake.reply({ chunks: [], calls: [questionCall(RUNTIME)] });
  await write('go');
  await frameMatching(ui, f => f.includes('own answer'));
  ui.renderer.destroy();
  fake.stop();

  const { events } = await start({ tools: TOOLS, global: { question: 'deny' }, users: ['go'], calls: [{ tool: 'question', content: JSON.stringify({ questions: [RUNTIME] }) }] });
  const frame = await frameMatching(ui, f => f.includes('⚠ denied by rule: question'));
  expect(frame).not.toContain('own answer');
  expect(events().at(-1)).toEqual({ type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'denied by rule', call: 4 });
});

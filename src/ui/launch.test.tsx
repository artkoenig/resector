// UI tests: first start, Model Profiles, resume, project instructions, policies and the worktree.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeLlamaCpp } from '../../test/fake-llamacpp';
import { frameMatching } from '../../test/frames';
import { startFakeOmlx } from '../../test/fake-omlx';
import { SCHEMA_URL } from '../core/config/config';
import { DEFAULT_SYSTEM_PROMPT } from '../core/config/system-prompt';
import { chat, command, fake, key, launch, line, profileConfig, titled, ui, useHarness } from './launch.harness';

useHarness();

test('first start: a found model is offered, written to the global config and opened at the Gate', async () => {
  const { paths, log } = await launch();
  await frameMatching(ui, f => f.includes('qwen3-8b.gguf'));
  const frame = ui.captureCharFrame();
  expect(frame).toContain('first start');
  expect(frame).toMatch(/llama\.cpp\s+qwen3-8b\.gguf\s+http:\/\/localhost:\d+/);
  ui.mockInput.pressEnter();
  const gate = await frameMatching(ui, f => f.includes('/ 4k'));
  expect(gate).toMatch(/^ {2}resector {2}qwen3-8b +/m);
  expect(JSON.parse(readFileSync(paths.global, 'utf8'))).toEqual({
    $schema: SCHEMA_URL,
    profiles: { 'qwen3-8b': { backend: 'llamacpp', endpoint: fake.url, model: 'qwen3-8b.gguf' } },
    defaultProfile: 'qwen3-8b',
  });
  expect(log()[1].content).toBe(DEFAULT_SYSTEM_PROMPT);
  expect(existsSync(paths.projectHome.config)).toBe(false);
});

test('first start offers models of backends not supported yet, but does not let them be chosen', async () => {
  const ollama = Bun.serve({ port: 0, fetch: () => Response.json({ models: [{ name: 'gemma3:4b' }] }) });
  try {
    const { paths } = await launch({ servers: () => [{ backend: 'ollama', endpoint: `http://localhost:${ollama.port}` }] });
    const frame = await frameMatching(ui, f => f.includes('gemma3:4b'));
    expect(frame).toMatch(/Ollama\s+gemma3:4b\s+http:\/\/localhost:\d+\s+unsupported/);
    ui.mockInput.pressEnter();
    await Bun.sleep(50);
    expect(existsSync(paths.global)).toBe(false);
  } finally {
    ollama.stop(true);
  }
});

test('first start: an oMLX server on the LM Studio port is recognised, chosen and opened with its window', async () => {
  const omlx = startFakeOmlx({ models: [{ id: 'Qwen3-8B-4bit', maxModelLen: 8192 }] });
  try {
    const { paths } = await launch({ servers: () => [{ backend: 'lmstudio', endpoint: omlx.url }] });
    expect(await frameMatching(ui, f => f.includes('Qwen3-8B-4bit'))).toMatch(/oMLX\s+Qwen3-8B-4bit\s+http:\/\/localhost:\d+\s*$/m);
    ui.mockInput.pressEnter();
    expect(await frameMatching(ui, f => f.includes('/ 8k'))).toMatch(/^ {2}resector {2}Qwen3-8B-4bit +/m);
    expect(JSON.parse(readFileSync(paths.global, 'utf8')).profiles).toEqual({
      'Qwen3-8B-4bit': { backend: 'omlx', endpoint: omlx.url, model: 'Qwen3-8B-4bit' },
    });
  } finally {
    omlx.stop();
  }
});

test('first start without any local model server fails with a hint', async () => {
  const { paths, fatal } = await launch({ servers: () => [{ backend: 'llamacpp', endpoint: 'http://localhost:1' }] });
  await until(() => fatal.length > 0);
  expect(fatal).toEqual([
    `no model server found on localhost:8080 (llama.cpp), :11434 (Ollama), :1234 (LM Studio, oMLX): start one or write ${paths.global}`,
  ]);
  expect(existsSync(paths.global)).toBe(false);
});

test('the Gate opens with the default Model Profile, its window and the system.md prompt', async () => {
  const { paths } = await launch({ config: url => profileConfig(url), systemMd: 'You are terse.' });
  const frame = await frameMatching(ui, f => f.includes('/ 2k') && f.includes('You are terse.'));
  expect(frame).toMatch(/^ {2}resector {2}local +/m);
  // Without a project config resector does not create its Project Home.
  expect(existsSync(paths.projectHome.config)).toBe(false);
});

test('a Model Profile whose backend cannot be opened fails before the Gate', async () => {
  const { fatal } = await launch({ config: () => '{ "profiles": { "g": { "backend": "ollama" } }, "defaultProfile": "g" }' });
  await until(() => fatal.length > 0);
  expect(fatal).toEqual(['ollama backend not supported yet']);
});

test('Compaction runs on compactionProfile with the instruction from compaction.md, both as read at start', async () => {
  const other = startFakeLlamaCpp({ nCtx: 1024 });
  try {
    const second = `, "compactionProfile": "small" }, "small": { "backend": "llamacpp", "endpoint": "${other.url}"`;
    await launch({ config: url => profileConfig(url, second), compactionMd: 'keep names\n' });
    await frameMatching(ui, f => f.includes('/ 2k'));
    fake.reply({ chunks: ['ok'] });
    await command('long story');
    await frameMatching(ui, f => /4\s+User\s+long story/.test(f) && f.includes('answer complete'));
    ui.mockInput.pressArrow('up');
    ui.mockInput.pressKey('c');
    await frameMatching(ui, f => /◇ Compact 1 block \(\d+ tok\) · small · request \d+ \/ 1k/.test(f));
    expect(ui.captureCharFrame()).toContain('instruction > keep names');
    other.reply({ chunks: ['short'] });
    ui.mockInput.pressEnter();
    await frameMatching(ui, f => f.includes('session cache untouched'));
    expect(other.chatRequests).toHaveLength(1);
    expect((other.chatRequests[0] as { messages: { content: string }[] }).messages[1]!.content).toEndWith('Instruction: keep names');
    // Only the answer to `long story` went to the session backend.
    expect(fake.chatRequests).toHaveLength(1);
  } finally {
    other.stop();
  }
});

test('-c replays the last Session Log and lands at the Gate; unchanged, nothing is sent', async () => {
  const { sessionsDir } = await launch({ config: url => profileConfig(url), sessions: { ses_a: chat('local') }, resume: true });
  const frame = await frameMatching(ui, f => f.includes('resumed "hi there"'));
  expect(frame).toMatch(/3\s+User\s+hi there/);
  expect(frame).toMatch(/4\s+Assistant\s+hello/);
  expect(readFileSync(join(sessionsDir, 'ses_a.lock'), 'utf8')).toBe(String(process.pid));
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('nothing to send'));
  expect(fake.chatRequests).toEqual([]);
});

test('a resumed session whose Model Profile is gone continues on the default one, logged', async () => {
  const { store } = await launch({ config: url => profileConfig(url), sessions: { ses_a: chat('gone') }, resume: 'ses_a' });
  const frame = await frameMatching(ui, f => f.includes('not in config'));
  expect(frame).toContain('profile "gone" not in config → local');
  expect(frame).toMatch(/^ {2}resector {2}local +/m);
  expect(store.list()[0]!.events.at(-1)).toEqual({ type: 'ProfileFallback', profile: 'local' });
});

test('a session open in another instance is not resumed', async () => {
  const other = Bun.spawn(['sleep', '10']);
  try {
    const { fatal } = await launch({ config: url => profileConfig(url), sessions: { ses_a: chat('local') }, locks: { ses_a: other.pid }, resume: 'ses_a' });
    await until(() => fatal.length > 0);
    expect(fatal).toEqual(['session ses_a is open in another resector instance']);
  } finally {
    other.kill();
  }
});

test('quitting releases the session lock', async () => {
  const { quit, sessionsDir } = await launch({ config: url => profileConfig(url) });
  await frameMatching(ui, f => f.includes('/ 2k'));
  ui.mockInput.pressKey('q');
  await until(() => quit.length > 0);
  expect(readdirSync(sessionsDir)).toEqual(['ses_test.jsonl']);
});

async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(10);
}

test('a new session starts with the environment Note, AGENTS.md and CLAUDE.md right after the Tools Block', async () => {
  const { log } = await launch({ config: url => profileConfig(url), files: { 'AGENTS.md': '# Agents', 'CLAUDE.md': '# Claude' } });
  const frame = await frameMatching(ui, f => f.includes('/ 2k') && !f.includes('… / 2k'));
  expect(frame).toMatch(/3\s+Note\s+Environment/);
  expect(frame).toMatch(/4\s+Note\s+@AGENTS\.md/);
  expect(log().slice(3)).toEqual([
    { type: 'BlockAdded', id: 3, kind: 'Note', origin: 'environment', content: expect.stringMatching(/^\[environment\]\ncwd: .*\nos: .* · shell: bash\ndate: \d{4}-\d\d-\d\d\ngit branch: /) },
    { type: 'BlockAdded', id: 4, kind: 'Note', origin: 'file', file: 'AGENTS.md', content: '[AGENTS.md]\n# Agents' },
    { type: 'BlockAdded', id: 5, kind: 'Note', origin: 'file', file: 'CLAUDE.md', content: '[CLAUDE.md]\n# Claude' },
  ]);
});

test('the personal instructions from the Project Home follow those of the project', async () => {
  const { log, paths } = await launch({ config: url => profileConfig(url), files: { 'AGENTS.md': '# Agents' }, personal: { 'AGENTS.md': '# Mine' } });
  await frameMatching(ui, f => f.includes('/ 2k') && !f.includes('… / 2k'));
  const file = join(paths.projectHome.config, 'AGENTS.md');
  expect(log().slice(5)).toEqual([{ type: 'BlockAdded', id: 5, kind: 'Note', origin: 'file', file, content: `[${file}]\n# Mine` }]);
});

test('resuming does not read the project instructions again', async () => {
  const { log } = await launch({ config: url => profileConfig(url), sessions: { ses_test: chat('local') }, resume: true, files: { 'AGENTS.md': '# Agents' } });
  await frameMatching(ui, f => f.includes('resumed'));
  expect(log().some(e => e.file === 'AGENTS.md')).toBe(false);
});

// Upper-cases every User block: one pass, then nothing to change.
const SHOUT = `export default (context: { blocks: { id: number; kind: string; content: string }[] }) =>
  context.blocks.filter(b => b.kind === 'User' && b.content !== b.content.toUpperCase()).map(b => ({ op: 'edit', id: b.id, content: b.content.toUpperCase() }));
`;

test('a Context Policy from the config directory is loaded, switched on, and edits the Context as itself before the request (ADR 0001)', async () => {
  const { log } = await launch({ config: url => profileConfig(url), policies: { shout: SHOUT, broken: 'export default (;' } });
  const opened = await frameMatching(ui, f => f.includes('/ 2k') && f.includes('– not loaded'));
  expect(opened).toMatch(/policy broken: .* – not loaded/);
  await command('/policy s');
  await frameMatching(ui, f => f.includes('policy shout on'));
  expect(ui.captureCharFrame()).toMatch(/local · thinking off · policy shout/);
  fake.reply({ chunks: ['ok'] });
  await command('hi there');
  const answered = await frameMatching(ui, f => f.includes('answer complete'));
  expect(answered).toContain('shout: 1 block edited · answer complete');
  expect(log().filter(e => e.type === 'Edit' && !e.harness)).toEqual([{ type: 'Edit', id: 4, revision: 2, content: 'HI THERE', by: 'shout' }]);
  expect(JSON.stringify(fake.chatRequests[0])).toContain('HI THERE');
});

// Adds one Note right after the Tools Block, once.
const ANNOUNCE = `export default (context: { blocks: { origin?: string }[] }) =>
  context.blocks.some(b => b.origin === 'policy') ? [] : [{ op: 'note', after: 2, content: 'Tool calls are removed once done.' }];
`;

test('a policy\'s Note sits where the policy put it, titled Context Policy', async () => {
  const { log } = await launch({ config: url => profileConfig(url), policies: { announce: ANNOUNCE } });
  await frameMatching(ui, f => f.includes('/ 2k'));
  await command('/policy announce');
  await frameMatching(ui, f => f.includes('policy announce on'));
  fake.reply({ chunks: ['ok'] });
  await command('hi');
  const answered = await frameMatching(ui, f => f.includes('answer complete'));
  expect(answered).toContain('announce: 1 Note added · answer complete');
  expect(answered).toMatch(/3\s+Note\s+Context Policy/);
  expect(log().find(e => e.type === 'NoteAdded')).toMatchObject({ after: 2, by: 'announce' });
  expect(JSON.stringify(fake.chatRequests[0])).toContain('Tool calls are removed once done.');
});

test('the built-in lean-compact is on for a new session without any policy file; defaultPolicy off switches it off', async () => {
  await launch({ config: url => profileConfig(url) });
  expect(await frameMatching(ui, f => f.includes('/ 2k'))).toMatch(/local · thinking off · policy lean-compact/);
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/policy ');
  expect(await frameMatching(ui, f => f.includes('drops reads'))).toMatch(/lean-compact\s+active · drops reads and short thinking/);
  ui.renderer.destroy();
  fake.stop();
  await launch({ config: url => profileConfig(url).replace('"defaultProfile"', '"defaultPolicy": "off", "defaultProfile"') });
  expect(line(await frameMatching(ui, f => f.includes('/ 2k')), /local/)).not.toContain('policy');
});

test('defaultPolicy: a new session starts with it on, an unknown name is reported', async () => {
  await launch({ config: url => profileConfig(url).replace('"defaultProfile"', '"defaultPolicy": "shout", "defaultProfile"'), policies: { shout: SHOUT } });
  expect(await frameMatching(ui, f => f.includes('/ 2k'))).toMatch(/local · thinking off · policy shout/);
  ui.renderer.destroy();
  fake.stop();
  await launch({ config: url => profileConfig(url).replace('"defaultProfile"', '"defaultPolicy": "nope", "defaultProfile"') });
  expect(await frameMatching(ui, f => f.includes('/ 2k'))).toMatch(/defaultPolicy nope – no such policy/);
});

test('the active policy belongs to the app: it stays when switching sessions and is not logged', async () => {
  const { log } = await launch({ config: url => profileConfig(url), policies: { shout: SHOUT }, sessions: { ses_a: titled('local', 'fix the build') } });
  await frameMatching(ui, f => f.includes('/ 2k'));
  await command('/policy shout');
  await frameMatching(ui, f => f.includes('policy shout on'));
  await command('/sessions');
  await frameMatching(ui, f => f.includes('Sessions ·'));
  await key('down');
  await key('enter');
  expect(await frameMatching(ui, f => f.includes('resumed "fix the build"'))).toMatch(/local · thinking off · policy shout/);
  expect(JSON.stringify(log())).not.toContain('shout');
});

test('auto-approve belongs to the app: it stays when switching sessions and is not logged', async () => {
  const { log } = await launch({ config: url => profileConfig(url), sessions: { ses_a: titled('local', 'fix the build') } });
  await frameMatching(ui, f => f.includes('/ 2k'));
  await command('/auto');
  await frameMatching(ui, f => f.includes('auto-approve on'));
  await command('/sessions');
  await frameMatching(ui, f => f.includes('Sessions ·'));
  await key('down');
  await key('enter');
  expect(await frameMatching(ui, f => f.includes('resumed "fix the build"'))).toMatch(/local · thinking off · policy lean-compact · auto-approve/);
  expect(JSON.stringify(log())).not.toContain('auto');
});

test('/git:worktree on runs the session in its own worktree in the Project Home on its own branch; off back in the project, the worktree kept', async () => {
  const { log, paths, project } = await launch({ config: url => profileConfig(url).replace('"defaultProfile"', '"defaultPolicy": "off", "defaultProfile"'), git: true });
  await frameMatching(ui, f => f.includes('/ 2k'));
  expect(line(ui.captureCharFrame(), /local/)).toMatch(/local · thinking off · ⎇ main /);
  await command('/git:worktree on');
  const worktree = join(paths.projectHome.data, 'worktrees/ses_test');
  const frame = await frameMatching(ui, f => f.includes('worktree on – session runs in'));
  expect(line(frame, /local/)).toMatch(/local · thinking off · ⎇ resector\/ses_test · worktree/);
  expect(existsSync(join(worktree, 'a.txt'))).toBe(true);
  expect(existsSync(join(project, '.resector'))).toBe(false);
  expect(existsSync(join(project, '.gitignore'))).toBe(false);
  expect(log().filter(e => e.type === 'WorktreeSet')).toEqual([{ type: 'WorktreeSet', on: true }]);
  // The environment Note says where the session runs now: the worktree on its branch, not the main checkout.
  const note = log().findLast(e => e.type === 'Edit')?.content;
  expect(note).toContain(`cwd: ${worktree}\n`);
  expect(note).toContain('git branch: resector/ses_test (Session Worktree, not the main checkout)');
  await command('/git:worktree off');
  expect(line(await frameMatching(ui, f => f.includes('worktree off – session runs in')), /local/)).toMatch(/local · thinking off · ⎇ main /);
  expect(existsSync(join(worktree, 'a.txt'))).toBe(true);
  // Deleted by hand, the worktree is created anew despite its stale entry.
  rmSync(worktree, { recursive: true });
  await command('/git:worktree on');
  await frameMatching(ui, f => f.includes('worktree on – session runs in'));
  expect(existsSync(join(worktree, 'a.txt'))).toBe(true);
});

test('a session resumed with the worktree on runs in its worktree again, created anew if it is gone', async () => {
  await launch({ config: url => profileConfig(url), git: true, sessions: { ses_a: [...chat('local'), { type: 'WorktreeSet', on: true }] }, resume: true });
  const frame = await frameMatching(ui, f => f.includes('resumed "hi there"'));
  expect(line(frame, /local/)).toMatch(/⎇ resector\/ses_a · worktree/);
});

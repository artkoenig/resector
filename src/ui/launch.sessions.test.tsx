// UI tests: the /sessions view: listing, opening, deleting, renaming.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameMatching } from '../../test/frames';
import type { SessionEvent } from '../core/log/events';
import { command, key, launch, line, profileConfig, titled, ui, useHarness } from './launch.harness';

useHarness();

async function sessionsView(sessions: Record<string, SessionEvent[]>, locks: Record<string, number> = {}) {
  const started = await launch({ config: url => profileConfig(url), sessions, locks });
  await frameMatching(ui, f => f.includes('/ 2k'));
  await command('/sessions');
  await frameMatching(ui, f => f.includes('Sessions ·'));
  return started;
}

test('/sessions lists the project sessions newest first with marker, profile, Context and blocks', async () => {
  const other = Bun.spawn(['sleep', '10']);
  try {
    await sessionsView({ ses_a: titled('local', 'fix the build', 1900), ses_b: titled('gone', 'old question'), ses_c: titled('local', 'busy') }, { ses_c: other.pid });
    const frame = await frameMatching(ui, f => f.includes('busy'));
    expect(frame).toContain('Sessions · 4 sessions');
    expect(line(frame, /\(new session\)/)).toMatch(/^[ ┃]● +\(new session\) +now +local +– +3\b/);
    expect(line(frame, /fix the build/)).toMatch(/fix the build +1h ago +local +1\.9k\/2k +4\b/);
    expect(line(frame, /old question/)).toMatch(/old question +2h ago +⚠ gone +20 +4\b/);
    expect(line(frame, /busy/)).toMatch(/^[ ┃] ⊘ +busy/);
    expect(frame).toContain('↑↓ select  enter open  r rename  d delete  n new  / filter  esc back');
    await key('down');
    const preview = await frameMatching(ui, f => f.includes('Preview · ses_a'));
    expect(preview).toMatch(/4 +Assistant +hello/);
  } finally {
    other.kill();
  }
});

test('Enter opens the selected session; the lock moves with it; Esc goes back', async () => {
  const { sessionsDir } = await sessionsView({ ses_a: titled('local', 'fix the build') });
  await key('escape');
  await frameMatching(ui, f => f.includes('/ 2k') && !f.includes('Sessions ·'));
  await command('/sessions');
  await frameMatching(ui, f => f.includes('Sessions ·'));
  await key('down');
  await key('enter');
  const frame = await frameMatching(ui, f => f.includes('resumed "fix the build"'));
  expect(frame).toMatch(/3\s+User\s+fix the build/);
  expect(readdirSync(sessionsDir).filter(f => f.endsWith('.lock'))).toEqual(['ses_a.lock']);
});

test('a session open in another instance is neither opened nor deleted', async () => {
  const other = Bun.spawn(['sleep', '10']);
  try {
    await sessionsView({ ses_c: titled('local', 'busy') }, { ses_c: other.pid });
    await key('down');
    await key('enter');
    await frameMatching(ui, f => f.includes('⊘ "busy" is open in another resector instance'));
    await key('d');
    await frameMatching(ui, f => f.includes('⊘ cannot delete: open in another instance'));
  } finally {
    other.kill();
  }
});

test('d asks before deleting; deleting the current session switches to the newest other one', async () => {
  const { sessionsDir } = await sessionsView({ ses_a: titled('local', 'keep me'), ses_b: titled('local', 'drop me') });
  await key('down');
  await key('down');
  await key('d');
  await frameMatching(ui, f => f.includes('Delete this session? y / N'));
  await key('n');
  await frameMatching(ui, f => f.includes('delete cancelled'));
  await key('d');
  await key('y');
  const deleted = await frameMatching(ui, f => f.includes('deleted "drop me"'));
  expect(line(deleted, /1h ago|2h ago/)).toMatch(/keep me/);
  expect(existsSync(join(sessionsDir, 'ses_b.jsonl'))).toBe(false);
  await key('up');
  await key('up');
  await key('d');
  await key('y');
  const frame = await frameMatching(ui, f => f.includes('switched to "keep me"'));
  expect(line(frame, /keep me/)).toMatch(/^[ ┃]●/);
  expect(existsSync(join(sessionsDir, 'ses_test.jsonl'))).toBe(false);
});

// The current session in its worktree, with another session to switch to when it is deleted.
async function inWorktree() {
  const started = await launch({ config: url => profileConfig(url), git: true, sessions: { ses_a: titled('local', 'keep me') } });
  await frameMatching(ui, f => f.includes('/ 2k'));
  await command('/git:worktree on');
  await frameMatching(ui, f => f.includes('worktree on – session runs in'));
  const worktree = join(started.paths.projectHome.data, 'worktrees/ses_test');
  const branches = () => Bun.spawnSync(['git', 'branch', '--format=%(refname:short)'], { cwd: started.project }).stdout.toString().trim().split('\n');
  return { ...started, worktree, branches };
}
const openSessions = async () => {
  await command('/sessions');
  await frameMatching(ui, f => f.includes('Sessions ·'));
};

test('deleting a session removes its clean worktree and its merged branch', async () => {
  const { worktree, branches } = await inWorktree();
  await openSessions();
  await key('d');
  await frameMatching(ui, f => f.includes('Delete this session? y / N'));
  await key('y');
  await frameMatching(ui, f => f.includes('switched to "keep me"'));
  expect(existsSync(worktree)).toBe(false);
  expect(branches()).toEqual(['main']);
});

test('deleting a session keeps an unmerged branch and says so', async () => {
  const { worktree, branches } = await inWorktree();
  writeFileSync(join(worktree, 'a.txt'), 'changed\n');
  Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'unmerged'], { cwd: worktree });
  await openSessions();
  await key('d');
  await key('y');
  await frameMatching(ui, f => /branch resector\/ses_test\s+kept – not merged/.test(f));
  expect(existsSync(worktree)).toBe(false);
  expect(branches()).toEqual(['main', 'resector/ses_test']);
});

test('deleting a session whose worktree has uncommitted changes warns; y removes it anyway', async () => {
  const { worktree } = await inWorktree();
  writeFileSync(join(worktree, 'b.txt'), 'b\n');
  await openSessions();
  await key('d');
  await frameMatching(ui, f => f.includes('worktree has uncommitted changes'));
  await key('n');
  await frameMatching(ui, f => f.includes('delete cancelled'));
  expect(existsSync(join(worktree, 'b.txt'))).toBe(true);
  await key('d');
  await key('y');
  await frameMatching(ui, f => f.includes('switched to "keep me"'));
  expect(existsSync(worktree)).toBe(false);
});

test('changes made after the delete question keep the worktree and the session', async () => {
  const { worktree, sessionsDir } = await inWorktree();
  await openSessions();
  await key('d');
  await frameMatching(ui, f => f.includes('Delete this session? y / N'));
  writeFileSync(join(worktree, 'b.txt'), 'b\n');
  await key('y');
  await frameMatching(ui, f => f.includes('use --force'));
  expect(existsSync(join(worktree, 'b.txt'))).toBe(true);
  expect(existsSync(join(sessionsDir, 'ses_test.jsonl'))).toBe(true);
});

test('when the next session cannot be opened, the current one is not deleted', async () => {
  const config = (url: string) =>
    `{ "profiles": { "local": { "backend": "llamacpp", "endpoint": "${url}", "window": 2048 }, "down": { "backend": "llamacpp", "endpoint": "http://localhost:1" } }, "defaultProfile": "local" }`;
  const { sessionsDir } = await launch({ config, sessions: { ses_a: titled('down', 'unreachable') } });
  await frameMatching(ui, f => f.includes('/ 2k'));
  await command('/sessions');
  await frameMatching(ui, f => f.includes('Sessions ·'));
  await key('d');
  await key('y');
  await frameMatching(ui, f => f.includes('cannot reach llama.cpp at http://localhost:1'));
  expect(existsSync(join(sessionsDir, 'ses_test.jsonl'))).toBe(true);
  expect(readdirSync(sessionsDir).filter(f => f.endsWith('.lock'))).toEqual(['ses_test.lock']);
});

test('deleting the only session starts a new empty one', async () => {
  await sessionsView({});
  await key('d');
  await key('y');
  const frame = await frameMatching(ui, f => f.includes('switched to "(new session)"'));
  expect(line(frame, /\(new session\)/)).toMatch(/^[ ┃]●/);
});

test('r renames a session, / filters by title, n starts a new session', async () => {
  const { store } = await sessionsView({ ses_a: titled('local', 'fix the build'), ses_b: titled('local', 'other') });
  await key('down');
  await key('r');
  await frameMatching(ui, f => f.includes('title > fix the build'));
  await key('enter');
  await frameMatching(ui, f => !f.includes('title >'));
  expect(store.list().find(s => s.id === 'ses_a')!.renamed).toBe(false);
  await key('r');
  await frameMatching(ui, f => f.includes('title > fix the build'));
  for (let i = 0; i < 'fix the build'.length; i++) ui.mockInput.pressBackspace();
  await ui.mockInput.typeText('build fix');
  await key('enter');
  await frameMatching(ui, f => /build fix +now/.test(f));
  expect(store.list().find(s => s.id === 'ses_a')!.title).toBe('build fix');
  await key('/');
  await ui.mockInput.typeText('oth');
  let frame = await frameMatching(ui, f => !f.includes('build fix'));
  expect(frame).toContain('other');
  await key('escape');
  frame = await frameMatching(ui, f => f.includes('build fix'));
  await key('n');
  frame = await frameMatching(ui, f => f.includes('new session') && !f.includes('Sessions ·'));
  expect(store.list().map(s => s.id)).toContain('ses_new1');
});

test('/sessions with more sessions than fit: rows never overlap, the list follows the selection', async () => {
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`ses_${i + 1}`, titled('local', `topic ${i + 1}`)]));
  await sessionsView(many);
  const titles = (f: string) => [...f.matchAll(/^[ ┃][● ][⊘ ] {2}(\(new session\)|topic \d)/gm)].map(m => m[1]);
  let frame = await frameMatching(ui, f => f.includes('topic 1'));
  expect(frame.split('\n')[0]).toMatch(/^ {2}resector {2}Sessions · 9 sessions/);
  expect(frame.split('\n')[2]).toMatch(/^ {5}Title +Updated +Profile +Context +Blocks/);
  expect(titles(frame)[0]).toBe('(new session)');
  expect(titles(frame).length).toBeLessThan(9);
  for (let i = 0; i < 8; i++) await key('down');
  frame = await frameMatching(ui, f => f.includes('Preview · ses_8'));
  expect(titles(frame).at(-1)).toBe('topic 8');
  expect(titles(frame)).not.toContain('(new session)');
  expect(frame.split('\n')[2]).toMatch(/^ {5}Title/);
});

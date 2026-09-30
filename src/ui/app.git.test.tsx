// UI tests: git: /git:branch and /git:worktree.
import { expect, test } from 'bun:test';
import { frameMatching } from '../../test/frames';
import type { GateOptions } from '../gate';
import { escape, line, start, ui, useHarness, write } from './app.harness';

useHarness();

// Git as the Gate sees it: branches main and feature/x, busy in another worktree; switching, the worktree and reopening are recorded.
function fakeGit() {
  const calls: string[] = [];
  let current = 'main';
  let dirty = false;
  let branchChanged = () => {};
  let dirtyChanged = () => {};
  // Another tool switches the branch.
  const switchOutside = (name: string) => ((current = name), branchChanged());
  // Another tool dirties or cleans the working tree.
  const dirtyOutside = (d: boolean) => ((dirty = d), dirtyChanged());
  const git: NonNullable<GateOptions['git']> = {
    branches: () => ({ current, all: ['busy', 'feature/x', 'main'], elsewhere: { busy: '/p/.resector/worktrees/ses_other' } }),
    status: () => dirty,
    switchBranch: name => {
      if (name === 'dirty') throw new Error('error: your local changes would be overwritten');
      calls.push(`switch ${name}`);
      current = name;
    },
    watch: onChange => ((branchChanged = dirtyChanged = onChange), () => (branchChanged = dirtyChanged = () => {})),
    worktree: on => {
      if (current === 'locked') throw new Error("fatal: '/p/.resector/worktrees/ses_test' is a missing but locked worktree");
      calls.push(`worktree ${on}`);
      return on ? '/p/.resector/worktrees/ses_test' : '/p';
    },
    reopen: notice => void calls.push(`reopen ${notice.text}`),
  };
  return { git, calls, switchOutside, dirtyOutside };
}

test('outside a git repository the /git: commands are neither offered nor run', async () => {
  await start();
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/');
  const frame = await frameMatching(ui, f => f.includes('/sessions'));
  expect(frame).not.toContain('/git:');
  await escape();
  await escape();
  await write('/git:branch');
  await frameMatching(ui, f => f.includes('unknown command /git:branch'));
});

test('/git:branch shows the branch, suggests the others, marks those in another worktree and switches to one; the header shows it', async () => {
  const { git, calls } = fakeGit();
  await start({ git });
  expect(line(ui.captureCharFrame(), /default/)).toMatch(/default · thinking off · ⎇ main +52/);
  await write('/git:branch');
  await frameMatching(ui, f => f.includes('branch main · /git:branch busy feature/x'));
  ui.mockInput.pressTab();
  await ui.flush();
  await ui.mockInput.typeText('/git:branch ');
  const frame = await frameMatching(ui, f => f.includes('switch to'));
  expect(line(frame, /feature\/x/)).toMatch(/feature\/x +switch to/);
  expect(line(frame, /main +current/)).toBeDefined();
  expect(line(frame, /busy/)).toMatch(/busy +in worktree ses_other/);
  ui.mockInput.pressEnter();
  await frameMatching(ui, f => f.includes('switched to branch feature/x') && /thinking off · ⎇ feature\/x/.test(f));
  expect(calls).toEqual(['switch feature/x']);
  await write('/git:branch dirty');
  await frameMatching(ui, f => f.includes('your local changes would be overwritten'));
});

test('a branch switched by another tool shows in the header', async () => {
  const { git, switchOutside } = fakeGit();
  await start({ git });
  switchOutside('feature/x');
  await frameMatching(ui, f => /thinking off · ⎇ feature\/x/.test(f));
});

test('a dirty working tree shows a star in the header, and its change outside the Gate follows', async () => {
  const { git, dirtyOutside } = fakeGit();
  await start({ git });
  expect(line(ui.captureCharFrame(), /default/)).toMatch(/⎇ main +52/);
  dirtyOutside(true);
  await frameMatching(ui, f => /⎇ main\*/.test(f));
  dirtyOutside(false);
  await frameMatching(ui, f => /⎇ main +52/.test(f) && !f.includes('⎇ main*'));
});

test('/git:worktree on prepares the worktree, logs the switch and reopens the Gate there', async () => {
  const { git, calls } = fakeGit();
  const { events } = await start({ git });
  await write('/git:worktree');
  await frameMatching(ui, f => f.includes('worktree off · runs in') && f.includes('/git:worktree on'));
  await write('/git:worktree maybe');
  await frameMatching(ui, f => f.includes('unknown value maybe') && f.includes('/git:worktree on off'));
  await write('/git:worktree on');
  await frameMatching(ui, f => f.includes('worktree · ') || f.includes('· worktree'));
  expect(calls).toEqual(['worktree true', 'reopen worktree on – session runs in /p/.resector/worktrees/ses_test']);
  expect(events().at(-1)).toEqual({ type: 'WorktreeSet', on: true });
  await write('/git:worktree on');
  await frameMatching(ui, f => f.includes('worktree already on'));
});

test('/git:worktree on that git refuses shows the git message and stays in the project', async () => {
  const { git, calls, switchOutside } = fakeGit();
  const { events } = await start({ git });
  switchOutside('locked');
  await write('/git:worktree on');
  await frameMatching(ui, f => f.includes('missing but locked worktree'));
  expect(calls).toEqual([]);
  expect(events().some(e => e.type === 'WorktreeSet')).toBe(false);
});

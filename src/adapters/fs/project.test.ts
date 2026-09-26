import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeEnvironment, projectFiles, projectInstructions } from './project';

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), 'resector-project-')));

test('files are read relative to the project root, or absolute; anything unreadable is null (FR-27)', () => {
  const root = dir();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.ts'), 'x\n');
  const read = projectFiles(root);
  expect(read('src/a.ts')).toBe('x\n');
  expect(read(join(root, 'src/a.ts'))).toBe('x\n');
  expect(read('missing.ts')).toBeNull();
  expect(read('src')).toBeNull();
});

test('AGENTS.md wins over CLAUDE.md; neither is no instructions (FR-29)', () => {
  const root = dir();
  expect(projectInstructions(root)).toBeNull();
  writeFileSync(join(root, 'CLAUDE.md'), 'claude');
  expect(projectInstructions(root)).toEqual({ file: 'CLAUDE.md', content: 'claude' });
  writeFileSync(join(root, 'AGENTS.md'), 'agents');
  expect(projectInstructions(root)).toEqual({ file: 'AGENTS.md', content: 'agents' });
});

const at = new Date(2026, 8, 26, 23, 30);

test('the environment: cwd, OS, bash, local date and the git branch (FR-28)', () => {
  const root = dir();
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root });
  expect(probeEnvironment(root, at)).toEqual({ cwd: root, os: `${process.platform} ${process.arch}`, shell: 'bash', date: '2026-09-26', branch: null });
  git('init', '-q', '-b', 'feature/x');
  expect(probeEnvironment(root, at).branch).toBe('feature/x');
});

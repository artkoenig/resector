import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjectFiles, probeEnvironment, projectFiles, projectInstructions } from './project';

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

test('the project files for @path completion: git ignores apply in a repository, else dot dirs and node_modules are skipped', () => {
  const root = dir();
  for (const d of ['src', 'node_modules/x', '.cache', 'dist']) mkdirSync(join(root, d), { recursive: true });
  for (const f of ['src/a.ts', 'node_modules/x/i.js', '.cache/c', 'dist/out.js', 'README.md']) writeFileSync(join(root, f), '');
  expect(listProjectFiles(root).sort()).toEqual(['README.md', 'dist/out.js', 'src/a.ts']);
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), 'dist\nnode_modules\n');
  expect(listProjectFiles(root).sort()).toEqual(['.cache/c', '.gitignore', 'README.md', 'src/a.ts']);
  expect(listProjectFiles(root, 2)).toHaveLength(2);
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

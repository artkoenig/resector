import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjectFiles, probeEnvironment, projectFiles, projectImages, projectInstructions } from './project';

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), 'resector-project-')));

test('files are read relative to the project root, or absolute; anything unreadable is null', () => {
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

test('AGENTS.md and CLAUDE.md of the project, then those of the personal directory; same content once', () => {
  const root = dir();
  const home = dir();
  const personal = join(home, 'projects', 'p');
  expect(projectInstructions(root, personal, home)).toEqual([]);
  writeFileSync(join(root, 'CLAUDE.md'), 'claude');
  expect(projectInstructions(root, personal, home)).toEqual([{ file: 'CLAUDE.md', content: 'claude' }]);
  writeFileSync(join(root, 'AGENTS.md'), 'agents');
  mkdirSync(personal, { recursive: true });
  writeFileSync(join(personal, 'CLAUDE.md'), 'mine');
  writeFileSync(join(personal, 'AGENTS.md'), 'agents');
  expect(projectInstructions(root, personal, home)).toEqual([
    { file: 'AGENTS.md', content: 'agents' },
    { file: 'CLAUDE.md', content: 'claude' },
    { file: '~/projects/p/CLAUDE.md', content: 'mine' },
  ]);
  expect(projectInstructions(root, personal, '/elsewhere').at(-1)!.file).toBe(join(personal, 'CLAUDE.md'));
});

const at = new Date(2026, 8, 26, 23, 30);

test('the environment: cwd, OS, bash, local date and the git branch', () => {
  const root = dir();
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root });
  expect(probeEnvironment(root, at)).toEqual({ cwd: root, os: `${process.platform} ${process.arch}`, shell: 'bash', date: '2026-09-26', branch: null });
  git('init', '-q', '-b', 'feature/x');
  expect(probeEnvironment(root, at).branch).toBe('feature/x');
});

test('an image is copied under its content hash, once; loaded as a data URL; no copy of what is not an image', () => {
  const root = dir();
  const store = join(dir(), 'images');
  writeFileSync(join(root, 'a.PNG'), 'png');
  writeFileSync(join(root, 'b.png'), 'png');
  writeFileSync(join(root, 'c.txt'), 'text');
  const images = projectImages(root, store);
  expect([images.exists('a.PNG'), images.exists('gone.png')]).toEqual([true, false]);
  const copy = images.save('a.PNG')!;
  expect(copy).toMatch(/^[0-9a-f]{64}\.png$/);
  expect(images.save('b.png')).toBe(copy);
  expect(readdirSync(store)).toEqual([copy]);
  expect(images.save('c.txt')).toBeNull();
  expect(images.save('gone.png')).toBeNull();
  expect(images.load(copy)).toBe(`data:image/png;base64,${Buffer.from('png').toString('base64')}`);
  expect(existsSync(join(root, 'images'))).toBe(false);
});

// Tests for discovering skills on disk: project and user `.claude/skills/`, project wins on a name clash.
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills } from './skills';

function skill(root: string, name: string, description: string): void {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`);
}

test('a missing skills directory yields none', () => {
  const root = mkdtempSync(join(tmpdir(), 'resector-skills-'));
  expect(discoverSkills(root, root)).toEqual([]);
});

test('project and user skills are found; on a name clash the project wins', () => {
  const user = mkdtempSync(join(tmpdir(), 'resector-skills-user-'));
  const project = mkdtempSync(join(tmpdir(), 'resector-skills-proj-'));
  skill(user, 'shared', 'user version');
  skill(user, 'user-only', 'user only');
  skill(project, 'shared', 'project version');
  skill(project, 'proj-only', 'project only');
  const skills = discoverSkills(project, user);
  const byName = Object.fromEntries(skills.map(s => [s.name, s]));
  expect(Object.keys(byName).sort()).toEqual(['proj-only', 'shared', 'user-only']);
  expect(byName['shared']!.description).toBe('project version');
  expect(byName['shared']!.body).toBe('Body of shared.');
  expect(byName['user-only']!.description).toBe('user only');
  expect(byName['proj-only']!.description).toBe('project only');
});

test('the other .md files of a skill folder are read, in name order; SKILL.md and other files are not', () => {
  const root = mkdtempSync(join(tmpdir(), 'resector-skills-'));
  skill(root, 'a', 'with files');
  const dir = join(root, '.claude', 'skills', 'a');
  writeFileSync(join(dir, 'z.md'), 'Zed\n');
  writeFileSync(join(dir, 'b.md'), 'Bee\n');
  writeFileSync(join(dir, 'run.sh'), 'echo');
  mkdirSync(join(dir, 'folder.md'));
  expect(discoverSkills(root, root)[0]!.files).toEqual([{ name: 'b.md', content: 'Bee' }, { name: 'z.md', content: 'Zed' }]);
});

test('a skill folder may be a link', () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'resector-skills-shared-'));
  const root = mkdtempSync(join(tmpdir(), 'resector-skills-'));
  skill(elsewhere, 'linked', 'from elsewhere');
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  symlinkSync(join(elsewhere, '.claude', 'skills', 'linked'), join(root, '.claude', 'skills', 'linked'));
  expect(discoverSkills(root, root).map(s => s.name)).toEqual(['linked']);
});

// Tests for the Skill: parsing a SKILL.md, its name, the Skills note, and looking one up.
import { expect, test } from 'bun:test';
import { parseSkill, skillName, skillOf, skillsNote, skillsToLoad, skillContent, type Skill } from './skills';

test('a SKILL.md with frontmatter yields its name, description and body', () => {
  const s = parseSkill('---\nname: refactor\ndescription: Refactor safely\n---\n\n# Refactor\nDo it step by step.\n', '~/proj/.claude/skills/refactor/SKILL.md');
  expect(s.name).toBe('refactor');
  expect(s.description).toBe('Refactor safely');
  expect(s.body).toBe('# Refactor\nDo it step by step.');
  expect(s.file).toBe('~/proj/.claude/skills/refactor/SKILL.md');
});

test('without frontmatter the name comes from the folder and the description is empty', () => {
  const s = parseSkill('# Just a body\n', '~/p/.claude/skills/tidy/SKILL.md');
  expect(s.name).toBe('tidy');
  expect(s.description).toBe('');
  expect(s.body).toBe('# Just a body');
});

test('skillName is the folder a SKILL.md sits in', () => {
  expect(skillName('~/p/.claude/skills/refactor/SKILL.md')).toBe('refactor');
});

test('the Skills note lists each skill; empty for none', () => {
  const skills: Skill[] = [
    { name: 'a', description: 'does a', file: '~/s/a/SKILL.md', body: 'A', requires: [], files: [] },
    { name: 'b', description: 'does b', file: '~/s/b/SKILL.md', body: 'B', requires: [], files: [] },
  ];
  const note = skillsNote(skills);
  expect(note).toContain('Skills');
  expect(note).toContain('- a: does a');
  expect(note).toContain('- b: does b');
  expect(skillsNote([])).toBe('');
});

test('skillOf finds by name, else null', () => {
  const a = { name: 'a', description: '', file: '~/s/a/SKILL.md', body: 'A', requires: [], files: [] };
  expect(skillOf([a], 'a')).toBe(a);
  expect(skillOf([a], 'nope')).toBeNull();
});

test('parseSkill reads requires as a comma-separated list', () => {
  const s = parseSkill('---\nname: wayfinder\ndescription: Find the way\nrequires: grilling, domain-modeling\n---\n\n# Wayfinder\n', '~/s/wayfinder/SKILL.md');
  expect(s.requires).toEqual(['grilling', 'domain-modeling']);
});

test('parseSkill reads requires as a YAML flow sequence', () => {
  const s = parseSkill('---\nname: wayfinder\ndescription: Find the way\nrequires: [grilling, domain-modeling]\n---\n\n# Wayfinder\n', '~/s/wayfinder/SKILL.md');
  expect(s.requires).toEqual(['grilling', 'domain-modeling']);
});

const named = (name: string, requires: string[] = []): Skill => ({ name, description: '', file: `~/s/${name}/SKILL.md`, body: '', requires, files: [] });
const namesToLoad = (skill: Skill, available: Skill[], loaded: string[] = []) => skillsToLoad(skill, available, new Set(loaded)).map(s => s.name);

test('skillsToLoad resolves requires against available skills, skipping missing ones', () => {
  expect(namesToLoad(named('a', ['b', 'c', 'nonexistent']), [named('b'), named('c')])).toEqual(['a', 'b', 'c']);
});

test('skillsToLoad follows requires transitively', () => {
  expect(namesToLoad(named('a', ['b']), [named('b', ['c']), named('c')])).toEqual(['a', 'b', 'c']);
});

test('skillsToLoad takes each skill once: repeats, a self-require and cycles end', () => {
  const a = named('a', ['a', 'b', 'b']);
  expect(namesToLoad(a, [a, named('b', ['a'])])).toEqual(['a', 'b']);
});

test('skillsToLoad leaves out what is loaded, but not what that requires', () => {
  expect(namesToLoad(named('a', ['b']), [named('b', ['c']), named('c')], ['a', 'b'])).toEqual(['c']);
});

test('a block scalar description is read from its indented lines', () => {
  const folded = parseSkill('---\nname: a\ndescription: >\n  first line\n  second line\nrequires: b\n---\nBody', '~/s/a/SKILL.md');
  expect(folded.description).toBe('first line second line');
  expect(folded.requires).toEqual(['b']);
  const literal = parseSkill('---\ndescription: |-\n  one\n  two\n---\nBody', '~/s/a/SKILL.md');
  expect(literal.description).toBe('one\ntwo');
});

test('skillContent returns just the body when there are no supplementary files', () => {
  const s: Skill = { name: 'a', description: '', file: '~/s/a/SKILL.md', body: 'main body', requires: [], files: [] };
  expect(skillContent(s)).toBe('main body');
});

test('skillContent appends supplementary files under headings', () => {
  const s: Skill = { name: 'a', description: '', file: '~/s/a/SKILL.md', body: 'main body', requires: [], files: [{ name: 'EXTRA.md', content: 'extra content' }] };
  expect(skillContent(s)).toBe('main body\n\n---\n\n## EXTRA.md\n\nextra content');
});

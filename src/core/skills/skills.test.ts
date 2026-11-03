// Tests for the Skill: parsing a SKILL.md, its name, the Skills note, and looking one up.
import { expect, test } from 'bun:test';
import { parseSkill, skillName, skillOf, skillsNote, SKILL_DEFINITION, type Skill } from './skills';

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
    { name: 'a', description: 'does a', file: '~/s/a/SKILL.md', body: 'A' },
    { name: 'b', description: 'does b', file: '~/s/b/SKILL.md', body: 'B' },
  ];
  const note = skillsNote(skills);
  expect(note).toContain('Skills');
  expect(note).toContain('- a: does a');
  expect(note).toContain('- b: does b');
  expect(skillsNote([])).toBe('');
});

test('skillOf finds by name, else null', () => {
  const a = { name: 'a', description: '', file: '~/s/a/SKILL.md', body: 'A' };
  expect(skillOf([a], 'a')).toBe(a);
  expect(skillOf([a], 'nope')).toBeNull();
});

test('the skill tool takes a name', () => {
  expect(SKILL_DEFINITION.name).toBe('skill');
  expect(SKILL_DEFINITION.parameters).toEqual({ type: 'object', properties: { name: { type: 'string', description: "the name of the skill to load" } }, required: ['name'] });
});

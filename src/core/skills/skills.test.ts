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
  expect(note).toBe('Skills – call `skill` with a name to load its instructions.\n- a: does a\n- b: does b');
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

test('without requires a skill requires nothing and has no files yet', () => {
  expect(parseSkill('---\nname: a\n---\nBody', '~/s/a/SKILL.md')).toEqual({ name: 'a', description: '', file: '~/s/a/SKILL.md', body: 'Body', requires: [], files: [] });
});

test('frontmatter only at the very start; it may end the file without a newline', () => {
  const late = parseSkill('# Title\n---\nname: x\n---\n', '~/s/tidy/SKILL.md');
  expect(late.name).toBe('tidy');
  expect(late.body).toBe('# Title\n---\nname: x\n---');
  expect(parseSkill('---\nname: a\n---', '~/s/x/SKILL.md')).toMatchObject({ name: 'a', body: '' });
});

test('a key is read only at the line start, with or without a space after the colon, trimmed', () => {
  const s = parseSkill('---\nname:refactor\nnickname: bob\ndescription:   Refactor safely  \n---\n', '~/s/x/SKILL.md');
  expect(s.name).toBe('refactor');
  expect(s.description).toBe('Refactor safely');
});

test('quotes around a value are dropped, quotes inside it stay', () => {
  expect(parseSkill(`---\ndescription: "Don't panic"\n---\n`, '~/s/x/SKILL.md').description).toBe("Don't panic");
});

test('requires: quoted names, empty items left out', () => {
  expect(parseSkill(`---\nrequires: ['a', "b",, ]\n---\n`, '~/s/x/SKILL.md').requires).toEqual(['a', 'b']);
});

test('a value starting or ending with > or | is no block scalar', () => {
  const text = (d: string) => `---\ndescription: ${d}\n  indented\n---\n`;
  expect(parseSkill(text('see >'), '~/s/x/SKILL.md').description).toBe('see >');
  expect(parseSkill(text('|x'), '~/s/x/SKILL.md').description).toBe('|x');
});

test('a block scalar keeps its blank lines and ends at the next key, trailing blanks trimmed; spaces after > are fine', () => {
  const s = parseSkill('---\ndescription: |  \n  one\n\n  two\n\nname: a\n---\n', '~/s/x/SKILL.md');
  expect(s.description).toBe('one\n\ntwo');
  expect(s.name).toBe('a');
});

// A Skill: a SKILL.md folder the model loads on demand. name and description are the metadata the model sees
// in the Skills note; body is the SKILL.md without its frontmatter, loaded into the Context as a Note by `skill` or /skill.
// requires: names of other skills this one depends on; they auto-load when this skill is loaded.
// files: additional .md files in the skill folder, read alongside the body when the skill is loaded.
import { basename, dirname } from 'node:path';

export type SkillFile = { name: string; content: string };
export type Skill = { name: string; description: string; file: string; body: string; requires: string[]; files: SkillFile[] };
type Frontmatter = { name?: string; description?: string; requires?: string[] };

// The skill's name: the folder its SKILL.md sits in.
export const skillName = (file: string): string => basename(dirname(file));

// A SKILL.md: YAML frontmatter (name, description, requires) then the body. Without frontmatter the name comes
// from the folder and the description is empty.
export function parseSkill(text: string, file: string): Skill {
  const { meta, body } = splitFrontmatter(text);
  return { name: meta.name ?? skillName(file), description: meta.description ?? '', file, body: body.trim(), requires: meta.requires ?? [], files: [] };
}

// `---\n…\n---\n` at the start of the file: the frontmatter, the rest the body.
// `requires` is a comma-separated list or a YAML flow sequence: `requires: grilling, domain-modeling`
// or `requires: [grilling, domain-modeling]`. A value may be a YAML block scalar (`>` or `|`).
function splitFrontmatter(text: string): { meta: Frontmatter; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Frontmatter = {};
  const lines = (m[1] ?? '').split(/\r?\n/);
  lines.forEach((line, i) => {
    const kv = line.match(/^(name|description|requires):\s*(.*)$/);
    if (!kv) return;
    const raw = blockScalar(lines, i, (kv[2] ?? '').trim());
    if (kv[1] === 'requires') {
      // Strip brackets if present, then split on commas.
      const inner = raw.replace(/^\[|\]$/g, '');
      meta.requires = inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      meta[kv[1] as 'name' | 'description'] = raw.replace(/^['"]|['"]$/g, '');
    }
  });
  return { meta, body: text.slice(m[0].length) };
}

// The value of the line at `at`: `raw`, or for a block scalar the indented lines after it (`>` folds them).
function blockScalar(lines: string[], at: number, raw: string): string {
  const scalar = raw.match(/^([>|])[+-]?$/);
  if (!scalar) return raw;
  const end = lines.findIndex((l, i) => i > at && l.trim() !== '' && !/^\s/.test(l));
  const block = lines.slice(at + 1, end === -1 ? lines.length : end).map(l => l.trim());
  return block.join(scalar[1] === '>' ? ' ' : '\n').trim();
}

// The full content of a skill Note: its body, then each supplementary file under a heading.
export const skillContent = (skill: Skill): string =>
  skill.files.length === 0 ? skill.body : [skill.body, ...skill.files.map(f => `\n---\n\n## ${f.name}\n\n${f.content}`)].join('\n');

// The Skills note: one line per skill, the metadata the model sees without loading any body.
export const skillsNote = (skills: Skill[]): string =>
  skills.length === 0 ? '' : `Skills – call \`skill\` with a name to load its instructions.\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}`;

// The skill with the given name; null when none (a typo or a skill that is not available).
export const skillOf = (skills: Skill[], name: string): Skill | null => skills.find(s => s.name === name) ?? null;

// What loading a skill adds: the skill, then what it requires, directly or not, each once and without those already
// loaded (names). Missing ones are silently skipped.
export function skillsToLoad(skill: Skill, available: Skill[], loaded: Set<string>): Skill[] {
  const seen = new Map<string, Skill>();
  const visit = (s: Skill) => {
    if (seen.has(s.name)) return;
    seen.set(s.name, s);
    for (const name of s.requires) {
      const dep = skillOf(available, name);
      if (dep) visit(dep);
    }
  };
  visit(skill);
  return [...seen.values()].filter(s => !loaded.has(s.name));
}

// A Skill: a SKILL.md folder the model loads on demand. name and description are the metadata the model sees
// in the Skills note; body is the full SKILL.md, loaded into the Context as a Note when the model calls `skill`.
import { basename, dirname } from 'node:path';

export type Skill = { name: string; description: string; file: string; body: string };

// The `skill` tool: load a skill's body into the Context by its name.
export const SKILL_DEFINITION = {
  name: 'skill',
  description:
    'Load a skill into the context by its name. The available skills and what they do are listed in the Skills note; ' +
    "call this with a skill's name to read its full instructions before doing the task it covers.",
  parameters: { type: 'object', properties: { name: { type: 'string', description: "the name of the skill to load" } }, required: ['name'] },
};

// The skill's name: the folder its SKILL.md sits in.
export const skillName = (file: string): string => basename(dirname(file));

// A SKILL.md: YAML frontmatter (name, description) then the body. Without frontmatter the name comes from the
// folder and the description is empty.
export function parseSkill(text: string, file: string): Skill {
  const { meta, body } = splitFrontmatter(text);
  return { name: meta.name ?? skillName(file), description: meta.description ?? '', file, body: body.trim() };
}

// `---\n…\n---\n` at the start of the file: the frontmatter, the rest the body.
function splitFrontmatter(text: string): { meta: { name?: string; description?: string }; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: { name?: string; description?: string } = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (kv) meta[kv[1] as 'name' | 'description'] = (kv[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

// The Skills note: one line per skill, the metadata the model sees without loading any body.
export const skillsNote = (skills: Skill[]): string =>
  skills.length === 0 ? '' : `Skills – call \`skill\` with a name to load its instructions.\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}`;

// The skill with the given name; null when none (a typo or a skill that is not available).
export const skillOf = (skills: Skill[], name: string): Skill | null => skills.find(s => s.name === name) ?? null;

// Skills on disk: SKILL.md folders, read once when a session opens. The project's, then the user's; a name clash
// lets the project's win. Additional .md files in the folder are read as supplementary content.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkill, type Skill, type SkillFile } from '../../core/skills/skills';
import { tilde } from './project';

// A directory's entries in a stable order; none if it cannot be read.
function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

const textOf = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// The skills in a `<root>/.claude/skills/` directory, one per subfolder (or link to one) holding a SKILL.md;
// unreadable ones skipped.
function skillsIn(root: string, home: string): Skill[] {
  const dir = join(root, '.claude', 'skills');
  return namesIn(dir).flatMap(name => {
    const file = join(dir, name, 'SKILL.md');
    const text = textOf(file);
    return text === null ? [] : [{ ...parseSkill(text, tilde(file, home)), files: supplementary(join(dir, name)) }];
  });
}

// The .md files in a skill folder other than SKILL.md.
const supplementary = (folder: string): SkillFile[] =>
  namesIn(folder)
    .filter(name => name.endsWith('.md') && name !== 'SKILL.md')
    .flatMap(name => {
      const text = textOf(join(folder, name));
      return text === null ? [] : [{ name, content: text.trim() }];
    });

// The project's skills, then the user's (`~/.claude/skills/`); on a name clash the project's wins, within one
// root the last folder by name.
export function discoverSkills(projectRoot: string, home: string): Skill[] {
  const byName = new Map(skillsIn(home, home).map(s => [s.name, s]));
  for (const s of skillsIn(projectRoot, home)) byName.set(s.name, s);
  return [...byName.values()];
}

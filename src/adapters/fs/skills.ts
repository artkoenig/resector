// Skills on disk: SKILL.md folders, read once at session start. The project's, then the user's; a name clash
// lets the project's win.
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSkill, type Skill } from '../../core/skills/skills';
import { tilde } from './project';

// The skills in a `<root>/.claude/skills/` directory, one per subfolder holding a SKILL.md; unreadable ones skipped.
function skillsIn(root: string, home: string): Skill[] {
  const dir = join(root, '.claude', 'skills');
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, 'SKILL.md');
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    skills.push(parseSkill(text, tilde(file, home)));
  }
  return skills;
}

// The project's skills, then the user's (`~/.claude/skills/`); on a name clash the project's wins.
export function discoverSkills(projectRoot: string, home = homedir()): Skill[] {
  const byName = new Map(skillsIn(home, home).map(s => [s.name, s]));
  for (const s of skillsIn(projectRoot, home)) byName.set(s.name, s);
  return [...byName.values()];
}

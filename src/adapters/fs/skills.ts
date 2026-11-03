// Skills on disk: SKILL.md folders, read once at session start. The project's, then the user's; a name clash
// lets the project's win. Additional .md files in the folder are read as supplementary content.
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
    const skill = parseSkill(text, tilde(file, home));
    // Read the other .md files in the folder as supplementary content.
    skill.files = readSupplementary(join(dir, entry.name), home);
    skills.push(skill);
  }
  return skills;
}

// The .md files in a skill folder other than SKILL.md, as { name, content } pairs.
function readSupplementary(folder: string, home: string): { name: string; content: string }[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: { name: string; content: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'SKILL.md') continue;
    try {
      files.push({ name: entry.name, content: readFileSync(join(folder, entry.name), 'utf8').trim() });
    } catch {
      // unreadable file: skip
    }
  }
  return files;
}

// The project's skills, then the user's (`~/.claude/skills/`); on a name clash the project's wins.
export function discoverSkills(projectRoot: string, home = homedir()): Skill[] {
  const byName = new Map(skillsIn(home, home).map(s => [s.name, s]));
  for (const s of skillsIn(projectRoot, home)) byName.set(s.name, s);
  return [...byName.values()];
}

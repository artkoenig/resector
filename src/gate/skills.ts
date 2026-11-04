// Loading Skills: the `skill` tool and /skill add a skill and what it requires to the Context as Notes.
import type { Block } from '../core/log/fold';
import { skillContent, skillOf, skillsToLoad, type Skill } from '../core/skills/skills';
import type { RunResult } from '../core/tools/call';
import type { Kernel } from './kernel';

export type SkillsSlice = ReturnType<typeof createSkills>;

export function createSkills(k: Kernel, skills: Skill[]) {
  const names = () => skills.map(s => s.name);

  // Adds what is not loaded yet; call: the `skill` call asking for it. Returns what to tell about it.
  function load(skill: Skill, call?: number): string {
    const loaded = new Set(k.context().blocks.flatMap(b => b.skill ?? []));
    const added = skillsToLoad(skill, skills, loaded);
    for (const s of added) k.append({ type: 'SkillLoaded', id: k.nextId(), ...(call !== undefined && { call }), name: s.name, file: s.file, content: skillContent(s) });
    return added.length ? `loaded ${added.map(s => s.name).join(', ')}` : `already loaded: ${skill.name}`;
  }

  // A `skill` call: its Tool Result, after the Notes.
  function run(call: Block): RunResult {
    const skill = skillOf(skills, call.content);
    return skill ? { output: load(skill, call.id), exit: 0, stopped: null } : { output: `unknown skill: ${call.content}`, exit: 1, stopped: null };
  }

  // /skill <name>; alone it lists the available skills.
  function loadSkill(arg: string) {
    if (!arg) return k.setStatus({ text: skills.length ? `skills: ${names().join(', ')}` : 'no skills found', tone: 'info' });
    const skill = skillOf(skills, arg);
    if (!skill) return k.setStatus({ text: `unknown skill ${arg}: ${names().join(' ')}`, tone: 'error' });
    k.setStatus({ text: load(skill), tone: 'ok' });
  }

  return { api: { skillNames: names }, run, loadSkill };
}

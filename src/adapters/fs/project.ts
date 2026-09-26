// The project on disk: @file reads (FR-27), the environment probe (FR-28), project instructions (FR-29).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Environment } from '../../core/notes/environment';
import type { ReadFile } from '../../core/notes/files';
import type { Instructions } from '../../core/session/session';

// A path relative to the project root, or absolute; null when it is no readable file.
export const projectFiles = (root: string): ReadFile => path => {
  const file = resolve(root, path);
  try {
    return statSync(file).isFile() ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
};

const INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md'];

// `AGENTS.md`, else `CLAUDE.md`, in the project root.
export function projectInstructions(root: string): Instructions | null {
  const file = INSTRUCTIONS.find(f => existsSync(resolve(root, f)));
  return file ? { file, content: readFileSync(resolve(root, file), 'utf8') } : null;
}

const pad = (n: number) => String(n).padStart(2, '0');
// The local date, no time: it changes once a day.
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Tool Calls run in bash (FR-21), whatever the user's shell.
export function probeEnvironment(root: string, now = new Date()): Environment {
  const git = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' });
  const branch = git.status === 0 ? git.stdout.trim() : '';
  return { cwd: root, os: `${process.platform} ${process.arch}`, shell: 'bash', date: localDate(now), branch: branch || null };
}

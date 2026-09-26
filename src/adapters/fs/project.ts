// The project on disk: @path reads (FR-27), the environment probe (FR-28), project instructions (FR-29).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

// The project's files for @path completion (FR-27), relative to the root: in a git repository the tracked and
// untracked ones not ignored, else a walk skipping dot directories and node_modules. At most `limit`.
export function listProjectFiles(root: string, limit = 20000): string[] {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0) return git.stdout.split('\n').filter(Boolean).slice(0, limit);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (files.length >= limit) return;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isFile()) files.push(path);
      else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') walk(path);
    }
  };
  try {
    walk('');
  } catch {
    // An unreadable directory ends the walk; what was found so far is offered.
  }
  return files;
}

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

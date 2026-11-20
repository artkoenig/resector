// The project on disk: @path reads, the environment probe, project instructions.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Environment } from '../../core/notes/environment';
import type { ImageFiles, ReadFile } from '../../core/notes/files';
import { imageType } from '../../core/notes/images';
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

const isFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

// Image files of the project (paths as for projectFiles), copied on send into `store` under their content's hash, so a
// resumed session sends the image as it was; load: a copy as a data URL.
export function projectImages(root: string, store: string): ImageFiles & { load: (image: string) => string } {
  const loaded = new Map<string, string>();
  return {
    exists: path => isFile(resolve(root, path)),
    save: path => {
      const file = resolve(root, path);
      const type = imageType(file);
      if (!type || !isFile(file)) return null;
      const bytes = readFileSync(file);
      const image = `${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}${file.slice(file.lastIndexOf('.')).toLowerCase()}`;
      mkdirSync(store, { recursive: true });
      if (!existsSync(join(store, image))) writeFileSync(join(store, image), bytes);
      return image;
    },
    load: image => {
      const url = loaded.get(image) ?? `data:${imageType(image)};base64,${readFileSync(join(store, image)).toString('base64')}`;
      loaded.set(image, url);
      return url;
    },
  };
}

// The project's files for @path completion, relative to the root: in a git repository the tracked and
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

// `AGENTS.md` and `CLAUDE.md` in the project root, then in the Project Home's config root (named with `~` for the home
// directory, so its file name fits the Gate). A file with the same content as one before (e.g. CLAUDE.md a symlink
// to AGENTS.md) is left out.
export function projectInstructions(root: string, personal?: string, home = homedir()): Instructions[] {
  const found: Instructions[] = [];
  const add = (path: string, file: string) => {
    const content = projectFiles(root)(path);
    if (content !== null && !found.some(i => i.content === content)) found.push({ file, content });
  };
  for (const f of INSTRUCTIONS) add(f, f);
  if (personal) for (const f of INSTRUCTIONS) add(join(personal, f), tilde(join(personal, f), home));
  return found;
}

// A path under the home directory with `~` for it.
export const tilde = (path: string, home = homedir()) => (path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path);

const pad = (n: number) => String(n).padStart(2, '0');
// The local date, no time: it changes once a day.
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Tool Calls run in bash, whatever the user's shell.
export function probeEnvironment(root: string, now = new Date()): Environment {
  const git = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' });
  const branch = git.status === 0 ? git.stdout.trim() : '';
  return { cwd: root, os: `${process.platform} ${process.arch}`, shell: 'bash', date: localDate(now), branch: branch || null };
}

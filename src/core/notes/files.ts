// File Notes: `@<path>[:a-b]` (or `@"<path with spaces>"[:a-b]`) references in the input, and the snapshot a reference becomes on send.
import type { SessionEvent } from '../log/events';
import type { Context } from '../log/fold';

// A file as the harness reads it: its text, or null when it does not exist (or is no readable file).
export type ReadFile = (path: string) => string | null;
export type Reference = { path: string; from: number | null; to: number | null };
// Image files as the harness keeps them: whether one is there now, and copying it into the Project Home (its copy's
// name, null when it cannot be read).
export type ImageFiles = { exists: (path: string) => boolean; save: (path: string) => string | null };

const REFERENCE = /(?<=^|\s)@(?:"([^"\n]+)"(:\d+(?:-\d+)?)?|(\S+))/g;

// The references in the input text, in order, and the text without them.
export function references(input: string): { files: string[]; text: string } {
  // Punctuation after the path belongs to the sentence: `see @a.ts, then …`.
  const files = [...input.matchAll(REFERENCE)].map(m => m[1] !== undefined ? m[1] + (m[2] ?? '') : m[3]!.replace(/[.,;:!?)]+$/, ''));
  const text = input.replace(REFERENCE, '').replace(/[ \t]{2,}/g, ' ').trim();
  return { files, text };
}

// The @path reference being typed at the end of the input: where its path starts and the project files matching
// it, best first – the file name starting with it, then the path, then containing it anywhere.
export function fileCompletions(input: string, files: readonly string[], limit = 8): { at: number; paths: string[] } | null {
  const typed = /(?<=^|\s)@("[^"\n]*|\S*)$/.exec(input);
  if (!typed) return null;
  const written = typed[1]!.replace(/^"/, '');
  const partial = written.toLowerCase();
  const rank = (path: string) => {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    return name.startsWith(partial) ? 0 : lower.startsWith(partial) ? 1 : lower.includes(partial) ? 2 : -1;
  };
  const paths = files
    .map(path => ({ path, rank: rank(path) }))
    .filter(f => f.rank >= 0 && f.path !== written)
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(f => f.path);
  return { at: input.length - typed[1]!.length, paths };
}

// A path as an @reference writes it: quoted when it has whitespace.
export function referencePath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

// `path`, `path:a` or `path:a-b`.
export function parseReference(file: string): Reference {
  const m = /(.+):(\d+)(?:-(\d+))?$/.exec(file);
  if (!m) return { path: file, from: null, to: null };
  const from = Number(m[2]);
  return { path: m[1]!, from, to: m[3] === undefined ? from : Number(m[3]) };
}

// The content of a Note taken from a file: its reference first, so the model knows where it comes from.
export const fileNote = (file: string, text: string) => `[${file}]\n${text}`;

// A reference read now: the whole file, or the lines of its range, numbered. From then on a plain snapshot.
export function snapshot(file: string, read: ReadFile): { content: string } | { error: string } {
  const { path, from, to } = parseReference(file);
  const text = read(path);
  if (text === null) return { error: `file not found: ${path}` };
  if (from === null) return { content: fileNote(file, text) };
  if (to! < from) return { error: `empty range ${from}-${to} in ${path}` };
  const lines = text.replace(/\n$/, '').split('\n');
  if (from < 1 || from > lines.length) return { error: `no line ${from} in ${path} (${lines.length} lines)` };
  const numbered = lines.slice(from - 1, to!).map((line, i) => `${from + i}: ${line}`);
  return { content: fileNote(file, numbered.join('\n')) };
}

// Why an image reference cannot be read now, or null.
function imageError(file: string, images: ImageFiles): string | null {
  const { path, from } = parseReference(file);
  if (from !== null) return `no lines in image ${path}`;
  return images.exists(path) ? null : `file not found: ${path}`;
}

// The Context at the Gate: each unread reference shows its file as it would be read now; missing: why it cannot be.
export function peekReferences(context: Context, read: ReadFile, images: ImageFiles): { context: Context; missing: Map<number, string> } {
  const missing = new Map<number, string>();
  const blocks = context.blocks.map(b => {
    if (!b.unread) return b;
    if (b.kind === 'Image') {
      const error = imageError(b.file!, images);
      if (error) missing.set(b.id, error);
      return b;
    }
    const found = snapshot(b.file!, read);
    if ('error' in found) missing.set(b.id, found.error);
    return { ...b, content: 'error' in found ? '' : found.content };
  });
  return { context: { ...context, blocks }, missing };
}

type FileRead = Extract<SessionEvent, { type: 'FileRead' | 'ImageRead' }>;

// On send: the unread references in the Context read into snapshots (images copied), or the first that cannot be
// (sending aborts).
export function readReferences(context: Context, read: ReadFile, images: ImageFiles): { events: FileRead[] } | { error: string; id: number } {
  const events: FileRead[] = [];
  for (const b of context.blocks.filter(b => b.unread)) {
    if (b.kind === 'Image') {
      const error = imageError(b.file!, images);
      const image = error ? null : images.save(parseReference(b.file!).path);
      if (image === null) return { error: error ?? `cannot read image ${b.file}`, id: b.id };
      events.push({ type: 'ImageRead', id: b.id, image });
      continue;
    }
    const found = snapshot(b.file!, read);
    if ('error' in found) return { error: found.error, id: b.id };
    events.push({ type: 'FileRead', id: b.id, content: found.content });
  }
  return { events };
}

import type { SessionEvent } from '../log/events';
import type { Context } from '../log/fold';

// File Notes (FR-27, FR-29): `@file <path>[:a-b]` references in the input, and the snapshot a reference becomes on send.

// A file as the harness reads it: its text, or null when it does not exist (or is no readable file).
export type ReadFile = (path: string) => string | null;
export type Reference = { path: string; from: number | null; to: number | null };

const REFERENCE = /(?<=^|\s)@file\s+(\S+)/g;

// The references in the input text, in order, and the text without them.
export function references(input: string): { files: string[]; text: string } {
  const files = [...input.matchAll(REFERENCE)].map(m => m[1]!);
  const text = input.replace(REFERENCE, '').replace(/[ \t]{2,}/g, ' ').trim();
  return { files, text };
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

// A reference read now: the whole file, or the lines of its range, numbered. From then on a plain snapshot (FR-27).
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

// The Context at the Gate: each unread reference shows its file as it would be read now, or why it cannot be.
export function peekReferences(context: Context, read: ReadFile): Context {
  const blocks = context.blocks.map(b => {
    if (!b.unread) return b;
    const found = snapshot(b.file!, read);
    return 'error' in found ? { ...b, content: '', missing: found.error } : { ...b, content: found.content };
  });
  return { ...context, blocks };
}

type FileRead = Extract<SessionEvent, { type: 'FileRead' }>;

// On send: the unread references in the Context read into snapshots, or the first that cannot be (sending aborts).
export function readReferences(context: Context, read: ReadFile): { events: FileRead[] } | { error: string; id: number } {
  const events: FileRead[] = [];
  for (const b of context.blocks.filter(b => b.unread && !b.removed)) {
    const found = snapshot(b.file!, read);
    if ('error' in found) return { error: found.error, id: b.id };
    events.push({ type: 'FileRead', id: b.id, content: found.content });
  }
  return { events };
}

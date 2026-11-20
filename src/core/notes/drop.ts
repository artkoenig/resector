// Dropped files: the text a terminal pastes for files dropped onto it, read back as their paths and @path references.
import { isImage } from './images';
import { parseReference, referencePath } from './files';

// A shell word's parts: '…', "…", a backslash escape, a plain character.
const PART = /'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])|([^\s'"\\])/g;
const WORD = new RegExp(`(?:${PART.source})+`, 'g');

// A part as the shell reads it: inside "…" only \", \\, \$ and \` are escapes.
const unquoted = (_: string, single?: string, double?: string, escaped?: string, plain?: string) =>
  single ?? double?.replace(/\\(["\\$`])/g, '$1') ?? escaped ?? plain!;

// The words of a paste as a shell reads them; null without any, with an open quote or a trailing backslash.
function words(text: string): string[] | null {
  if (text.replace(WORD, '').trim()) return null;
  return text.match(WORD)?.map(word => word.replace(PART, unquoted)) ?? null;
}

// A word as an absolute path: itself, or a local file URL decoded; null for anything else.
function pathOf(word: string): string | null {
  if (!word.startsWith('file://')) return word.startsWith('/') ? word : null;
  const rest = word.slice('file://'.length).replace(/^localhost(?=\/)/, '');
  if (!rest.startsWith('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

// The files a paste names, as iTerm2, Terminal.app, Kitty, Ghostty and WezTerm drop them: absolute paths, shell-escaped
// or quoted, or file URLs, separated by spaces or lines. null when it is anything else.
export function droppedPaths(pasted: string): string[] | null {
  const found = words(pasted);
  if (!found) return null;
  const paths = found.map(pathOf);
  return paths.every(p => p !== null) ? (paths as string[]) : null;
}

// The @path references for a paste of dropped image files: relative to the Project root inside it, absolute outside.
// null unless every path names an image that `exists` (paths as written in a reference) – the paste then stays as it is.
export function droppedImages(pasted: string, root: string, exists: (path: string) => boolean): string | null {
  const inside = `${root}/`;
  const paths = droppedPaths(pasted)?.map(p => (p.startsWith(inside) ? p.slice(inside.length) : p));
  // A reference cannot write a quote, nor a path that reads as a line range.
  const writable = (p: string) => isImage(p) && !p.includes('"') && parseReference(p).from === null && exists(p);
  return paths?.every(writable) ? paths.map(p => `@${referencePath(p)}`).join(' ') : null;
}

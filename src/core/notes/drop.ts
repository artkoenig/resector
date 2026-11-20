// Dropped files: the text a terminal pastes for files dropped onto it, read back as their paths and @path references.
import { isImage } from './images';
import { referencePath } from './files';

// The words of a paste as a shell reads them: backslash escapes, '…' and "…" quotes; null with an open quote.
function words(text: string): string[] | null {
  const found: string[] = [];
  // null between words: '' is a word ('' quoted).
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word = word! + c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && /["\\$`]/.test(text[i + 1] ?? '')) word = word! + text[++i]!;
      else word = word! + c;
    } else if (/\s/.test(c)) {
      if (word !== null) found.push(word);
      word = null;
    } else {
      word ??= '';
      if (c === "'" || c === '"') quote = c;
      else if (c === '\\' && i + 1 < text.length) word += text[++i]!;
      else word += c;
    }
  }
  if (quote) return null;
  if (word !== null) found.push(word);
  return found;
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
  if (!found?.length) return null;
  const paths = found.map(pathOf);
  return paths.every(p => p !== null) ? (paths as string[]) : null;
}

// The @path references for a paste of dropped image files: relative to the Project root inside it, absolute outside.
// null unless every path names an image that `exists` (paths as written in a reference) – the paste then stays as it is.
export function droppedImages(pasted: string, root: string, exists: (path: string) => boolean): string | null {
  const inside = root.replace(/\/$/, '') + '/';
  const paths = droppedPaths(pasted)?.map(p => (p.startsWith(inside) ? p.slice(inside.length) : p));
  // A reference cannot write a quote, nor a path that reads as a line range.
  const writable = (p: string) => isImage(p) && !p.includes('"') && !/:\d+(-\d+)?$/.test(p) && exists(p);
  return paths?.every(writable) ? paths.map(p => `@${referencePath(p)}`).join(' ') : null;
}

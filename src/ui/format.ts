// Display helpers for the views: flags, fixed-width cells, windows, ages.
import type { BackgroundEnd } from '../core/log/events';
import type { Reviewed } from '../gate/review';

// Changes since the last request: new Revision, moved.
const changesOf = (block: Reviewed): string => (block.revised ? `✎${block.revision}` : '') + (block.moved ? '⇄' : '');

// A pending call: decided now (a Question is answered), or queued.
const pendingFlag = (block: Reviewed, next?: number): string => {
  if (!block.pending) return '';
  if (block.id !== next) return ' · queued';
  return block.tool === 'question' ? ' ? answer' : ' ? approve';
};

// A Background Process's ending, short: what the exit Note says at length.
const ENDED: Record<string, string> = { 'session ended': 'session ended', user: 'stopped', orphaned: 'orphaned' };
const endOf = (end: BackgroundEnd) => ('exit' in end ? `exited ${end.exit}` : (ENDED[end.signal] ?? end.signal));
// The Tool Call's Background Process: running, or how it ended.
const processFlag = ({ process }: Reviewed): string => (!process ? '' : process.running ? ' ▶ running' : ` ■ ${endOf(process.end!)}`);

// Changes since the last request, then persistent status flags.
// next: the Tool Call to decide on now; later pending calls are queued; dropped: a Thinking
// block the chat template drops.
export const flagsOf = (block: Reviewed, next?: number, dropped = false): string =>
  [
    changesOf(block),
    block.cutOff ? ' ⚠ cut off' : '',
    pendingFlag(block, next),
    processFlag(block),
    block.stopped ? ` ⚠ ${block.stopped}` : '',
    block.unread ? (block.missing ? ' ⚠ not found' : ' @ read at send') : '',
    dropped ? ' ✂ template' : '',
  ]
    .join('')
    .trim();

// Widths in terminal cells, not UTF-16 units: an emoji like ✅ takes two cells.
const graphemes = new Intl.Segmenter();
export function cell(s: string, width: number): string {
  const size = Bun.stringWidth(s);
  if (size <= width) return s + ' '.repeat(width - size);
  let cut = '';
  let used = 0;
  for (const { segment } of graphemes.segment(s)) {
    const w = Bun.stringWidth(segment);
    if (used + w > width - 1) break;
    cut += segment;
    used += w;
  }
  return cut + '…' + ' '.repeat(Math.max(0, width - 1 - used));
}

// Names cut with … to fit `room` cells together, the longest first; each keeps at least its first cell.
export function fitting(names: readonly string[], room: number): string[] {
  const widths = names.map(n => Bun.stringWidth(n));
  while (widths.reduce((a, b) => a + b, 0) > room) {
    const longest = widths.indexOf(Math.max(...widths));
    if (widths[longest]! <= 2) break;
    widths[longest]!--;
  }
  return names.map((n, i) => (Bun.stringWidth(n) <= widths[i]! ? n : cell(n, widths[i]!).trimEnd()));
}

export const right = (s: string, width: number): string => ' '.repeat(Math.max(0, width - Bun.stringWidth(s))) + s;

// The items that fit in `capacity` lines: a window keeping item `at` in the middle where possible.
export function around<T>(items: readonly T[], at: number, capacity: number): T[] {
  const from = Math.max(0, Math.min(items.length - capacity, at - Math.floor(capacity / 2)));
  return items.slice(from, from + capacity);
}

// Screen lines a text takes, wrapped at `width`.
export const linesOf = (text: string, width: number) => Math.max(1, Math.ceil(text.length / width));

// Lines of at most `size` cells, broken at spaces; a word longer than a line is cut. `rest`: the size of every line
// after the first (a hanging indent), default `size`.
export function wrapped(text: string, size: number, rest = size): string[] {
  const lines: string[] = [];
  let line = '';
  const room = () => (lines.length ? rest : size);
  for (const word of text.split(' ').flatMap(w => w.match(new RegExp(`.{1,${Math.max(1, Math.min(size, rest))}}`, 'g')) ?? [])) {
    if (line && line.length + 1 + word.length > room()) lines.push(line), (line = '');
    line = line ? `${line} ${word}` : word;
  }
  return line ? [...lines, line] : lines;
}

// Age of a session for /sessions.
export function ago(then: Date, now = Date.now()): string {
  const minutes = (now - then.getTime()) / 60_000;
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (24 * 60))}d ago`;
}

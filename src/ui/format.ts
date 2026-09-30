// Display helpers for the views: flags, fixed-width cells, windows, ages.
import type { Block } from '../core/log/fold';

// Changes since the last request: new Revision, moved.
const changesOf = (block: Block): string => (block.revised ? `✎${block.revision}` : '') + (block.moved ? '⇄' : '');

// A pending call: decided now (a Question is answered), or queued.
const pendingFlag = (block: Block, next?: number): string => {
  if (!block.pending) return '';
  if (block.id !== next) return ' · queued';
  return block.tool === 'question' ? ' ? answer' : ' ? approve';
};

// Changes since the last request, then persistent status flags.
// next: the Tool Call to decide on now; later pending calls are queued; dropped: a Thinking
// block the chat template drops.
export const flagsOf = (block: Block, next?: number, dropped = false): string =>
  [
    changesOf(block),
    block.cutOff ? ' ⚠ cut off' : '',
    pendingFlag(block, next),
    block.stopped ? ` ⚠ ${block.stopped}` : '',
    block.unread ? (block.missing ? ' ⚠ not found' : ' @ read at send') : '',
    dropped ? ' ✂ template' : '',
  ]
    .join('')
    .trim();

export const cell = (s: string, width: number): string =>
  s.length > width ? s.slice(0, Math.max(0, width - 1)) + '…' : s.padEnd(width);

export const right = (s: string, width: number): string => s.padStart(width);

// The items that fit in `capacity` lines: a window keeping item `at` in the middle where possible.
export function around<T>(items: readonly T[], at: number, capacity: number): T[] {
  const from = Math.max(0, Math.min(items.length - capacity, at - Math.floor(capacity / 2)));
  return items.slice(from, from + capacity);
}

// Screen lines a text takes, wrapped at `width`.
export const linesOf = (text: string, width: number) => Math.max(1, Math.ceil(text.length / width));

// Age of a session for /sessions.
export function ago(then: Date, now = Date.now()): string {
  const minutes = (now - then.getTime()) / 60_000;
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (24 * 60))}d ago`;
}

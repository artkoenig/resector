// Display helpers for the Gate: token numbers, titles, fixed-width cells.
import type { Block } from '../core/log/fold';
import { toolNames } from '../core/toolcall/bash';

export const formatTokens = (t: number): string =>
  t >= 1024 && t % 1024 === 0 ? `${t / 1024}k` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

type Titled = Pick<Block, 'kind' | 'content'> & Partial<Pick<Block, 'title' | 'call' | 'source' | 'compacted'>>;
const firstLine = (text: string) => (text.split('\n').find(l => l.trim()) ?? '').trim();

// FR-4: display label only, never sent. A rename wins; default = first non-empty line of the content;
// origin titles: `System prompt`, the tool names, `→ <call>` (the call from `blocks`), `⇄ <call>` (a Note from a Tool Pair),
// `◇ N blocks compacted` (a Note from a Compaction, FR-16).
export function titleOf(block: Titled, blocks: readonly Pick<Block, 'id' | 'content'>[] = []): string {
  if (block.title) return block.title;
  if (block.kind === 'System') return 'System prompt';
  if (block.kind === 'Tools') return toolNames(block.content);
  // Only whitespace (e.g. the text before a model's tool calls): nothing to read, the template may drop it.
  return originTitle(block, blocks) ?? (firstLine(block.content) || '(empty)');
}
function originTitle(block: Titled, blocks: readonly Pick<Block, 'id' | 'content'>[]): string | null {
  if (block.kind === 'Tool Result') return `→ ${firstLine(blocks.find(b => b.id === block.call)?.content ?? '')}`;
  if (block.source !== undefined) return `⇄ ${firstLine(block.source)}`;
  return block.compacted ? `◇ ${count(block.compacted.sources.length, 'block')} compacted` : null;
}

// FR-5: changes since the last request: new Revision, pin set/changed, moved.
const changesOf = (block: Block): string =>
  (block.revised ? `✎${block.revision}` : '') + ((block.pinChanged && { top: '⤒', bottom: '⤓' }[block.pin!]) || '') + (block.moved ? '⇄' : '');

// Changes since the last request, then persistent status flags.
// next: the Tool Call to decide on now; later pending calls are queued (FR-24); dropped: a Thinking
// block the chat template drops (FR-48).
export const flagsOf = (block: Block, next?: number, dropped = false): string =>
  [
    changesOf(block),
    block.cutOff ? ' ⚠ cut off' : '',
    block.pending ? (block.id === next ? ' ? approve' : ' · queued') : '',
    block.stopped ? ` ⚠ ${block.stopped}` : '',
    dropped ? ' ✂ template' : '',
  ]
    .join('')
    .trim();

// `1 block`, `2 blocks`.
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

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

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Age of a session for /sessions (FR-33).
export function ago(then: Date, now = Date.now()): string {
  const minutes = (now - then.getTime()) / 60_000;
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (24 * 60))}d ago`;
}

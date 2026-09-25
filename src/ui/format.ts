// Display helpers for the Gate: token numbers, titles, fixed-width cells.
import type { Block } from '../core/log/fold';
import { toolNames } from '../core/toolcall/bash';

export const formatTokens = (t: number): string =>
  t >= 1024 && t % 1024 === 0 ? `${t / 1024}k` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

type Titled = Pick<Block, 'kind' | 'content'> & Partial<Pick<Block, 'title' | 'call'>>;
const firstLine = (text: string) => (text.split('\n').find(l => l.trim()) ?? '').trim();

// FR-4: display label only, never sent. A rename wins; default = first non-empty line of the content;
// origin titles: `System prompt`, the tool names, `→ <call>` (the call from `blocks`).
export function titleOf(block: Titled, blocks: readonly Pick<Block, 'id' | 'content'>[] = []): string {
  if (block.title) return block.title;
  if (block.kind === 'System') return 'System prompt';
  if (block.kind === 'Tools') return toolNames(block.content);
  if (block.kind === 'Tool Result') return `→ ${firstLine(blocks.find(b => b.id === block.call)?.content ?? '')}`;
  return firstLine(block.content);
}

// FR-5: changes since the last request (pin set/changed, moved), then persistent status flags.
// next: the Tool Call to decide on now; later pending calls are queued (FR-24).
export const flagsOf = (block: Block, next?: number): string =>
  [
    (block.pinChanged && { top: '⤒', bottom: '⤓' }[block.pin!]) || '',
    block.moved ? '⇄' : '',
    block.cutOff ? ' ⚠ cut off' : '',
    block.pending ? (block.id === next ? ' ? approve' : ' · queued') : '',
    block.stopped ? ` ⚠ ${block.stopped}` : '',
  ]
    .join('')
    .trim();

export const cell = (s: string, width: number): string =>
  s.length > width ? s.slice(0, Math.max(0, width - 1)) + '…' : s.padEnd(width);

export const right = (s: string, width: number): string => s.padStart(width);

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Age of a session for /sessions (FR-33).
export function ago(then: Date, now = Date.now()): string {
  const minutes = (now - then.getTime()) / 60_000;
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (24 * 60))}d ago`;
}

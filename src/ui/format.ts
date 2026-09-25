// Display helpers for the Gate: token numbers, titles, fixed-width cells.
import type { Block } from '../core/log/fold';

export const formatTokens = (t: number): string =>
  t >= 1024 && t % 1024 === 0 ? `${t / 1024}k` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

// FR-4: display label only, never sent. A rename wins; default = first non-empty line of the content.
export const titleOf = (block: Pick<Block, 'kind' | 'content'> & { title?: string | null }): string =>
  block.title ?? (block.kind === 'System' ? 'System prompt' : (block.content.split('\n').find(l => l.trim()) ?? '').trim());

// FR-5: changes since the last request (pin set/changed, moved), then persistent status flags.
export const flagsOf = (block: Block): string =>
  [(block.pinChanged && { top: '⤒', bottom: '⤓' }[block.pin!]) || '', block.moved ? '⇄' : '', block.cutOff ? ' ⚠ cut off' : '']
    .join('')
    .trim();

export const cell = (s: string, width: number): string =>
  s.length > width ? s.slice(0, Math.max(0, width - 1)) + '…' : s.padEnd(width);

export const right = (s: string, width: number): string => s.padStart(width);

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

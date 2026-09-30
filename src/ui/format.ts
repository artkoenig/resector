// Display helpers for the Gate: token numbers, titles, fixed-width cells.
import type { Thinking } from '../core/log/events';
import { callText, type Block } from '../core/log/fold';
import { toolNames } from '../core/toolcall/bash';
import { questionTitle } from '../core/toolcall/question';

export const formatTokens = (t: number): string =>
  t >= 1024 && t % 1024 === 0 ? `${t / 1024}k` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

// `off`, `on`, or `on:<effort>`.
export const thinkingLabel = (thinking: Thinking) => (thinking === 'off' || thinking === 'on' ? thinking : `on:${thinking}`);

type Titled = Pick<Block, 'kind' | 'content'> & Partial<Pick<Block, 'title' | 'call' | 'source' | 'compacted' | 'file' | 'origin' | 'tool'>>;
type Called = Pick<Block, 'id' | 'content'> & Partial<Pick<Block, 'tool'>>;
const firstLine = (text: string) => (text.split('\n').find(l => l.trim()) ?? '').trim();

// Display label only, never sent. A rename wins; default = first non-empty line of the content;
// origin titles: `System prompt`, the tool names, `→ <call>` (the call from `blocks`), `⇄ <call>` (a Note from a Tool Pair),
// `◇ N blocks compacted` (a Note from a Compaction), `@<path>`, `Environment`,
// `Context Policy` (a policy's Note).
export function titleOf(block: Titled, blocks: readonly Called[] = []): string {
  if (block.title) return block.title;
  if (block.kind === 'System') return 'System prompt';
  if (block.kind === 'Tools') return toolNames(block.content);
  // Only whitespace (e.g. the text before a model's tool calls): nothing to read, the template may drop it.
  return originTitle(block, blocks) ?? (firstLine(block.content) || '(empty)');
}
// A call as its title reads: a Question by its question texts.
const callTitle = (call: Pick<Block, 'content'> & Partial<Pick<Block, 'tool'>>) =>
  firstLine(call.tool === 'question' ? `question ${questionTitle(call.content)}` : callText(call));
// A Tool Result by its call; a Tool Call of another tool than bash by tool name and query.
function toolTitle(block: Titled, blocks: readonly Called[]): string | null {
  if (block.kind !== 'Tool Result') return block.tool ? callTitle(block) : null;
  const call = blocks.find(b => b.id === block.call);
  return `→ ${call ? callTitle(call) : ''}`;
}
function originTitle(block: Titled, blocks: readonly Called[]): string | null {
  const tool = toolTitle(block, blocks);
  if (tool !== null) return tool;
  if (block.source !== undefined) return `⇄ ${firstLine(block.source)}`;
  if (block.file !== undefined) return `@${block.file}`;
  if (block.origin === 'environment') return 'Environment';
  if (block.origin === 'policy') return 'Context Policy';
  return block.compacted ? `◇ ${count(block.compacted.sources.length, 'block')} compacted` : null;
}

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

// Age of a session for /sessions.
export function ago(then: Date, now = Date.now()): string {
  const minutes = (now - then.getTime()) / 60_000;
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (24 * 60))}d ago`;
}

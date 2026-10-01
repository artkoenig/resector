// Texts the Gate writes into its status and titles: token numbers, block titles, labels, errors.
import type { Thinking } from '../core/log/events';
import { callText, type Block } from '../core/log/fold';
import type { Reviewed } from './review';
import { toolNames } from '../core/tools/catalog';
import { questionTitle } from '../core/tools/question';
import type { Speed } from '../core/tools/answer';

export const formatTokens = (t: number): string =>
  t >= 1024 && t % 1024 === 0 ? `${t / 1024}k` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

// Tokens/s, one decimal below 100.
const rate = (r: number) => `${r >= 100 ? Math.round(r) : r.toFixed(1)} tok/s`;

// Generation speed measured on the stream: the tokens after the first of `n`, over the `ms` since it; null while
// too short to tell.
export const generationRate = (n: number, ms: number): number | null => (ms < 500 || n < 2 ? null : ((n - 1) * 1000) / ms);
export const rateText = (n: number, ms: number): string | null => {
  const r = generationRate(n, ms);
  return r === null ? null : rate(r);
};

// An answer's speed: generation, prompt processing, time to the first token; null when nothing is known.
export const speedText = ({ generation, prompt, firstToken }: Speed): string | null =>
  [
    generation !== undefined && rate(generation),
    prompt !== undefined && `prompt ${rate(prompt)}`,
    firstToken !== undefined && `first token ${(firstToken / 1000).toFixed(1)}s`,
  ].filter(Boolean).join(' · ') || null;

// `off`, `on`, or `on:<effort>`.
export const thinkingLabel = (thinking: Thinking) => (thinking === 'off' || thinking === 'on' ? thinking : `on:${thinking}`);

type Titled = Pick<Block, 'kind' | 'content'> & Partial<Pick<Reviewed, 'title'>> & Partial<Pick<Block, 'call' | 'source' | 'compacted' | 'file' | 'origin' | 'tool'>>;
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

// `1 block`, `2 blocks`.
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

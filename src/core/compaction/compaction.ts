// Compaction: the user's selection rewritten by the LLM into one Note, reviewed before it replaces the sources.
import { isFixed, type Outcome } from '../context/operations';
import type { SessionEvent } from '../log/events';
import { pairOf, type Context } from '../log/fold';
import { renderNative, type Request } from '../render/native';
import system from './compaction-system.md' with { type: 'text' };
import instruction from './default-instruction.md' with { type: 'text' };

type Compact = Extract<SessionEvent, { type: 'Compact' }>;

export const COMPACTION_SYSTEM = system.trimEnd();
// Used when the user sends an empty instruction and no `compaction.md` exists.
export const DEFAULT_INSTRUCTION = instruction.trimEnd();

const NOTHING = { error: 'nothing to compact (System, Tools and pending Tool Calls, unread @path references are excluded)' };

// The blocks to compact, in Context order: the marked ones, else the selected block (a Tool Pair as a whole).
export function sourcesOf(context: Context, marked: ReadonlySet<number>, selected: number): { sources: number[] } | { error: string } {
  // The selection may be the live row, which is no block.
  if (!marked.size && !context.blocks.some(b => b.id === selected)) return NOTHING;
  const wanted = marked.size ? marked : new Set(pairOf(context.blocks, selected));
  const sources = context.blocks.filter(b => wanted.has(b.id) && !isFixed(b) && !b.pending && !b.unread && !b.removed).map(b => b.id);
  return sources.length ? { sources } : NOTHING;
}

// Only the sources and the instruction, no tools. Titles are display only, never sent.
export function compactionRequest(context: Context, sources: number[], instruction: string): Request {
  const text = context.blocks.filter(b => sources.includes(b.id)).map(b => `# ${b.kind}\n${b.content}`).join('\n\n');
  return { messages: [{ role: 'system', content: COMPACTION_SYSTEM }, { role: 'user', content: `${text}\n\nInstruction: ${instruction}` }], tools: [] };
}

// The Context as the next request sends it, the instruction as the last message: only that is new to the server's prefix cache.
// No reasoning: the Note is the answer, begun with the instruction's first line. Not thinking off: the chat template renders
// the thinking mode into the system prompt, so switching it would miss the cache.
export function inContextRequest(context: Context, instruction: string): Request {
  const request = renderNative(context);
  const start = instruction.split('\n').find(l => l.startsWith('## '));
  return { ...request, messages: [...request.messages, { role: 'user', content: instruction }], ...(start && { answerStart: `${start}\n` }) };
}

export function accept(sources: number[], instruction: string, noteId: number, content: string): Outcome<Compact> {
  if (!content.trim()) return { error: 'empty proposal – e to edit, i to change the instruction, x to discard' };
  return { event: { type: 'Compact', sources, instruction, noteId, content } };
}

// Tokens saved, in whole percent of `before`; nothing to save from nothing.
export const reduction = (before: number, after: number) => (before ? Math.round((1 - after / before) * 100) : 0);

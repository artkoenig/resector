// Compaction: the user's selection rewritten by the LLM into one Note, reviewed before it replaces the sources.
import { isFixed, type Outcome } from '../context/operations';
import type { SessionEvent } from '../log/events';
import { pairOf, type Context } from '../log/fold';
import { sourcesRequest } from '../render/compaction';
import type { Request } from '../render/native';
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
  const sources = context.blocks.filter(b => wanted.has(b.id) && !isFixed(b) && !b.pending && !b.unread).map(b => b.id);
  return sources.length ? { sources } : NOTHING;
}

// The request for a Note of the sources alone, in Context order.
export const compactionRequest = (context: Context, sources: number[], instruction: string): Request =>
  sourcesRequest(COMPACTION_SYSTEM, context.blocks.filter(b => sources.includes(b.id)), instruction);

export function accept(sources: number[], instruction: string, noteId: number, content: string): Outcome<Compact> {
  if (!content.trim()) return { error: 'empty proposal – e to edit, i to change the instruction, x to discard' };
  return { event: { type: 'Compact', sources, instruction, noteId, content } };
}

// Tokens saved, in whole percent of `before`; nothing to save from nothing.
export const reduction = (before: number, after: number) => (before ? Math.round((1 - after / before) * 100) : 0);

// Compaction (FR-13–FR-17): the user's selection rewritten by the LLM into one Note, reviewed before it replaces the sources.
import { isFixed, type Outcome } from '../context/operations';
import type { SessionEvent } from '../log/events';
import { pairOf, type Context } from '../log/fold';
import type { Request } from '../render/native';

type Compact = Extract<SessionEvent, { type: 'Compact' }>;

export const COMPACTION_SYSTEM = 'Rewrite the given context blocks into one compact note, following the instruction. Output only the note.';
// Used when the user sends an empty instruction and no `compaction.md` exists (FR-13).
export const DEFAULT_INSTRUCTION = 'Keep file paths, line numbers, decisions, errors and open todos. Drop passing output and code already fixed.';

const NOTHING = { error: 'nothing to compact (System, Tools and pending Tool Calls are excluded)' };

// The blocks to compact, in Context order: the marked ones, else the selected block (a Tool Pair as a whole, FR-9).
export function sourcesOf(context: Context, marked: ReadonlySet<number>, selected: number): { sources: number[] } | { error: string } {
  // The selection may be the live row, which is no block.
  if (!marked.size && !context.blocks.some(b => b.id === selected)) return NOTHING;
  const wanted = marked.size ? marked : new Set(pairOf(context.blocks, selected));
  const sources = context.blocks.filter(b => wanted.has(b.id) && !isFixed(b) && !b.pending && !b.removed).map(b => b.id);
  return sources.length ? { sources } : NOTHING;
}

// Only the sources and the instruction, no tools (FR-14). Titles are display only, never sent.
export function compactionRequest(context: Context, sources: number[], instruction: string): Request {
  const text = context.blocks.filter(b => sources.includes(b.id)).map(b => `### ${b.kind}\n${b.content}`).join('\n\n');
  return { messages: [{ role: 'system', content: COMPACTION_SYSTEM }, { role: 'user', content: `${text}\n\nInstruction: ${instruction}` }], tools: [] };
}

export function accept(sources: number[], instruction: string, noteId: number, content: string): Outcome<Compact> {
  if (!content.trim()) return { error: 'empty proposal – e to edit, i to change the instruction, x to discard' };
  return { event: { type: 'Compact', sources, instruction, noteId, content } };
}

// Tokens saved, in whole percent of `before`; nothing to save from nothing.
export const reduction = (before: number, after: number) => (before ? Math.round((1 - after / before) * 100) : 0);

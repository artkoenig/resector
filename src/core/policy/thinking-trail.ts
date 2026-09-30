// The built-in Context Policy thinking-trail (ADR 0001), written like a policy module in ~/.config/resector/policies:
// a default export over the view, types only from the interface. The reference for writing one.
import type { PolicyBlock, PolicyContext, PolicyOperation } from './policy';
import instruction from './thinking-trail-instruction.md' with { type: 'text' };

const TO_COMPACT = 5;
// The trail is cut only once the Context takes this share of the window: until then it costs little.
const CUT_FROM = 2 / 3;
export const INSTRUCTION = instruction.trimEnd();

// A Note of its own right before the first Note of the trail: the model reads the trail as a user message, so it is told
// this is its own work, not a new task. Not part of the trail, so never compacted into it.
export const LEAD =
  'The summary below is of your own earlier work in this session, not a new task. Build on it, do not redo what is under Done; continue with Next steps.';

// What the model is told of this policy: what happens, no thresholds, no instructions.
export const ABOUT =
  'Tool calls and results are removed once you have reasoned past them; your reasoning and answers are later replaced by summaries, shown as user messages, which are merged over time without dropping insights.';

export const description = 'drops tool pairs, summarizes reasoning';

export default function thinkingTrail({ window, used, blocks }: PolicyContext): PolicyOperation[] {
  // Right after the Tools Block: early and unchanged, so the prefix cache keeps it.
  const described = blocks.some(b => b.origin === 'policy' && b.content === ABOUT);
  const tools = blocks.find(b => b.kind === 'Tools');
  // Alone in its pass: the lead is placed after it.
  if (!described && tools) return [{ op: 'note', after: tools.id, content: ABOUT }];
  const about = led(blocks);
  // Tool Pairs go and the Thinking is compacted together, once the window is filled that far.
  if (used < window * CUT_FROM) return [...about, ...notesCompacted(blocks)];
  const thinking = blocks.filter(b => b.kind === 'Thinking');
  // The blocks before the newest Thinking: the model has reasoned past them.
  const before = new Set(blocks.slice(0, Math.max(blocks.indexOf(thinking.at(-1)!), 0)).map(b => b.id));
  // A Tool Pair with both blocks there; a Tool Call without result has no pair and stays.
  // A Tool Result of the user (a Question's answers) stays with its call: the user's word is not reasoned past.
  const byUser = new Set(blocks.filter(b => b.origin === 'user').map(b => b.id));
  const reasonedPast = blocks.filter(b => b.kind === 'Tool Call' && before.has(b.id) && before.has(b.pair!) && !byUser.has(b.pair!));
  const operations: PolicyOperation[] = [...about, ...reasonedPast.map(b => ({ op: 'remove' as const, id: b.id }))];
  // The answers between and the Notes of earlier Compactions go along: one trail, the reasoning and what came of it.
  const trail = blocks.filter(b => b.kind === 'Thinking' || b.kind === 'Assistant' || b.origin === 'compaction');
  if (!thinking.length) return [...operations, ...notesCompacted(blocks)];
  return [...operations, { op: 'compact', sources: trail.map(b => b.id), instruction: INSTRUCTION }];
}

// The trails pile up as Notes: those of any Compaction, the user's too, are compacted the same way.
function notesCompacted(blocks: PolicyContext['blocks']): PolicyOperation[] {
  const notes = blocks.filter(b => b.origin === 'compaction');
  return notes.length >= TO_COMPACT ? [{ op: 'compact', sources: notes.map(b => b.id), instruction: INSTRUCTION }] : [];
}

// Its lead right before the first Note of a Compaction; one elsewhere, left behind by a Compaction or without Notes, goes.
function led(blocks: PolicyBlock[]): PolicyOperation[] {
  const isLead = (b: PolicyBlock) => b.origin === 'policy' && b.content === LEAD;
  const first = blocks.find(b => b.origin === 'compaction');
  const before = first && blocks[blocks.indexOf(first) - 1]!;
  const stale = blocks.filter(b => isLead(b) && b !== before);
  const add: PolicyOperation[] = before && !isLead(before) ? [{ op: 'note', after: before.id, content: LEAD }] : [];
  return [...stale.map(b => ({ op: 'remove' as const, id: b.id })), ...add];
}

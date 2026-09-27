// The built-in Context Policy thinking-trail (ADR 0001), written like a policy module in ~/.config/resector/policies:
// a default export over the view, types only from the interface. The reference for writing one.
import type { PolicyContext, PolicyOperation } from './policy';

const THINKING_TO_COMPACT = 5;
export const INSTRUCTION =
  'Summarise these reasoning steps into a concise trail: goal, findings and decisions so far with their reasons, approaches discarded, next planned step. No repetition, no tool output.';

export default function thinkingTrail({ blocks }: PolicyContext): PolicyOperation[] {
  const thinking = blocks.filter(b => b.kind === 'Thinking');
  // The blocks before the newest Thinking: the model has reasoned past them.
  const before = new Set(blocks.slice(0, Math.max(blocks.indexOf(thinking.at(-1)!), 0)).map(b => b.id));
  // A Tool Pair with both blocks there; a Tool Call without result has no pair and stays.
  const reasonedPast = blocks.filter(b => b.kind === 'Tool Call' && before.has(b.id) && before.has(b.pair!));
  const operations: PolicyOperation[] = reasonedPast.map(b => ({ op: 'remove', id: b.id }));
  // The Note is not Thinking: the count restarts.
  if (thinking.length >= THINKING_TO_COMPACT) operations.push({ op: 'compact', sources: thinking.map(b => b.id), instruction: INSTRUCTION });
  return operations;
}

// The built-in Context Policy thinking-trail (ADR 0001), written like a policy module in ~/.config/resector/policies:
// a default export over the view, types only from the interface. The reference for writing one.
import type { PolicyContext, PolicyOperation } from './policy';

// Thinking blocks it takes to compact them into one trail.
const TRAIL_AT = 5;
export const INSTRUCTION =
  'Summarise these reasoning steps into a concise trail: goal, findings and decisions so far with their reasons, approaches discarded, next planned step. No repetition, no tool output.';

export default function thinkingTrail({ blocks }: PolicyContext): PolicyOperation[] {
  const newest = blocks.findLastIndex(b => b.kind === 'Thinking');
  // The model has reasoned past every Tool Pair before its newest Thinking; a Tool Call without result stays.
  const seen = blocks.slice(0, Math.max(newest, 0)).filter(b => b.kind === 'Tool Call' && b.pair !== null);
  const thinking = blocks.filter(b => b.kind === 'Thinking');
  return [
    ...seen.map((b): PolicyOperation => ({ op: 'remove', id: b.id })),
    // The Note is not Thinking: the count restarts.
    ...(thinking.length >= TRAIL_AT ? [{ op: 'compact' as const, sources: thinking.map(b => b.id), instruction: INSTRUCTION }] : []),
  ];
}

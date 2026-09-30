// Example Context Policy lean (ADR 0001): keeps the last 3 Tool Pairs, compacts the Thinking from half the window on.
// Copy it to ~/.config/resector/policies/ and switch it on with `/policy lean`; the type import is erased at load.
import type { PolicyContext, PolicyOperation } from '../../src/core/policy/policy';

const KEEP = 3;
const INSTRUCTION = 'Summarize the reasoning; keep decisions and open questions.';

export const description = 'keeps the last 3 Tool Pairs, compacts Thinking past half the window';

export default function lean({ window, used, blocks }: PolicyContext): PolicyOperation[] {
  // A call awaiting approval or without result is not a Tool Pair yet: it stays.
  const calls = blocks.filter(b => b.kind === 'Tool Call' && b.pair !== null && !b.pending);
  const stale = calls.slice(0, -KEEP).map(b => ({ op: 'remove' as const, id: b.id }));
  if (stale.length) return stale;

  // Compacted into one Note, the Thinking is gone: the next pass returns nothing.
  const thinking = blocks.filter(b => b.kind === 'Thinking');
  if (used < window / 2 || thinking.length < 2) return [];
  return [{ op: 'compact', sources: thinking.map(b => b.id), instruction: INSTRUCTION }];
}

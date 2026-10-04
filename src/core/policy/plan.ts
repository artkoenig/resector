// A policy's operations checked against the Session Log by the same rules as the user's (ADR 0001), and what they did.
import * as ops from '../context/operations';
import type { SessionEvent } from '../log/events';
import { fold, pairOf, type Block, type Context } from '../log/fold';
import type { PolicyOperation } from './policy';

// What an operation did, for the status line: counted (`3 Tool Pairs removed`) or as is (a Compaction).
export type Change = { noun: string; verb: string } | { text: string };
// The events an operation appends, or the Compaction to run first; or why not.
export type Plan = { events: SessionEvent[]; change: Change } | { compact: Compaction; change: Change } | { error: string };
export type Compaction = { sources: number[]; instruction: string; inContext?: boolean };
type Of<O extends PolicyOperation['op']> = Extract<PolicyOperation, { op: O }>;
type Planner<O extends PolicyOperation['op']> = (events: SessionEvent[], context: Context, op: Of<O>) => Plan;

const EDITED = { noun: 'block', verb: 'edited' };
const MOVED = { noun: 'block', verb: 'moved' };
// A Tool Pair counts once, as a pair.
const nounOf = (block: Block) => (ops.inPair(block) ? 'Tool Pair' : block.kind);
const done = (outcome: ops.Outcome, change: Change): Plan => ('error' in outcome ? outcome : { events: [outcome.event], change });

const PLANNERS: { [O in PolicyOperation['op']]: Planner<O> } = {
  remove: (_, context, op) => withBlock(context, op.id, block => done(ops.remove(block), { noun: nounOf(block), verb: 'removed' })),
  edit: (events, context, op) => withBlock(context, op.id, block => {
    const error = ops.untouchable(block)?.error ?? ops.editable(block);
    return error ? { error } : done(ops.revise(events, block, op.content), EDITED);
  }),
  move: (events, context, op) => withBlock(context, op.id, block => (ops.inPair(block) ? moveAsNote(events, context, block, op.after) : done(ops.moveAfter(context, block, op.after), MOVED))),
  compact: (_, context, op) => compactPlan(context, op),
  note: (_, context, op) => done(ops.addNote(context, context.nextId, op.after, op.content), { noun: 'Note', verb: 'added' }),
};

// The operation checked against the Context of the Session Log; operations refer to blocks by id.
export function plan(events: SessionEvent[], op: PolicyOperation): Plan {
  return (PLANNERS[op.op] as Planner<PolicyOperation['op']>)(events, fold(events), op);
}

const sent = (context: Context, id: number) => context.blocks.find(b => b.id === id);
function withBlock(context: Context, id: number, then: (block: Block) => Plan): Plan {
  const block = sent(context, id);
  return block ? then(block) : { error: `no block ${id} in the Context` };
}

// Moving a Tool Pair turns it into a Note first; the Note then moves.
function moveAsNote(events: SessionEvent[], context: Context, block: Block, after: number): Plan {
  const note = ops.toNote(block, context.nextId) as { event: SessionEvent };
  const converted = fold([...events, note.event]);
  const moved = ops.moveAfter(converted, sent(converted, context.nextId)!, after);
  return 'error' in moved ? moved : { events: [note.event, moved.event], change: MOVED };
}

// Why a source may not be compacted, if not.
function unfit(context: Context, id: number): string | undefined {
  const block = sent(context, id);
  return block ? ops.untouchable(block)?.error : `no block ${id} in the Context`;
}

function compactPlan(context: Context, { sources, instruction, inContext }: Of<'compact'>): Plan {
  const error = sources.map(id => unfit(context, id)).find(Boolean);
  if (error) return { error };
  if (!sources.length) return { error: 'nothing to compact' };
  if (!instruction.trim()) return { error: 'no instruction' };
  const wanted = new Set(sources.flatMap(id => pairOf(context.blocks, id)));
  const ordered = context.blocks.filter(b => wanted.has(b.id));
  // Kinds in Context order, a Tool Pair once.
  const nouns = new Map<string, number>();
  for (const b of ordered.filter(b => b.kind !== 'Tool Result')) nouns.set(nounOf(b), (nouns.get(nounOf(b)) ?? 0) + 1);
  const text = [...nouns].map(([noun, n]) => `${n} ${noun}`).join(' + ');
  return { compact: { sources: ordered.map(b => b.id), instruction, ...(inContext && { inContext }) }, change: { text: `${text} → 1 Note` } };
}

// Counted nouns in plural; a kind reads as is (`2 Thinking removed`).
const PLURAL = new Set(['Tool Pair', 'block']);
// The status line after the policy ran: `lean-compact: 3 Tool Pairs removed, 5 Thinking → 1 Note`.
export function summary(name: string, changes: Change[]): string {
  type Counted = { noun: string; verb: string; n: number };
  const counts = new Map<string, Counted>();
  const parts: (string | Counted)[] = [];
  for (const change of changes) {
    if ('text' in change) {
      parts.push(change.text);
      continue;
    }
    const key = `${change.noun} ${change.verb}`;
    const counted = counts.get(key) ?? { ...change, n: 0 };
    if (!counted.n++) parts.push(counts.set(key, counted).get(key)!);
  }
  const text = (part: string | Counted) => (typeof part === 'string' ? part : `${part.n} ${part.noun}${part.n > 1 && PLURAL.has(part.noun) ? 's' : ''} ${part.verb}`);
  return `${name}: ${parts.map(text).join(', ') || 'no change'}`;
}

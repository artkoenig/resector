// Context operations at the Review Gate (FR-4, FR-10, NFR-3): each yields the event to append, or why not.
import type { SessionEvent } from '../log/events';
import { undone, type Block, type Context } from '../log/fold';
import { resultText, type RunResult } from '../toolcall/bash';

export type Outcome<E extends SessionEvent = SessionEvent> = { event: E } | { error: string };
type Undo = Extract<SessionEvent, { type: 'Undo' }>;

type BlockAdded = Extract<SessionEvent, { type: 'BlockAdded' }>;

// System and Tools Block stay first: never moved, pinned, removed or marked (FR-12).
export const isFixed = (block: Block) => block.kind === 'System' || block.kind === 'Tools';
const NAME = { System: 'System prompt', Tools: 'Tools Block' } as Record<string, string>;
const fixed = (block: Block) => ({ error: `${NAME[block.kind]} is fixed` });
// A Tool Call awaiting approval keeps its place until it has a result.
const AWAITS = { error: 'Tool Call awaits approval – y run once · n reject' };
// Why an operation may not touch the block, if not.
const guard = (block: Block) => (isFixed(block) ? fixed(block) : block.pending ? AWAITS : null);
const UNDOABLE = new Set<SessionEvent['type']>(['Move', 'Pin', 'Unpin', 'Remove', 'Rename']);

export function move({ blocks }: Context, block: Block, dir: -1 | 1): Outcome {
  const blocked = guard(block);
  if (blocked) return blocked;
  const live = blocks.filter(b => !b.removed);
  const neighbour = live[live.indexOf(block) + dir];
  // Blocks move only inside their area: top pins, unpinned, bottom pins; System stays first.
  if (!neighbour || isFixed(neighbour) || neighbour.pin !== block.pin) return { error: 'boundary reached (fixed / pinned area)' };
  const after = dir === 1 ? neighbour : blocks[blocks.indexOf(neighbour) - 1]!;
  return { event: { type: 'Move', id: block.id, after: after.id } };
}

// p cycles top → bottom → off.
export function pin(block: Block): Outcome {
  const blocked = guard(block);
  if (blocked) return blocked;
  if (block.pin === 'bottom') return { event: { type: 'Unpin', id: block.id } };
  return { event: { type: 'Pin', id: block.id, at: block.pin === 'top' ? 'bottom' : 'top' } };
}

export function remove(block: Block): Outcome {
  if (isFixed(block)) return { error: `${NAME[block.kind]} cannot be removed` };
  if (block.pending) return AWAITS;
  return { event: { type: 'Remove', id: block.id } };
}

export const rename = (block: Block, title: string): Outcome => ({ event: { type: 'Rename', id: block.id, title: title.trim() } });

// Undo cancels the latest Context operation not yet undone, by a counter-event.
export function undo(events: SessionEvent[]): Outcome<Undo> {
  const skip = undone(events);
  const eventId = events.findLastIndex((e, i) => UNDOABLE.has(e.type) && !skip.has(i));
  return eventId === -1 ? { error: 'nothing to undo' } : { event: { type: 'Undo', eventId } };
}

// The Tool Call to decide on next: calls are approved one by one in Context order (FR-24).
export const nextCall = (context: Context): Block | undefined => context.blocks.find(b => b.pending && !b.removed);

// Why the block cannot be run or rejected now, or null.
export function approvable(context: Context, block: Block): string | null {
  if (!block.pending) return 'not awaiting approval';
  return nextCall(context) === block ? null : 'approve the earlier Tool Call first';
}

export const toolResult = (call: Block, id: number, run: RunResult, timeout: number): BlockAdded => ({
  type: 'BlockAdded', id, kind: 'Tool Result', origin: 'tool', content: resultText(run, timeout), call: call.id,
  ...(run.stopped && { stopped: run.stopped }),
});

// n: the call is not run; its result tells the model so (FR-23).
export function reject(context: Context, call: Block, id: number): Outcome {
  const error = approvable(context, call);
  return error ? { error } : { event: { type: 'BlockAdded', id, kind: 'Tool Result', origin: 'tool', content: 'rejected by user', call: call.id } };
}

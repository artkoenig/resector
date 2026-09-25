// Context operations at the Review Gate (FR-4, FR-10, NFR-3): each yields the event to append, or why not.
import type { SessionEvent } from '../log/events';
import { undone, type Block, type Context } from '../log/fold';

export type Outcome = { event: SessionEvent } | { error: string };

const FIXED = { error: 'System prompt is fixed' };
const UNDOABLE = new Set<SessionEvent['type']>(['Move', 'Pin', 'Unpin', 'Remove', 'Rename']);

export function move({ blocks }: Context, block: Block, dir: -1 | 1): Outcome {
  if (block.kind === 'System') return FIXED;
  const live = blocks.filter(b => !b.removed);
  const neighbour = live[live.indexOf(block) + dir];
  // Blocks move only inside their area: top pins, unpinned, bottom pins; System stays first.
  if (!neighbour || neighbour.kind === 'System' || neighbour.pin !== block.pin) return { error: 'boundary reached (fixed / pinned area)' };
  const after = dir === 1 ? neighbour : blocks[blocks.indexOf(neighbour) - 1]!;
  return { event: { type: 'Move', id: block.id, after: after.id } };
}

// p cycles top → bottom → off.
export function pin(block: Block): Outcome {
  if (block.kind === 'System') return FIXED;
  if (block.pin === 'bottom') return { event: { type: 'Unpin', id: block.id } };
  return { event: { type: 'Pin', id: block.id, at: block.pin === 'top' ? 'bottom' : 'top' } };
}

export function remove(block: Block): Outcome {
  if (block.kind === 'System') return { error: 'System prompt cannot be removed' };
  return { event: { type: 'Remove', id: block.id } };
}

export const rename = (block: Block, title: string): SessionEvent => ({ type: 'Rename', id: block.id, title: title.trim() });

// Undo cancels the latest Context operation not yet undone, by a counter-event.
export function undo(events: SessionEvent[]): Outcome {
  const skip = undone(events);
  const eventId = events.findLastIndex((e, i) => UNDOABLE.has(e.type) && !skip.has(i));
  return eventId === -1 ? { error: 'nothing to undo' } : { event: { type: 'Undo', eventId } };
}

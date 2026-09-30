// The Context as the Gate shows it: what changed since the last request, derived from the Session Log on top of fold.
import type { SessionEvent } from '../core/log/events';
import { fold, undone, type Block, type Context } from '../core/log/fold';

// title: set by Rename. removed: struck through until the next request, then gone. moved, revised: since the last
// request (revised: another Revision than sent, `✎n`). missing: an unread reference whose file cannot be read now.
export type Reviewed = Block & { title: string | null; removed: boolean; moved: boolean; revised: boolean; missing?: string };

// context: fold(events) as the Gate holds it (unread references peeked); missing: why a reference cannot be read.
export function review(events: SessionEvent[], context: Context, missing: ReadonlyMap<number, string> = new Map()): Reviewed[] {
  const skip = undone(events);
  const since = events.findLastIndex(e => e.type === 'RequestSent') + 1;
  const unsent = (i: number) => i >= since && !skip.has(i);
  // Replayed without the removals since the last request, the removed blocks stay in their place.
  const removals = new Set(events.flatMap((e, i) => (e.type === 'Remove' && unsent(i) ? [i] : [])));
  const live = new Map(context.blocks.map(b => [b.id, b]));
  const moved = movedSince(events, since, unsent);
  const sent = revisionsSent(events.slice(0, since));
  const titles = titlesOf(events, skip);
  return fold(events, new Set([...skip, ...removals])).blocks.map(b => {
    const block = live.get(b.id) ?? b;
    const error = missing.get(b.id);
    return { ...block, title: titles.get(b.id) ?? null, removed: !live.has(b.id), moved: moved.has(b.id), revised: block.revision !== (sent.get(b.id) ?? 1),
      ...(error !== undefined && { missing: error }) };
  });
}

// Moved since the last request, or its move undone since, when that move was sent.
function movedSince(events: SessionEvent[], since: number, unsent: (i: number) => boolean): Set<number> {
  return new Set(events.flatMap((e, i) => {
    if (!unsent(i)) return [];
    if (e.type === 'Move') return [e.id];
    const target = e.type === 'Undo' && e.eventId < since ? events[e.eventId] : undefined;
    return target?.type === 'Move' ? [target.id] : [];
  }));
}

// The Revision of each edited block as sent in the request that closes `events`.
function revisionsSent(events: SessionEvent[]): Map<number, number> {
  const skip = undone(events);
  return new Map(events.flatMap((e, i) => (e.type === 'Edit' && !skip.has(i) ? [[e.id, e.revision] as const] : [])));
}

// Titles by Rename; an empty one resets it.
function titlesOf(events: SessionEvent[], skip: Set<number>): Map<number, string> {
  const titles = new Map<number, string>();
  events.forEach((e, i) => {
    if (e.type !== 'Rename' || skip.has(i)) return;
    if (e.title) titles.set(e.id, e.title);
    else titles.delete(e.id);
  });
  return titles;
}

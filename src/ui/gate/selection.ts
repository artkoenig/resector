// Gate rows: the sent blocks and live rows in order, the Kind Filters, the selection and the marks.
import { createEffect, createMemo, createSignal } from 'solid-js';
import type { Kind } from '../../core/log/events';
import { afterCalls, type Block } from '../../core/log/fold';
import { proposalRow } from './compaction';
import type { Kernel } from './kernel';
import type { Live, Streaming } from './types';

// The Kind Filters, in glossary order: the Kinds each shows; a Tool Call never without its Tool Result.
// Additive: each is on or off on its own; the blocks shown are those of the ones on.
export type Filter = { name: string; kinds: readonly Kind[] };
export const FILTERS: readonly Filter[] = [
  { name: 'system', kinds: ['System', 'Tools'] },
  { name: 'user', kinds: ['User'] },
  { name: 'thinking', kinds: ['Thinking'] },
  { name: 'assistant', kinds: ['Assistant'] },
  { name: 'tool-calls', kinds: ['Tool Call', 'Tool Result'] },
  { name: 'note', kinds: ['Note'] },
];

export type Selection = ReturnType<typeof createSelection>;

export function createSelection(k: Kernel, hiddenAtStart: readonly string[]) {
  const { context, sent, nextId, streaming, running, compacting } = k;
  const [selected, setSelected] = createSignal(1);
  // Marked blocks (Space) for Compaction; UI state, not logged.
  const [marked, setMarked] = createSignal<ReadonlySet<number>>(new Set());
  // Kind Filters switched off: what the block table hides; UI state, not logged. Tool Calls are off at first.
  const [hidden, setHidden] = createSignal<readonly Filter[]>(FILTERS.filter(f => hiddenAtStart.includes(f.name)));
  const hides = (kind: Kind) => hidden().some(f => f.kinds.includes(kind));

  // The streaming answer (its reasoning first) sits at the end; a running call's result where it will be added.
  const live = createMemo((): Live[] => {
    const c = compacting();
    if (c && c.phase !== 'instruction') return [proposalRow(k, c)];
    const s = streaming();
    if (s) return streamingRows(s);
    const r = running();
    const blocks = context().blocks;
    return r ? [{ id: nextId(), kind: 'Tool Result', content: r.output, before: blocks[afterCalls(blocks, r.call.id)]?.id ?? null }] : [];
  });
  // The ids the answer's blocks get: a Thinking block first.
  function streamingRows({ thinking, text }: Streaming): Live[] {
    const reasoning: Live[] = thinking ? [{ id: nextId(), kind: 'Thinking', content: thinking, before: null }] : [];
    const answer: Live[] = text || !thinking ? [{ id: nextId() + reasoning.length, kind: 'Assistant', content: text, before: null }] : [];
    return [...reasoning, ...answer];
  }
  // Selectable rows in order: sent blocks and the live rows.
  const rows = createMemo(() => {
    const ids = sent().map(b => b.id);
    for (const l of live()) {
      const at = l.before === null ? -1 : ids.indexOf(l.before);
      ids.splice(at < 0 ? ids.length : at, 0, l.id);
    }
    return ids;
  });
  // Whether the Kind Filters let a row through. Always passing: a Compaction's proposal, and Tool Calls awaiting
  // approval or running with their output, since they are decided or stopped at their row.
  const proposing = () => compacting()?.phase === 'running' || compacting()?.phase === 'review';
  const unfiltered = createMemo(() => new Set([
    ...(proposing() && live()[0] ? [live()[0]!.id] : []),
    ...sent().filter(b => b.pending && !b.removed).map(b => b.id),
    ...(running() ? [running()!.call.id, ...live().map(l => l.id)] : []),
  ]));
  const passes = (id: number, kind: Kind) => !hides(kind) || unfiltered().has(id);
  // The rows shown, in order.
  const shown = createMemo(() => {
    const kinds = new Map<number, Kind>([...sent(), ...live()].map(b => [b.id, b.kind]));
    return rows().filter(id => passes(id, kinds.get(id)!));
  });
  // Only a shown block is selected: a hidden one gives way to the next shown row, else the previous.
  createEffect(() => {
    const ids = shown();
    const at = rows().indexOf(selected());
    // Not a row yet (the next block, selected ahead of it): nothing to give way to.
    if (!ids.length || ids.includes(selected()) || at < 0) return;
    setSelected(ids.find(id => rows().indexOf(id) > at) ?? ids.at(-1)!);
  });
  const selectedBlock = (): Block | undefined => (shown().includes(selected()) ? sent().find(b => b.id === selected()) : undefined);
  const selectAt = (i: number) => {
    if (shown().length) setSelected(shown()[Math.max(0, Math.min(shown().length - 1, i))]!);
  };
  const keepSelection = () => shown().includes(selected()) || selectAt(shown().length - 1);
  // Whether the user moved up to read an older row: the tool loop then leaves the selection alone. Moving back to
  // the last row, writing, sending or deciding a call follows the loop again.
  let reading = false;
  const follow = (id: number) => void (reading || setSelected(id));
  function select(delta: number) {
    selectAt(shown().indexOf(selected()) + delta);
    reading = selected() !== shown().at(-1);
  }
  // Not while a Kind Filter hides neighbours the block would move past.
  const hiding = () => shown().length < rows().length;

  return {
    live, rows, shown, passes, hides, hiding,
    selected, setSelected, selectedBlock, select, selectAt, keepSelection, follow,
    // The selection follows the loop again.
    release: () => void (reading = false),
    marked, setMarked, hidden, setHidden,
  };
}

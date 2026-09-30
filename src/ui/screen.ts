// The main screen's state: the Review Gate driving the view's selection, marks and Kind Filters.
import { createGate, type GateOptions } from '../gate';
import { createSelection, type Selection } from './selection';

export type ScreenOptions = GateOptions & {
  // The Kind Filters off at start.
  hidden?: readonly string[];
};

export function createScreen({ hidden = ['tool-calls'], ...options }: ScreenOptions) {
  let sel!: Selection;
  const gate = createGate(options, k => (sel = createSelection(k, hidden)));
  const { sent, split } = gate;
  return {
    ...gate,
    live: sel.live,
    rows: sel.rows,
    selected: sel.selected,
    selectedBlock: sel.selectedBlock,
    marked: sel.marked,
    hidden: sel.hidden,
    hiding: sel.hiding,
    passes: sel.passes,
    // The Kind Filters' share of the Context: the sent blocks shown, their tokens (null while counting).
    filterShare: () => {
      const indexes = sent().flatMap((b, i) => (sel.hides(b.kind) ? [] : [i]));
      const s = split();
      return { blocks: indexes.length, all: sent().length, tokens: s && indexes.reduce((sum, i) => sum + s.blocks[i]!, 0), total: s && s.total };
    },
    // Enter: the user sends, the selection follows the answer.
    send: () => {
      sel.release();
      return gate.send();
    },
    select: sel.select,
    clearMarks: () => sel.setMarked(new Set<number>()),
  };
}

export type Screen = ReturnType<typeof createScreen>;

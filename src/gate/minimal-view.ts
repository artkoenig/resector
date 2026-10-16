// The View without a screen: its rows are the blocks sent next, nothing is hidden, the selection follows the Gate.
// For runs without the TUI and for the Gate's tests.
import { createSignal } from 'solid-js';
import type { Kernel } from './kernel';
import type { View } from './types';

// onFollow: each block the Gate moves the selection to.
export function minimalView(k: Kernel, onFollow: (id: number) => void = () => {}): View {
  const [selected, setSelected] = createSignal(1);
  const [marked, setMarked] = createSignal<ReadonlySet<number>>(new Set());
  const rows = () => k.sent().map(b => b.id);
  return {
    rows, shown: rows, hiding: () => false, selected, setSelected, marked, setMarked,
    selectedBlock: () => k.sent().find(b => b.id === selected()),
    selectAt: i => setSelected(rows()[i] ?? selected()),
    keepSelection: () => {},
    follow: id => void (onFollow(id), setSelected(id)),
    release: () => {},
    filterBy: () => {},
  };
}

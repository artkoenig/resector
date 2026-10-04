// Key maps of the main screen: the Context, the input line, the Compaction's instruction and review.
import type { Screen } from './screen';
import type { Mode } from './prompt';

export const modifierOf = (key: { option?: boolean; meta: boolean; shift: boolean }) =>
  key.option || key.meta ? 'alt+' : key.shift ? 'shift+' : '';

export type Ui = {
  draft: () => string;
  editDraft: (text: string) => void;
  setMode: (mode: Mode) => void;
  leaveInput: () => void;
  // `/` and `@` in the Context start a command or a file reference in the input line.
  startInput: (text: string) => () => void;
  scrollPreview: (lines: number) => void;
  previewPage: () => number;
  onQuit: () => void;
};

// A key in the Context and its footer hint. `single`: acts on the selected block only, off while blocks are marked;
// `busy`: also while streaming or running; `marked`: its hint while blocks are marked; `when`: its hint shows only then.
export type Binding = {
  key: string;
  run: (gate: Screen, ui: Ui) => void;
  label?: string;
  hint?: string;
  marked?: string;
  single?: true;
  busy?: true;
  when?: (gate: Screen) => boolean;
};
const pending = (gate: Screen) => !!gate.selectedBlock()?.pending;
// The order is the footer's.
export const CONTEXT_KEYS: Binding[] = [
  { key: 'tab', run: (_, ui) => ui.setMode('input') },
  { key: '/', run: (_, ui) => ui.startInput('/')() },
  { key: '@', run: (_, ui) => ui.startInput('@')() },
  { key: 'shift+@', run: (_, ui) => ui.startInput('@')() },
  { key: 'return', run: gate => void gate.send() },
  { key: 'up', run: gate => gate.select(-1), busy: true },
  { key: 'down', run: gate => gate.select(1), busy: true },
  { key: 'y', run: gate => gate.approve(), hint: 'run once', single: true, when: pending },
  { key: 'a', run: gate => gate.allowForSession(), hint: 'allow for session', single: true, when: pending },
  { key: 'n', run: gate => gate.reject(), hint: 'reject', single: true, when: pending },
  // No move while a Kind Filter hides blocks.
  { key: 'alt+up', run: gate => gate.move(-1), label: '⌥↑↓', hint: 'move', single: true, when: gate => !gate.hiding() },
  { key: 'alt+down', run: gate => gate.move(1), single: true },
  { key: 'shift+up', run: (_, ui) => ui.scrollPreview(-1), busy: true },
  { key: 'shift+down', run: (_, ui) => ui.scrollPreview(1), busy: true },
  { key: 'pageup', run: (_, ui) => ui.scrollPreview(-ui.previewPage()), busy: true },
  { key: 'pagedown', run: (_, ui) => ui.scrollPreview(ui.previewPage()), busy: true },
  { key: 'e', run: gate => gate.edit(), hint: 'edit', single: true },
  { key: 'd', run: gate => gate.remove(), hint: 'remove', marked: 'remove' },
  { key: 'space', run: gate => gate.toggleMark(), hint: 'mark', marked: 'mark' },
  { key: 'c', run: gate => gate.startCompaction(), hint: 'compact', marked: 'compact' },
  { key: 'u', run: gate => gate.undo(), hint: 'undo' },
  { key: 'escape', run: gate => (gate.status()?.tone === 'error' ? gate.dismiss() : gate.clearMarks()), label: 'esc', marked: 'unmark' },
  { key: 'q', run: (_, ui) => ui.onQuit(), hint: 'quit', marked: 'quit', busy: true },
];
const BY_KEY = new Map(CONTEXT_KEYS.map(b => [b.key, b]));

export function createKeys(gate: Screen, ui: Ui) {
  const { scrollPreview, previewPage } = ui;
  const submit = () => {
    gate.submit(ui.draft());
    ui.leaveInput();
  };
  const input: Record<string, () => void> = { return: submit, tab: ui.leaveInput, escape: ui.leaveInput };
  const instruction: Record<string, () => void> = {
    return: () => gate.runCompaction(ui.draft()),
    tab: () => ui.draft() || ui.editDraft(gate.defaultInstruction()),
    escape: () => {
      gate.leaveInstruction();
      ui.editDraft('');
    },
  };
  const review: Record<string, () => void> = {
    return: gate.acceptCompaction,
    x: gate.discardCompaction,
    escape: gate.discardCompaction,
    i: gate.refine,
    e: gate.editProposal,
    'shift+up': () => scrollPreview(-1),
    'shift+down': () => scrollPreview(1),
    pageup: () => scrollPreview(-previewPage()),
    pagedown: () => scrollPreview(previewPage()),
    q: ui.onQuit,
  };
  // The key pressed last in the Context: only the same key again confirms.
  let lastKey = '';
  // A key in the Context. Streaming or running: only looking around (select, scroll, quit); Esc stops after the step, again aborts.
  function contextAction(name: string) {
    if (name !== lastKey) gate.cancelConfirm();
    lastKey = name;
    const binding = BY_KEY.get(name);
    if (gate.marked().size && binding?.single) return undefined;
    if (gate.busy() && name === 'escape') return gate.abort;
    if (!binding || (gate.busy() && !binding.busy)) return undefined;
    return () => binding.run(gate, ui);
  }
  return {
    input,
    instruction,
    // A Compaction under review locks the Gate.
    gateAction: (name: string) => (gate.compacting()?.phase === 'review' ? review[name] : contextAction(name)),
  };
}

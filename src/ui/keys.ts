// Key maps of the main screen: the Context, the input line, the Compaction's instruction and review.
import type { Screen } from './screen';
import type { Mode } from './prompt';

// Keys acting on the selected block only: off while blocks are marked.
const SINGLE_KEYS = new Set(['alt+up', 'alt+down', 'y', 'a', 'n', 'p', 'e']);
const BUSY_KEYS = new Set(['up', 'down', 'shift+up', 'shift+down', 'pageup', 'pagedown', 'q']);

export const modifierOf = (key: { option?: boolean; meta: boolean; shift: boolean }) =>
  key.option || key.meta ? 'alt+' : key.shift ? 'shift+' : '';

type Ui = {
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
  const context: Record<string, () => void> = {
    tab: () => ui.setMode('input'),
    '/': ui.startInput('/'),
    '@': ui.startInput('@'),
    'shift+@': ui.startInput('@'),
    return: () => void gate.send(),
    up: () => gate.select(-1),
    down: () => gate.select(1),
    'alt+up': () => gate.move(-1),
    'alt+down': () => gate.move(1),
    'shift+up': () => scrollPreview(-1),
    'shift+down': () => scrollPreview(1),
    pageup: () => scrollPreview(-previewPage()),
    pagedown: () => scrollPreview(previewPage()),
    y: gate.approve,
    a: gate.allowForSession,
    n: gate.reject,
    d: gate.remove,
    u: gate.undo,
    e: gate.edit,
    space: gate.toggleMark,
    c: gate.startCompaction,
    escape: () => (gate.status()?.tone === 'error' ? gate.dismiss() : gate.clearMarks()),
    q: ui.onQuit,
  };
  // The key pressed last in the Context: only the same key again confirms.
  let lastKey = '';
  // A key in the Context. Streaming or running: only looking around (select, scroll, quit); Esc stops after the step, again aborts.
  function contextAction(name: string) {
    if (name !== lastKey) gate.cancelConfirm();
    lastKey = name;
    if (gate.marked().size && SINGLE_KEYS.has(name)) return undefined;
    if (!gate.busy()) return context[name];
    return name === 'escape' ? gate.abort : BUSY_KEYS.has(name) ? context[name] : undefined;
  }
  return {
    input,
    instruction,
    // A Compaction under review locks the Gate.
    gateAction: (name: string) => (gate.compacting()?.phase === 'review' ? review[name] : contextAction(name)),
  };
}

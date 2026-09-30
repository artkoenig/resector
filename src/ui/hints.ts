// Key hints in the footer: the keys of the current mode, the busy step, the marks or the selected block.
import type { Compaction, Gate } from './gate';
import * as dock from './dock';
import type { DockState } from './dock';
import type { Hint } from './parts';
import type { Mode } from './prompt';

const LOOK_KEYS: Hint[] = [['q', 'quit']];
// With marks only what acts on all marked blocks.
const MARKED_KEYS: Hint[] = [['d', 'remove'], ['c', 'compact'], ['space', 'mark'], ['esc', 'unmark'], ['q', 'quit']];
const MOVE: Hint = ['⌥↑↓', 'move'];
const KEYS: Hint[] = [MOVE, ['e', 'edit'], ['d', 'remove'], ['space', 'mark'], ['c', 'compact'], ['u', 'undo'], ['q', 'quit']];

// Key hints right of the status; they stay visible. An error band adds how to dismiss it.
export type KeyMode = Mode | 'suggest' | 'complete' | 'question' | 'questions' | 'answer' | Compaction['phase'];
// The dock's keys: tabs only with several questions or a `multiple` one.
export const dockMode = (s: DockState, typingOwn: boolean): KeyMode => (typingOwn ? 'answer' : dock.direct(s) ? 'question' : 'questions');
export function keysOf(gate: Gate, mode: KeyMode, error: boolean): Hint[] {
  const keys = modeKeys(gate, mode);
  return error && mode === 'context' ? [...keys.slice(0, -1), ['esc', 'dismiss'], keys.at(-1)!] : keys;
}
// Modes with their own keys; streaming or running starts only from the Context.
const MODE_KEYS: Partial<Record<KeyMode, Hint[]>> = {
  running: [['esc', 'abort'], ...LOOK_KEYS],
  review: [['enter', 'accept'], ['x', 'discard'], ['i', 'instruction'], ['e', 'edit'], ...LOOK_KEYS],
  instruction: [['enter', 'compact'], ['tab', 'default'], ['esc', 'back']],
  suggest: [['↑↓', 'choose'], ['tab', 'complete'], ['enter', 'run'], ['esc', 'back']],
  complete: [['↑↓', 'choose'], ['tab/enter', 'complete'], ['esc', 'back']],
  input: [['enter', 'send'], ['tab/esc', 'back']],
  question: [['↑↓', 'choose'], ['enter', 'pick'], ['esc', 'decline'], ['q', 'quit']],
  questions: [['↑↓', 'choose'], ['enter', 'pick'], ['←→', 'question'], ['r', 'recommended'], ['esc', 'decline'], ['q', 'quit']],
  answer: [['enter', 'answer'], ['esc', 'back']],
};
// Streaming or running: the first Esc stops the loop after the step, the second aborts it.
function busyKeys(gate: Gate): Hint[] | null {
  const step = gate.running() ? 'kill' : gate.streaming() ? 'abort' : null;
  return step && [['esc', gate.stopping() ? step : 'stop after'], ...LOOK_KEYS];
}
function modeKeys(gate: Gate, mode: KeyMode): Hint[] {
  const own = MODE_KEYS[mode] ?? busyKeys(gate);
  if (own) return own;
  if (gate.marked().size) return MARKED_KEYS;
  // No move while a Kind Filter hides blocks.
  const keys = gate.hiding() ? KEYS.filter(k => k !== MOVE) : KEYS;
  return gate.selectedBlock()?.pending ? [['y', 'run once'], ['a', 'allow for session'], ['n', 'reject'], ...keys] : keys;
}

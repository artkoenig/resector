// Key hints in the footer: the keys of the current mode, the busy step, the marks or the selected block.
import type { Compaction } from '../gate';
import { CONTEXT_KEYS } from './keys';
import type { Screen } from './screen';
import * as dock from './dock';
import type { DockState } from './dock';
import type { Hint } from './parts';
import type { Mode } from './prompt';

const LOOK_KEYS: Hint[] = [['q', 'quit']];

// Key hints right of the status; they stay visible. An error band adds how to dismiss it.
export type KeyMode = Mode | 'suggest' | 'complete' | 'question' | 'questions' | 'answer' | Compaction['phase'];
// The dock's keys: tabs only with several questions or a `multiple` one.
export const dockMode = (s: DockState, typingOwn: boolean): KeyMode => (typingOwn ? 'answer' : dock.direct(s) ? 'question' : 'questions');
export function keysOf(gate: Screen, mode: KeyMode, error: boolean): Hint[] {
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
// Streaming, running or a policy running: the first Esc stops the loop after the step, the second aborts it.
function busyKeys(gate: Screen): Hint[] | null {
  const step = gate.running() ? 'kill' : gate.streaming() || gate.policing() ? 'abort' : null;
  return step && [['esc', gate.stopping() ? step : 'stop after'], ...LOOK_KEYS];
}
function modeKeys(gate: Screen, mode: KeyMode): Hint[] {
  const own = MODE_KEYS[mode] ?? busyKeys(gate);
  if (own) return own;
  // With marks only what acts on all marked blocks.
  const marked = gate.marked().size > 0;
  return CONTEXT_KEYS.flatMap(b => {
    const text = marked ? b.marked : b.when?.(gate) === false ? undefined : b.hint;
    return text ? [[b.label ?? b.key, text] as const] : [];
  });
}

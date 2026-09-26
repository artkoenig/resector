// The Question dock's state (#33, #34): one tab per question plus a Confirm tab; a lone single-choice Question has no
// tabs and is sent on the first pick. Pure: every step returns a new state.
import { orderedOptions, type Answer, type Question } from '../core/toolcall/question';

// picks: the chosen labels per question; own: the own answer per question ('' none); row: the cursor in the current tab.
export type DockState = { questions: Question[]; tab: number; row: number; picks: string[][]; own: string[] };

// A `multiple` question starts with its Recommended Options toggled on.
export const openDock = (questions: Question[]): DockState => ({
  questions,
  tab: 0,
  row: 0,
  picks: questions.map(q => (q.multiple ? [q.recommended].flat() : [])),
  own: questions.map(() => ''),
});

// A lone single-choice Question: no tabs, no Confirm; the first pick is the answer.
export const direct = (s: DockState) => s.questions.length === 1 && !s.questions[0]!.multiple;
export const confirming = (s: DockState) => s.tab === s.questions.length;
export const current = (s: DockState): Question | undefined => s.questions[s.tab];
// Rows of a question tab: its options, the Recommended ones first, then the own answer.
export const choices = (s: DockState) => orderedOptions(current(s)!);

// The answers in the model's option order, the own answer last; none: Unanswered.
export const answers = (s: DockState): Answer[] =>
  s.questions.map((q, i) => [...q.options.map(o => o.label).filter(l => s.picks[i]!.includes(l)), ...(s.own[i] ? [s.own[i]!] : [])]);
export const answered = (s: DockState, i: number) => answers(s)[i]!.length > 0;

const tabs = (s: DockState) => s.questions.length + 1;
export const switchTab = (s: DockState, delta: number): DockState => (direct(s) ? s : { ...s, tab: (s.tab + delta + tabs(s)) % tabs(s), row: 0 });
export const moveRow = (s: DockState, delta: number): DockState => {
  const rows = confirming(s) ? 1 : choices(s).length + 1;
  return { ...s, row: (s.row + delta + rows) % rows };
};

const replaced = <T>(list: T[], i: number, value: T) => list.map((v, j) => (j === i ? value : v));
// Picks option `i` of the current tab: a single-choice question takes it and moves on, a `multiple` one toggles it.
export function pick(s: DockState, i: number): DockState {
  const label = choices(s)[i]!.label;
  if (!current(s)!.multiple) return next({ ...s, picks: replaced(s.picks, s.tab, [label]), own: replaced(s.own, s.tab, '') });
  const picks = s.picks[s.tab]!;
  return { ...s, picks: replaced(s.picks, s.tab, picks.includes(label) ? picks.filter(l => l !== label) : [...picks, label]) };
}
// The own answer of the current tab: it replaces a single-choice pick and moves on; `multiple` keeps the toggles.
export function writeOwn(s: DockState, text: string): DockState {
  const own = { ...s, own: replaced(s.own, s.tab, text) };
  return current(s)!.multiple ? own : next({ ...own, picks: replaced(s.picks, s.tab, []) });
}
const next = (s: DockState): DockState => (direct(s) ? s : { ...s, tab: s.tab + 1, row: 0 });

// Every still unanswered question gets its Recommended Option(s); then Confirm.
export const recommend = (s: DockState): DockState => ({
  ...s,
  picks: s.questions.map((q, i) => (answered(s, i) ? s.picks[i]! : [q.recommended].flat())),
  tab: direct(s) ? 0 : s.questions.length,
  row: 0,
});

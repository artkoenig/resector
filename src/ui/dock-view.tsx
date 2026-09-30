// Question dock (#33, #34): its state and keys while the model's Question is next, and its rendering.
import { createEffect, createSignal, For, type JSX, on, Show } from 'solid-js';
import { isRecommended, shownAnswer } from '../core/tools/question';
import * as dock from './dock';
import type { DockState } from './dock';
import type { Screen } from './screen';
import { cell } from './format';
import { ACCENT, KIND_COLOR, MUTED, SELECTED_BG, TEXT, TONE } from './theme';

type Ui = {
  draft: () => string;
  editDraft: (text: string) => void;
  leaveInput: () => void;
  // A Compaction under way keeps the keys.
  compacting: () => boolean;
  scrollPreview: (lines: number) => void;
  onQuit: () => void;
};

// Replaces the prompt band while the model's Question is next; the own answer is typed while `typingOwn`.
export function createDockControl(gate: Screen, ui: Ui) {
  const [state, setDock] = createSignal<DockState | null>(null);
  const [typingOwn, setTypingOwn] = createSignal(false);
  createEffect(
    on(
      () => gate.asked()?.call.id,
      id => {
        setDock(id === undefined ? null : dock.openDock(gate.asked()!.questions));
        setTypingOwn(false);
        if (id !== undefined) ui.leaveInput();
      },
    ),
  );
  // A step in the dock; a lone single-choice Question is sent with its first answer.
  function step(next: DockState, send = dock.direct(next)) {
    if (send) return gate.answer(dock.answers(next));
    setDock(next);
  }
  function pickRow(i: number) {
    const s = state()!;
    if (i === dock.choices(s).length) {
      ui.editDraft(s.own[s.tab]!);
      return setTypingOwn(true);
    }
    if (i < dock.choices(s).length) step(dock.pick(s, i), dock.direct(s));
  }
  const keys: Record<string, () => void> = {
    up: () => setDock(dock.moveRow(state()!, -1)),
    down: () => setDock(dock.moveRow(state()!, 1)),
    right: () => setDock(dock.switchTab(state()!, 1)),
    left: () => setDock(dock.switchTab(state()!, -1)),
    return: () => (dock.confirming(state()!) ? step(state()!, true) : pickRow(state()!.row)),
    r: () => step(dock.recommend(state()!)),
    'shift+up': () => ui.scrollPreview(-1),
    'shift+down': () => ui.scrollPreview(1),
    escape: gate.decline,
    q: ui.onQuit,
  };
  function closeOwn() {
    setTypingOwn(false);
    ui.editDraft('');
  }
  const ownKeys: Record<string, () => void> = {
    return: () => {
      const s = state()!;
      const text = ui.draft().trim();
      if (!text && !s.questions[s.tab]!.multiple) return;
      closeOwn();
      step(dock.writeOwn(s, text), dock.direct(s));
    },
    escape: closeOwn,
  };
  return {
    state,
    typingOwn,
    open: () => !!state() && !ui.compacting(),
    keyOf: (key: string, name: string) => (typingOwn() ? ownKeys[key] : keys[name]),
    // Lines of the dock's band, which takes the prompt band's place: the dock, then a meta line.
    lines: () => dockHeight(state()!) + 1,
  };
}

// The model's Question: with several questions or a `multiple` one a tab bar first, then the current
// question with its options, the Recommended ones first and marked, then the own answer; or on Confirm the answers.
// `own`: the input while the own answer is typed; it takes the own answer's row.
export function Dock(props: { state: DockState; width: number; own?: JSX.Element }) {
  return (
    <>
      <Show when={!dock.direct(props.state)} fallback={<QuestionTab state={props.state} width={props.width} own={props.own} title />}>
        <TabBar state={props.state} />
        <Show when={!dock.confirming(props.state)} fallback={<ConfirmTab state={props.state} />}>
          <QuestionTab state={props.state} width={props.width} own={props.own} />
        </Show>
      </Show>
      <text flexShrink={0}>
        <span style={{ fg: KIND_COLOR['Tool Result'] }}>Tool Result</span>
        <span style={{ fg: MUTED }}>  the answer, written by you</span>
      </text>
    </>
  );
}
// Dock lines without the meta line: the tab bar, then the question line, its options and the own answer, or on Confirm the answers and a hint.
function dockHeight(s: DockState): number {
  if (dock.direct(s)) return dock.choices(s).length + 2;
  return 1 + (dock.confirming(s) ? s.questions.length + 1 : dock.choices(s).length + 2);
}
function TabBar(props: { state: DockState }) {
  const tab = (i: number, label: string) => (
    <span style={{ fg: i === props.state.tab ? ACCENT : MUTED, bg: i === props.state.tab ? SELECTED_BG : undefined }}>{` ${label} `}</span>
  );
  return (
    <text flexShrink={0}>
      <span> </span>
      <For each={props.state.questions}>{(q, i) => tab(i(), `${dock.answered(props.state, i()) ? '✓' : '·'} ${q.header}`)}</For>
      {tab(props.state.questions.length, 'Confirm')}
    </text>
  );
}
function QuestionTab(props: { state: DockState; width: number; own?: JSX.Element; title?: boolean }) {
  const q = () => dock.current(props.state)!;
  const options = () => dock.choices(props.state);
  const row = () => props.state.row;
  const picks = () => props.state.picks[props.state.tab]!;
  const own = () => props.state.own[props.state.tab]!;
  const labelWidth = () => Math.max(...options().map(o => o.label.length));
  const box = (on: boolean) => (q().multiple ? (on ? '[✓] ' : '[ ] ') : '');
  const marker = (i: number) => `  ${i === row() ? '›' : ' '} `;
  const title = () => (props.title ? `${q().header} · ` : '');
  return (
    <>
      <text flexShrink={0}>
        <span style={{ fg: ACCENT }}>{`  ${title()}`}</span>
        <span style={{ fg: TEXT }}>{cell(q().question, Math.max(8, props.width - title().length - 3)).trimEnd()}</span>
      </text>
      <For each={options()}>
        {(o, i) => (
          <text flexShrink={0} bg={i() === row() ? SELECTED_BG : undefined}>
            <span style={{ fg: i() === row() ? ACCENT : TEXT }}>{`${marker(i())}${box(picks().includes(o.label))}${o.label.padEnd(labelWidth())} `}</span>
            <span style={{ fg: TONE.ok }}>{isRecommended(q(), o) ? 'recommended ' : ''}</span>
            <span style={{ fg: MUTED }}>{o.description}</span>
          </text>
        )}
      </For>
      <Show
        when={props.own}
        fallback={
          <text flexShrink={0} bg={row() === options().length ? SELECTED_BG : undefined} fg={row() === options().length ? ACCENT : MUTED}>
            {`${marker(options().length)}${box(!!own())}own answer${own() ? `: ${own()}` : ''}`}
          </text>
        }
      >
        <box flexDirection="row" flexShrink={0}>
          <text fg={ACCENT} flexShrink={0}>{`${marker(options().length)}answer > `}</text>
          {props.own}
        </box>
      </Show>
    </>
  );
}
function ConfirmTab(props: { state: DockState }) {
  const width = () => Math.max(...props.state.questions.map(q => q.header.length));
  return (
    <>
      <For each={dock.answers(props.state)}>
        {(a, i) => (
          <text flexShrink={0}>
            <span style={{ fg: TEXT }}>{`  ${props.state.questions[i()]!.header.padEnd(width())}  `}</span>
            <span style={{ fg: a.length ? TEXT : MUTED }}>{shownAnswer(a)}</span>
          </text>
        )}
      </For>
      <text flexShrink={0} fg={MUTED}>
        {'  enter sends the answers · r fills the unanswered with the recommendation'}
      </text>
    </>
  );
}

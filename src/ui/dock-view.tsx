// Question dock (#33, #34): its state and keys while the model's Question is next, and its rendering.
import { createEffect, createSignal, For, type JSX, on, Show } from 'solid-js';
import { isRecommended, shownAnswer } from '../core/tools/question';
import * as dock from './dock';
import type { DockState } from './dock';
import type { Screen } from './screen';
import { wrapped } from './format';
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
    // The dock laid out for the band that takes the prompt band's place: `width` inside the band, `max` lines with
    // the meta line.
    layout: (width: number, max: number) => layoutDock(state()!, width, Math.max(1, max - 1)),
  };
}

// A piece of a dock line in one colour.
type Seg = { text: string; fg: string };
// A dock line; `row`: the dock row it belongs to (an option, the own answer), so the selection keeps it in view.
type Line = { segs: Seg[]; row?: number; selected?: boolean };
// The dock laid out: its lines (the own answer's line marked, it takes the input while typed), and the rows hidden
// above and below when it does not fit.
export type DockLayout = { lines: (Line & { own?: boolean })[]; above: number; below: number };

// The dock's lines at `width` (the band's ┃ excluded): a tab bar with several questions or a `multiple` one, then
// the question, wrapped, its options, the Recommended ones first and marked, descriptions wrapped under themselves,
// then the own answer; or on Confirm the answers. At most `max` lines: the tab bar and the question stay, the rows
// below show a window around the cursor.
export function layoutDock(s: DockState, width: number, max: number): DockLayout {
  const head: Line[] = [];
  const rows: Line[][] = [];
  if (!dock.direct(s)) head.push(tabBar(s, width));
  if (dock.confirming(s)) {
    const w = Math.max(...s.questions.map(q => q.header.length));
    dock.answers(s).forEach((a, i) =>
      head.push({ segs: [{ text: cut(`  ${s.questions[i]!.header.padEnd(w)}  `, width), fg: TEXT }, { text: cut(shownAnswer(a), Math.max(0, width - w - 4)), fg: a.length ? TEXT : MUTED }] }),
    );
    for (const text of wrapped('enter sends the answers · r fills the unanswered with the recommendation', width - 2)) head.push({ segs: [{ text: `  ${text}`, fg: MUTED }] });
  } else {
    head.push(...questionLines(s, width));
    rows.push(...optionRows(s, width), [ownLine(s, width)]);
  }
  return fit(head, rows, s.row, max);
}

// The head stays (cut to leave a row); rows from the cursor's back as far as they fit, then on below it.
function fit(head: Line[], rows: Line[][], at: number, max: number): DockLayout {
  const shownHead = head.length > max - 1 && rows.length ? head.slice(0, Math.max(0, max - 1)) : head.slice(0, max);
  const room = max - shownHead.length;
  const total = rows.reduce((n, r) => n + r.length, 0);
  if (total <= room) return { lines: [...shownHead, ...rows.flat()], above: 0, below: 0 };
  let from = Math.min(at, rows.length - 1);
  let to = from + 1;
  let used = rows[from]!.length;
  while (from > 0 && used + rows[from - 1]!.length <= room) used += rows[--from]!.length;
  while (to < rows.length && used + rows[to]!.length <= room) used += rows[to++]!.length;
  return { lines: [...shownHead, ...rows.slice(from, to).flat().slice(0, Math.max(0, room))], above: from, below: rows.length - to };
}

const cut = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text);

// The tabs, as many around the current one as fit.
function tabBar(s: DockState, width: number): Line {
  const labels = [...s.questions.map((q, i) => ` ${dock.answered(s, i) ? '✓' : '·'} ${q.header} `), ' Confirm '];
  let from = s.tab;
  let to = s.tab + 1;
  const size = () => 1 + labels.slice(from, to).join('').length + (from > 0 ? 1 : 0) + (to < labels.length ? 1 : 0);
  for (let grew = true; grew; ) {
    grew = false;
    if (to < labels.length && (to++, size() <= width)) grew = true;
    else if (to > s.tab + 1 && size() > width) to--;
    if (from > 0 && (from--, size() <= width)) grew = true;
    else if (from < s.tab && size() > width) from++;
  }
  const segs: Seg[] = [{ text: from > 0 ? ' …' : ' ', fg: MUTED }];
  labels.slice(from, to).forEach((label, j) => segs.push({ text: label, fg: from + j === s.tab ? ACCENT : MUTED, selected: from + j === s.tab } as Seg));
  if (to < labels.length) segs.push({ text: '…', fg: MUTED });
  return { segs };
}

function questionLines(s: DockState, width: number): Line[] {
  const q = dock.current(s)!;
  const title = dock.direct(s) ? `${q.header} · ` : '';
  const lines = wrapped(q.question, Math.max(1, width - 2 - title.length), Math.max(1, width - 4));
  return lines.map((text, i) => ({ segs: i === 0 ? [{ text: `  ${title}`, fg: ACCENT }, { text, fg: TEXT }] : [{ text: `    ${text}`, fg: TEXT }] }));
}

const marker = (s: DockState, i: number) => `  ${i === s.row ? '›' : ' '} `;
const box = (s: DockState, on: boolean) => (dock.current(s)!.multiple ? (on ? '[✓] ' : '[ ] ') : '');

// One row per option: marker, box and label, then `recommended` and the description, wrapped under the description.
function optionRows(s: DockState, width: number): Line[][] {
  const q = dock.current(s)!;
  const options = dock.choices(s);
  const labelWidth = Math.max(...options.map(o => o.label.length));
  return options.map((o, i) => {
    const selected = i === s.row;
    const prefix = cut(`${marker(s, i)}${box(s, s.picks[s.tab]!.includes(o.label))}${o.label.padEnd(labelWidth)} `, Math.max(4, width - 12));
    const tag = isRecommended(q, o) ? 'recommended ' : '';
    const text = wrapped(`${tag}${o.description}`, Math.max(1, width - prefix.length));
    const indent = ' '.repeat(prefix.length);
    return (text.length ? text : ['']).map((t, j): Line => {
      const own = t.startsWith(tag) && j === 0 && tag ? [{ text: tag, fg: TONE.ok }, { text: t.slice(tag.length), fg: MUTED }] : [{ text: t, fg: MUTED }];
      return { row: i, selected, segs: [{ text: j === 0 ? prefix : indent, fg: selected ? ACCENT : TEXT }, ...own] };
    });
  });
}

function ownLine(s: DockState, width: number): Line & { own: true } {
  const i = dock.choices(s).length;
  const own = s.own[s.tab]!;
  return { own: true, row: i, selected: i === s.row, segs: [{ text: cut(`${marker(s, i)}${box(s, !!own)}own answer${own ? `: ${own}` : ''}`, width), fg: i === s.row ? ACCENT : MUTED }] };
}

// Renders the laid-out dock; `own`: the input while the own answer is typed, it takes the own answer's line.
export function Dock(props: { layout: DockLayout; own?: JSX.Element }) {
  const more = () => [props.layout.above && `↑ ${props.layout.above} more`, props.layout.below && `↓ ${props.layout.below} more`].filter(Boolean).join(' · ');
  return (
    <>
      <For each={props.layout.lines}>
        {line => (
          <Show
            when={line.own && props.own}
            fallback={
              <text flexShrink={0} bg={line.selected ? SELECTED_BG : undefined}>
                <For each={line.segs}>{seg => <span style={{ fg: seg.fg, bg: (seg as Seg & { selected?: boolean }).selected ? SELECTED_BG : undefined }}>{seg.text}</span>}</For>
              </text>
            }
          >
            <box flexDirection="row" flexShrink={0}>
              <text fg={ACCENT} flexShrink={0}>{`  › answer > `}</text>
              {props.own}
            </box>
          </Show>
        )}
      </For>
      <text flexShrink={0}>
        <span style={{ fg: KIND_COLOR['Tool Result'] }}>Tool Result</span>
        <span style={{ fg: MUTED }}>  the answer, written by you</span>
        <span style={{ fg: ACCENT }}>{more() ? `  ${more()}` : ''}</span>
      </text>
    </>
  );
}

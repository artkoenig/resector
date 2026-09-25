// Building blocks shared by the screens: header band, prompt band and footer (status left, key hints right).
import { For, type JSX, Show } from 'solid-js';
import { linesOf } from './format';
import type { Status } from './gate';
import { ACCENT, MUTED, PANEL_BG, TEXT, TONE } from './theme';

// Key hints: `key action` pairs, the key in text colour, the action muted.
export type Hint = readonly [key: string, action: string];
const HINT_GAP = '  ';
export const hintsText = (hints: readonly Hint[]) => hints.map(([k, a]) => `${k} ${a}`).join(HINT_GAP);

function Hints(props: { hints: readonly Hint[] }) {
  return (
    <For each={props.hints}>
      {([key, action], i) => (
        <>
          <span style={{ fg: TEXT }}>{key}</span>
          <span style={{ fg: MUTED }}>{` ${action}${i() < props.hints.length - 1 ? HINT_GAP : ''}`}</span>
        </>
      )}
    </For>
  );
}

// Status and hints side by side on one line; hints that do not fit go, the last one (quit) stays longest.
const fits = (status: string, hints: readonly Hint[], width: number) => 2 + status.length + 3 + hintsText(hints).length + 2 <= width;
function fitting(status: string, hints: readonly Hint[], width: number): Hint[] {
  const shown = [...hints];
  while (shown.length > 1 && !fits(status, shown, width)) shown.splice(shown.length - 2, 1);
  return fits(status, shown, width) ? shown : [];
}
// Only a status too long for the line wraps.
export const footerLines = (status: string, hints: readonly Hint[], width: number) =>
  fitting(status, hints, width).length ? 1 : linesOf(`  ${status}`, width);

export function Footer(props: { status: Status | null; hints: readonly Hint[]; width: number }) {
  const text = () => props.status?.text ?? '';
  const shown = () => fitting(text(), props.hints, props.width);
  const gap = () => ' '.repeat(Math.max(1, props.width - 2 - text().length - hintsText(shown()).length - 2));
  return (
    <text flexShrink={0}>
      <span style={{ fg: TONE[props.status?.tone ?? 'info'] }}>{`  ${text()}`}</span>
      <Show when={shown().length}>
        <span>{gap()}</span>
        <Hints hints={shown()} />
      </Show>
    </text>
  );
}

// The band on top: app name, then what the screen is about, anything else right-aligned; `below` is a second band line.
export function HeaderBand(props: { title: JSX.Element; titleWidth: number; right?: JSX.Element; rightWidth?: number; width: number; below?: JSX.Element }) {
  const gap = () => ' '.repeat(Math.max(1, props.width - 2 - 'resector'.length - 2 - props.titleWidth - (props.rightWidth ?? 0) - 2));
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={PANEL_BG}>
      <text>
        <span>{'  '}</span>
        <strong>
          <span style={{ fg: ACCENT }}>resector</span>
        </strong>
        <span>{'  '}</span>
        {props.title}
        <span>{gap()}</span>
        {props.right}
        <span>{'  '}</span>
      </text>
      {props.below ?? <text> </text>}
    </box>
  );
}

// The band below: ┃ in the accent colour down the left edge, the input line, a meta line.
export function PromptBand(props: { children: JSX.Element; meta?: JSX.Element }) {
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={PANEL_BG}>
      <box flexDirection="row">
        <text fg={ACCENT}>{'┃ '}</text>
        {props.children}
      </box>
      <text>
        <span style={{ fg: ACCENT }}>{'┃ '}</span>
        {props.meta}
      </text>
    </box>
  );
}
export const PROMPT_LINES = 2;

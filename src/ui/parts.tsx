// Building blocks shared by the screens: header band, prompt band and footer (status left, key hints right).
import { For, type JSX, Show } from 'solid-js';
import { linesOf } from './format';
import type { Status } from '../gate';
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
// Only a status too long for the line wraps, inside the margins so it stays one block.
export const footerLines = (status: string, hints: readonly Hint[], width: number) =>
  fitting(status, hints, width).length ? 1 : linesOf(status, width - 4);

export function Footer(props: { status: Status | null; hints: readonly Hint[]; width: number }) {
  const text = () => props.status?.text ?? '';
  const shown = () => fitting(text(), props.hints, props.width);
  const gap = () => ' '.repeat(Math.max(1, props.width - 2 - text().length - hintsText(shown()).length - 2));
  const fg = () => TONE[props.status?.tone ?? 'info'];
  return (
    <Show
      when={shown().length}
      fallback={
        <box flexShrink={0} paddingLeft={2} paddingRight={2}>
          <text fg={fg()}>{text()}</text>
        </box>
      }
    >
      <text flexShrink={0}>
        <span style={{ fg: fg() }}>{`  ${text()}`}</span>
        <span>{gap()}</span>
        <Hints hints={shown()} />
      </text>
    </Show>
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

// A band: its lines on the panel ground, ┃ in `color` down the left edge of every one.
export function Band(props: { color: string; lines: number; children: JSX.Element }) {
  return (
    <box flexDirection="row" flexShrink={0} height={props.lines} backgroundColor={PANEL_BG}>
      <text fg={props.color} flexShrink={0}>
        {Array.from({ length: props.lines }, () => '┃ ').join('\n')}
      </text>
      <box flexDirection="column" flexGrow={1}>
        {props.children}
      </box>
    </box>
  );
}

// The band below, ┃ in the accent colour: the input line, a meta line.
export function PromptBand(props: { children: JSX.Element; meta?: JSX.Element }) {
  return (
    <Band color={ACCENT} lines={PROMPT_LINES}>
      <box flexDirection="row">{props.children}</box>
      <text>{props.meta}</text>
    </Band>
  );
}
export const PROMPT_LINES = 2;

// An error gets its own band above the prompt, ┃ in the error colour: `✗ source`, then the reason in at most 3 lines.
const ERROR_BODY_LINES = 3;
function errorParts(text: string, width: number): { head: string; body: string[] } {
  const at = text.indexOf(': ');
  const head = at < 0 ? text : text.slice(0, at);
  const rest = at < 0 ? '' : text.slice(at + 2);
  const size = Math.max(1, width - 4);
  const body = wrapped(rest, size);
  if (body.length <= ERROR_BODY_LINES) return { head, body };
  return { head, body: [...body.slice(0, ERROR_BODY_LINES - 1), `${body[ERROR_BODY_LINES - 1]!.slice(0, size - 2)} …`] };
}
// Lines of at most `size` cells, broken at spaces; a word longer than a line is cut.
function wrapped(text: string, size: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ').flatMap(w => w.match(new RegExp(`.{1,${size}}`, 'g')) ?? [])) {
    if (line && line.length + 1 + word.length > size) lines.push(line), (line = '');
    line = line ? `${line} ${word}` : word;
  }
  return line ? [...lines, line] : lines;
}
export const errorBandLines = (text: string, width: number) => 1 + errorParts(text, width).body.length;

export function ErrorBand(props: { text: string; width: number }) {
  const parts = () => errorParts(props.text, props.width);
  return (
    <Band color={TONE.error} lines={1 + parts().body.length}>
      <text>
        <strong>
          <span style={{ fg: TONE.error }}>{`✗ ${parts().head}`}</span>
        </strong>
      </text>
      <For each={parts().body}>{line => <text fg={TEXT}>{line}</text>}</For>
    </Band>
  );
}

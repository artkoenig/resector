// The one screen (FR-1): header · block table · preview · input line · status line.
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { Kind } from '../core/log/events';
import { createGate, type Gate, type GateOptions } from './gate';
import { cell, formatTokens, right, titleOf } from './format';

const KIND_COLOR: Record<Kind, string> = { System: '#d787ff', User: '#87d787', Assistant: '#5fd7d7' };
const TEMPLATE_COLOR = '#808080';
const FREE_COLOR = '#444444';
const SELECTED_BG = '#3a3a3a';
const TONE = { info: '#bcbcbc', ok: '#87d787', warn: '#ffd75f', error: '#ff5f5f' };
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// Fixed columns around the title: marker, #, Kind, Tokens, Cache, Flags.
const FIXED_COLUMNS = 52;

type Mode = 'context' | 'input';
type Row = { n: number; kind: Kind; title: string; content: string; tokens: string; flags: string; live: boolean };

export function App(props: GateOptions & { onQuit: () => void }) {
  const gate = createGate(props);
  const size = useTerminalDimensions();
  const [mode, setMode] = createSignal<Mode>('context');
  const [draft, setDraft] = createSignal('');
  const [tick, setTick] = createSignal(0);
  const timer = setInterval(() => gate.streaming() && setTick(tick() + 1), 80);
  onCleanup(() => clearInterval(timer));

  const rows = (): Row[] => {
    const { blocks } = gate.context();
    const split = gate.split();
    const counted = split?.blocks.length === blocks.length;
    const done = blocks.map((b, i) => ({
      n: i + 1, kind: b.kind, title: titleOf(b), content: b.content,
      tokens: counted ? formatTokens(split.blocks[i]!) : '…', flags: b.cutOff ? '⚠ cut off' : '', live: false,
    }));
    const s = gate.streaming();
    if (!s) return done;
    const live = { kind: 'Assistant' as const, content: s.text };
    return [...done, { ...live, n: blocks.length + 1, title: titleOf(live), tokens: SPINNER[tick() % SPINNER.length]!, flags: '', live: true }];
  };

  const leaveInput = () => {
    setDraft('');
    setMode('context');
  };
  const submit = () => {
    gate.submit(draft());
    leaveInput();
  };
  const inputKeys: Record<string, () => void> = { return: submit, tab: leaveInput, escape: leaveInput };
  const contextKeys: Record<string, () => void> = {
    tab: () => setMode('input'),
    return: () => void gate.send(),
    up: () => gate.select(gate.selected() - 1),
    down: () => gate.select(gate.selected() + 1),
    q: props.onQuit,
  };
  useKeyboard(key => {
    if (mode() === 'input') inputKeys[key.name]?.();
    else if (key.name === 'escape') gate.abort();
    else if (!gate.streaming()) contextKeys[key.name]?.();
  });

  const width = () => size().width;
  const titleWidth = () => Math.max(8, width() - FIXED_COLUMNS);
  const selectedRow = () => rows()[gate.selected()];

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Header gate={gate} width={width()} />
      <text fg={TEMPLATE_COLOR}>{`     #  ${'Kind'.padEnd(11)}  ${cell('Title', titleWidth())}  Tokens  Cache  Flags`}</text>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <For each={rows()}>
          {row => (
            <text bg={row.n - 1 === gate.selected() ? SELECTED_BG : undefined}>
              <span>{`   ${right(String(row.n), 3)}  `}</span>
              <span style={{ fg: KIND_COLOR[row.kind] }}>{row.kind.padEnd(11)}</span>
              <span>{`  ${cell(row.title, titleWidth())}  `}</span>
              <span style={{ fg: row.live ? TONE.warn : undefined }}>{right(row.tokens, 6)}</span>
              <span>{'          '}</span>
              <span style={{ fg: TONE.warn }}>{row.flags}</span>
            </text>
          )}
        </For>
        <text fg={TEMPLATE_COLOR}>
          {`        ${'Template'.padEnd(11)}  ${cell('BOS · generation prompt', titleWidth())}  ${right(gate.split() ? String(gate.split()!.template) : '…', 6)}`}
        </text>
      </box>
      <box flexDirection="column" height={Math.max(4, Math.floor((size().height - 6) / 3))} overflow="hidden">
        <Show when={selectedRow()}>
          {(row: () => Row) => (
            <>
              <text fg={FREE_COLOR} flexShrink={0}>{cell(`── #${row().n} ${row().kind} · ${row().title} `, width()).replace(/  +$/, m => ' ' + '─'.repeat(m.length - 1))}</text>
              <text fg="#bcbcbc" flexShrink={0}>{row().content}</text>
            </>
          )}
        </Show>
      </box>
      <text fg={FREE_COLOR}>{'─'.repeat(width())}</text>
      <Show when={mode() === 'input'} fallback={<text fg={TEMPLATE_COLOR}>{' > Tab to write · Enter to send the Context'}</text>}>
        <box flexDirection="row">
          <text fg={KIND_COLOR.User}>{' > '}</text>
          <input focused value={draft()} onInput={setDraft} flexGrow={1} />
        </box>
      </Show>
      <StatusLine gate={gate} mode={mode()} />
    </box>
  );
}

function Header(props: { gate: Gate; width: number }) {
  const total = () => props.gate.split()?.total ?? 0;
  const tokens = () => `${props.gate.split() ? formatTokens(total()) : '…'} / ${formatTokens(props.gate.window())}`;
  const label = () => ` ${props.gate.profile}  `;
  const barWidth = () => Math.max(0, props.width - label().length - tokens().length - 3);
  const tone = () => (total() > props.gate.window() ? TONE.error : total() >= 0.9 * props.gate.window() ? TONE.warn : undefined);
  return (
    <text>
      <strong>{label()}</strong>
      <For each={contextBar(props.gate, barWidth())}>{c => <span style={{ fg: c.color }}>{c.char}</span>}</For>
      <span style={{ fg: tone() }}>{`  ${tokens()}`}</span>
    </text>
  );
}

// FR-2: one segment per block in Context order (plus Template), proportional to tokens; free space shaded.
function contextBar(gate: Gate, width: number): { char: string; color: string }[] {
  const split = gate.split();
  const cells = Array.from({ length: width }, () => ({ char: '░', color: FREE_COLOR }));
  if (!split || split.blocks.length !== gate.context().blocks.length) return cells;
  const scale = Math.max(split.total, gate.window());
  const segments = [
    ...gate.context().blocks.map((b, i) => ({ tokens: split.blocks[i]!, color: i === gate.selected() ? '#ffffff' : KIND_COLOR[b.kind], selected: i === gate.selected() })),
    { tokens: split.template, color: TEMPLATE_COLOR, selected: false },
  ];
  let sum = 0;
  let filled = 0;
  for (const s of segments) {
    const from = Math.max(filled, Math.round((sum / scale) * width));
    sum += s.tokens;
    const to = Math.max(Math.round((sum / scale) * width), s.selected ? from + 1 : 0);
    for (let x = from; x < Math.min(to, width); x++) cells[x] = { char: '█', color: s.color };
    filled = Math.max(filled, to);
  }
  return cells;
}

function StatusLine(props: { gate: Gate; mode: Mode }) {
  const text = () => {
    if (props.gate.streaming()) return { text: 'model is responding … Esc abort', tone: 'warn' as const };
    if (props.mode === 'input') return { text: 'Enter adds a User block (not sent) · Tab/Esc back', tone: 'info' as const };
    return props.gate.status() ?? { text: 'Enter send · Tab write · ↑↓ select · q quit', tone: 'info' as const };
  };
  return <text fg={TONE[text().tone]}>{` ${text().text}`}</text>;
}

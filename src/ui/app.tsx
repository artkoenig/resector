// The one screen (FR-1): header · block table · preview · input line · status line.
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { Kind } from '../core/log/events';
import { createGate, type Gate, type GateOptions } from './gate';
import { cell, flagsOf, formatTokens, right, titleOf } from './format';

const KIND_COLOR: Record<Kind, string> = { System: '#d787ff', User: '#87d787', Assistant: '#5fd7d7' };
const TEMPLATE_COLOR = '#808080';
const FREE_COLOR = '#444444';
const SELECTED_BG = '#3a3a3a';
const TONE = { info: '#bcbcbc', ok: '#87d787', warn: '#ffd75f', error: '#ff5f5f' };
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// Fixed columns around the title: marker, #, Kind, Tokens, Cache, Flags.
const FIXED_COLUMNS = 52;

const MARK_COLOR = '#ff875f';

type Mode = 'context' | 'input' | 'rename';
// A row per visible block; removed ones are struck through, unnumbered and not selectable until sent.
type Row = { id: number; n: string; kind: Kind; title: string; content: string; tokens: string; flags: string; live: boolean; removed: boolean };

export function App(props: GateOptions & { onQuit: () => void }) {
  const gate = createGate(props);
  const size = useTerminalDimensions();
  const [mode, setMode] = createSignal<Mode>('context');
  const [draft, setDraft] = createSignal('');
  const [tick, setTick] = createSignal(0);
  const timer = setInterval(() => gate.streaming() && setTick(tick() + 1), 80);
  onCleanup(() => clearInterval(timer));

  const rows = (): Row[] => {
    const split = gate.split();
    const n = (id: number) => String(gate.rows().indexOf(id) + 1);
    const tokens = (id: number) => (split ? formatTokens(split.blocks[gate.sent().findIndex(b => b.id === id)]!) : '…');
    const done = gate.context().blocks.map(b => ({
      id: b.id, kind: b.kind, title: titleOf(b), content: b.content, live: false, removed: b.removed,
      ...(b.removed ? { n: '', tokens: '', flags: 'removed' } : { n: n(b.id), tokens: tokens(b.id), flags: flagsOf(b) }),
    }));
    const s = gate.streaming();
    if (!s) return done;
    const id = gate.context().nextId;
    const live = { kind: 'Assistant' as const, content: s.text };
    const bottom = done.findIndex(r => gate.context().blocks.find(b => b.id === r.id)!.pin === 'bottom');
    done.splice(bottom < 0 ? done.length : bottom, 0, { ...live, id, n: n(id), title: titleOf(live), tokens: SPINNER[tick() % SPINNER.length]!, flags: '', live: true, removed: false });
    return done;
  };

  const leaveInput = () => {
    setDraft('');
    setMode('context');
  };
  const submit = () => {
    if (mode() === 'rename') gate.rename(draft());
    else gate.submit(draft());
    leaveInput();
  };
  const startRename = () => {
    const block = gate.selectedBlock();
    if (!block) return;
    setDraft(titleOf(block));
    setMode('rename');
  };
  const inputKeys: Record<string, () => void> = { return: submit, tab: leaveInput, escape: leaveInput };
  const contextKeys: Record<string, () => void> = {
    tab: () => setMode('input'),
    return: () => void gate.send(),
    up: () => gate.select(-1),
    down: () => gate.select(1),
    'alt+up': () => gate.move(-1),
    'alt+down': () => gate.move(1),
    p: gate.pin,
    d: gate.remove,
    u: gate.undo,
    r: startRename,
    space: gate.toggleMark,
    escape: gate.clearMarks,
    q: props.onQuit,
  };
  useKeyboard(key => {
    if (mode() !== 'context') inputKeys[key.name]?.();
    else if (gate.streaming()) key.name === 'escape' && gate.abort();
    else {
      const action = contextKeys[(key.option || key.meta ? 'alt+' : '') + key.name];
      // Handled here only: `r` must not also type into the input it focuses.
      if (action) key.preventDefault();
      action?.();
    }
  });

  const width = () => size().width;
  const titleWidth = () => Math.max(8, width() - FIXED_COLUMNS);
  const selectedRow = () => rows().find(r => r.id === gate.selected() && !r.removed);

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Header gate={gate} width={width()} />
      <text fg={TEMPLATE_COLOR}>{`     #  ${'Kind'.padEnd(11)}  ${cell('Title', titleWidth())}  Tokens  Cache  Flags`}</text>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <For each={rows()}>
          {row => (
            <text bg={!row.removed && row.id === gate.selected() ? SELECTED_BG : undefined} fg={row.removed ? TEMPLATE_COLOR : undefined}>
              <span style={{ fg: MARK_COLOR }}>{`  ${gate.marked().has(row.id) ? '●' : ' '}`}</span>
              <span>{`${right(row.n, 3)}  `}</span>
              <span style={{ fg: row.removed ? TEMPLATE_COLOR : KIND_COLOR[row.kind] }}>{row.kind.padEnd(11)}</span>
              <span>{'  '}</span>
              <span style={{ strikethrough: row.removed, dim: row.removed }}>{cell(row.title, titleWidth())}</span>
              <span>{'  '}</span>
              <span style={{ fg: row.live ? TONE.warn : undefined }}>{right(row.tokens, 6)}</span>
              <span>{'          '}</span>
              <span style={{ fg: row.removed ? TEMPLATE_COLOR : TONE.warn }}>{row.flags}</span>
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
      <Show when={mode() !== 'context'} fallback={<text fg={TEMPLATE_COLOR}>{' > Tab to write · Enter to send the Context'}</text>}>
        <box flexDirection="row">
          <text fg={KIND_COLOR.User}>{mode() === 'rename' ? ' title > ' : ' > '}</text>
          <input focused value={draft()} onInput={setDraft} flexGrow={1} />
        </box>
      </Show>
      <Footer gate={gate} mode={mode()} />
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
  if (!split) return cells;
  const scale = Math.max(split.total, gate.window());
  const segments = [
    ...gate.sent().map((b, i) => ({ tokens: split.blocks[i]!, color: b.id === gate.selected() ? '#ffffff' : KIND_COLOR[b.kind], selected: b.id === gate.selected() })),
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

const KEYS = 'Enter send · Tab write · ↑↓ select · ⌥↑↓ move · r rename · d remove · p pin · Space mark · u undo · q quit';

// Status line of the last action, then the key hints, which stay visible.
function Footer(props: { gate: Gate; mode: Mode }) {
  const status = () => (props.gate.streaming() ? { text: 'model is responding …', tone: 'warn' as const } : props.gate.status());
  const keys = () => {
    if (props.gate.streaming()) return 'Esc abort';
    if (props.mode === 'input') return 'Enter adds a User block (not sent) · Tab/Esc back';
    if (props.mode === 'rename') return 'Enter sets title (display only, never sent; empty = reset) · Tab/Esc cancel';
    return KEYS;
  };
  return (
    <>
      <text fg={TONE[status()?.tone ?? 'info']}>{` ${status()?.text ?? ''}`}</text>
      <text fg={TEMPLATE_COLOR}>{` ${keys()}`}</text>
    </>
  );
}

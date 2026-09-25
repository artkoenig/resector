// The one screen (FR-1): header · block table · preview · input line · status line.
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import type { Kind } from '../core/log/events';
import { COMMANDS, createGate, type Gate, type GateOptions, type Running } from './gate';
import { cell, flagsOf, formatTokens, right, titleOf } from './format';
import { DIM as TEMPLATE_COLOR, FREE_COLOR, KIND_COLOR, MARK_COLOR, SELECTED_BG, TONE } from './theme';

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// Fixed columns around the title: marker, #, Kind, Tokens, Cache, Flags.
const FIXED_COLUMNS = 52;
const CACHE_COLOR: Record<string, string> = { '●': TONE.ok, '○': TEMPLATE_COLOR, '': TEMPLATE_COLOR };

type Mode = 'context' | 'input' | 'rename';
// A row per visible block; removed ones are struck through, unnumbered and not selectable until sent.
type Row = { id: number; n: string; kind: Kind; title: string; content: string; tokens: string; cache: string; flags: string; live: boolean; removed: boolean };

export function App(props: GateOptions & { onQuit: () => void }) {
  const gate = createGate(props);
  const size = useTerminalDimensions();
  const [mode, setMode] = createSignal<Mode>('context');
  const [draft, setDraft] = createSignal('');
  const [tick, setTick] = createSignal(0);
  const [suggested, setSuggested] = createSignal(0);
  const timer = setInterval(() => gate.busy() && setTick(tick() + 1), 80);
  onCleanup(() => clearInterval(timer));

  const rows = (): Row[] => {
    const split = gate.split();
    const n = (id: number) => String(gate.rows().indexOf(id) + 1);
    const tokens = (id: number) => (split ? formatTokens(split.blocks[gate.sent().findIndex(b => b.id === id)]!) : '…');
    const cache = (id: number) => ({ true: '●', false: '○', null: '' })[`${gate.warm(id)}`]!;
    const blocks = gate.context().blocks;
    // The running call is decided: no ? approve.
    const running = gate.running()?.call.id;
    const next = gate.nextCall()?.id;
    const done = blocks.map(b => ({
      id: b.id, kind: b.kind, title: titleOf(b, blocks), content: b.content, live: false, removed: b.removed,
      ...(b.removed ? { n: '', tokens: '', cache: '', flags: 'removed' } : { n: n(b.id), tokens: tokens(b.id), cache: cache(b.id), flags: b.id === running ? '' : flagsOf(b, next) }),
    }));
    const live = gate.live();
    if (!live) return done;
    const at = live.before === null ? -1 : done.findIndex(r => r.id === live.before);
    const row = { ...live, n: n(live.id), title: titleOf({ ...live, call: running }, blocks), tokens: SPINNER[tick() % SPINNER.length]!, cache: '', flags: '', live: true, removed: false };
    done.splice(at < 0 ? done.length : at, 0, row);
    return done;
  };

  // FR-6: command suggestions while the input is a single `/word`.
  const suggestions = () => (mode() === 'input' && /^\/\S*$/.test(draft()) ? COMMANDS.filter(c => c.name.startsWith(draft())) : []);
  const suggestion = () => suggestions()[Math.min(suggested(), suggestions().length - 1)];
  const editDraft = (text: string) => {
    setDraft(text);
    setSuggested(0);
  };
  const complete = (c: (typeof COMMANDS)[number]) => editDraft(c.name + (c.arg ? ' ' : ''));
  // Enter on a suggestion: one taking an argument is completed, any other runs.
  const choose = () => {
    const c = suggestion()!;
    if (c.arg && draft() !== c.name) complete(c);
    else {
      gate.submit(c.name);
      leaveInput();
    }
  };
  const suggestionKeys: Record<string, () => void> = {
    up: () => setSuggested((suggested() + suggestions().length - 1) % suggestions().length),
    down: () => setSuggested((suggested() + 1) % suggestions().length),
    tab: () => complete(suggestion()!),
    return: choose,
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
  // The preview scrolls on its own; a newly selected block starts at its top.
  let preview: ScrollBoxRenderable | undefined;
  const previewHeight = () => Math.max(4, Math.floor((size().height - 6) / 3));
  const scrollPreview = (lines: number) => preview?.scrollBy(lines);
  createEffect(on(gate.selected, () => preview?.scrollTo(0)));

  const inputKeys: Record<string, () => void> = { return: submit, tab: leaveInput, escape: leaveInput };
  const contextKeys: Record<string, () => void> = {
    tab: () => setMode('input'),
    return: () => void gate.send(),
    up: () => gate.select(-1),
    down: () => gate.select(1),
    'alt+up': () => gate.move(-1),
    'alt+down': () => gate.move(1),
    'shift+up': () => scrollPreview(-1),
    'shift+down': () => scrollPreview(1),
    pageup: () => scrollPreview(-(previewHeight() - 2)),
    pagedown: () => scrollPreview(previewHeight() - 2),
    y: gate.approve,
    n: gate.reject,
    p: gate.pin,
    d: gate.remove,
    u: gate.undo,
    r: startRename,
    space: gate.toggleMark,
    escape: gate.clearMarks,
    q: props.onQuit,
  };
  // Keys of the command suggestions win while any are shown.
  const suggestionKey = (name: string) => (suggestion() ? suggestionKeys[name] : undefined);
  useKeyboard(key => {
    const onSuggestion = suggestionKey(key.name);
    if (onSuggestion) {
      key.preventDefault();
      onSuggestion();
    } else if (mode() !== 'context') inputKeys[key.name]?.();
    else if (gate.busy()) key.name === 'escape' && gate.abort();
    else {
      const action = contextKeys[modifierOf(key) + key.name];
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
      <text fg={TEMPLATE_COLOR}>{`     #  ${'Kind'.padEnd(11)}  ${cell('Title', titleWidth())}  Tokens  ${gate.approximate() ? 'Cache≈' : 'Cache '} Flags`}</text>
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
              <span style={{ fg: CACHE_COLOR[row.cache] }}>{`    ${row.cache.padEnd(1)}    `}</span>
              <span style={{ fg: row.removed ? TEMPLATE_COLOR : TONE.warn }}>{row.flags}</span>
            </text>
          )}
        </For>
        <text fg={TEMPLATE_COLOR}>
          {`        ${'Template'.padEnd(11)}  ${cell('BOS · generation prompt', titleWidth())}  ${right(gate.split() ? String(gate.split()!.template) : '…', 6)}`}
        </text>
      </box>
      <box flexDirection="column" height={previewHeight()}>
        <Show when={selectedRow()}>
          {(row: () => Row) => (
            <>
              <text fg={FREE_COLOR} flexShrink={0}>{cell(`── #${row().n} ${row().kind} · ${row().title} `, width()).replace(/  +$/, m => ' ' + '─'.repeat(m.length - 1))}</text>
              <scrollbox ref={preview} flexGrow={1}>
                <text fg="#bcbcbc">{row().content}</text>
              </scrollbox>
            </>
          )}
        </Show>
      </box>
      <For each={suggestions()}>
        {c => (
          <text bg={c === suggestion() ? SELECTED_BG : undefined} fg={c === suggestion() ? undefined : TEMPLATE_COLOR}>
            {`  ${`${c.name} ${c.arg}`.padEnd(22)} ${c.description}`}
          </text>
        )}
      </For>
      <text fg={FREE_COLOR}>{'─'.repeat(width())}</text>
      <Show when={mode() !== 'context'} fallback={<text fg={TEMPLATE_COLOR}>{' > Tab to write · Enter to send the Context'}</text>}>
        <box flexDirection="row">
          <text fg={KIND_COLOR.User}>{mode() === 'rename' ? ' title > ' : ' > '}</text>
          <input focused value={draft()} onInput={editDraft} flexGrow={1} />
        </box>
      </Show>
      <Footer gate={gate} mode={suggestion() ? 'suggest' : mode()} tick={tick()} />
    </box>
  );
}

function Header(props: { gate: Gate; width: number }) {
  const total = () => props.gate.split()?.total ?? 0;
  const tokens = () => `${props.gate.split() ? formatTokens(total()) : '…'} / ${formatTokens(props.gate.window())}`;
  const label = () => ` ${props.gate.profile()}  `;
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

const modifierOf = (key: { option?: boolean; meta: boolean; shift: boolean }) => (key.option || key.meta ? 'alt+' : key.shift ? 'shift+' : '');

const KEYS = 'Enter send · Tab write · ↑↓ select · ⌥↑↓ move · PgUp/PgDn scroll · r rename · d remove · p pin · Space mark · u undo · q quit';

// Status line of the last action, then the key hints, which stay visible.
function Footer(props: { gate: Gate; mode: Mode | 'suggest'; tick: number }) {
  const runningText = (r: Running) =>
    `running: ${cell(titleOf(r.call), 50).trimEnd()} · ${Math.round((Date.now() - r.started) / 1000)}s / ${props.gate.timeout}s`;
  const status = () => {
    void props.tick;
    const r = props.gate.running();
    if (r) return { text: runningText(r), tone: 'warn' as const };
    return props.gate.streaming() ? { text: 'model is responding …', tone: 'warn' as const } : props.gate.status();
  };
  const keys = () => {
    if (props.gate.running()) return 'Esc kill';
    if (props.gate.streaming()) return 'Esc abort';
    if (props.mode === 'context' && props.gate.selectedBlock()?.pending) return `y run once · n reject · ${KEYS}`;
    if (props.mode === 'suggest') return '↑↓ choose · Tab complete · Enter run · Esc back';
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

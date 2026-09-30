// The block table: a row per visible block (live ones included), a window of them around the selection, and the Template line.
import type { MouseEvent } from '@opentui/core';
import { For, Show } from 'solid-js';
import type { Kind } from '../core/log/events';
import type { Screen } from './screen';
import { cell, flagsOf, right } from './format';
import { formatTokens, titleOf } from '../gate/text';
import { ACCENT, FAINT, KIND_COLOR, MUTED, SELECTED_BG, TEXT, TONE } from './theme';

export const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// Fixed columns around the title: marker, #, Kind, Tokens, Cache, Flags; flags beyond their column are cut, never wrapped.
const FIXED_COLUMNS = 52;
const FLAGS_WIDTH = 14;
const CACHE_COLOR: Record<string, string> = { '●': TONE.ok, '○': FAINT, '': FAINT };
const WHEEL: Record<string, number> = { up: -1, down: 1 };

// A row per visible block; removed ones are struck through, unnumbered and not selectable until sent.
// dropped: a Thinking block the chat template drops, dimmed.
export type Row = { id: number; heading?: string; n: string; kind: Kind; title: string; content: string; tokens: string; cache: string; flags: string; live: boolean; removed: boolean; dropped?: boolean };

export function createRows(gate: Screen, tick: () => number) {
  return (): Row[] => {
    const n = (id: number) => String(gate.rows().indexOf(id) + 1);
    const tokensOf = gate.blockTokens;
    const tokens = (id: number) => (tokensOf(id) === null ? '…' : formatTokens(tokensOf(id)!));
    const cache = (id: number) => ({ true: '●', false: '○', null: '' })[`${gate.warm(id)}`]!;
    const blocks = gate.context().blocks;
    // Sources of a proposal are shown as such until it is accepted or discarded.
    const proposed = new Set(gate.compacting()?.phase === 'instruction' ? [] : gate.compacting()?.sources);
    // The running call is decided: no ? approve.
    const running = gate.running()?.call.id;
    const next = gate.nextCall()?.id;
    const done: Row[] = blocks.map(b => {
      const dropped = !b.removed && b.kind === 'Thinking' && b.content !== '' && tokensOf(b.id) === 0;
      return {
        id: b.id, kind: b.kind, title: titleOf(b, blocks), content: b.content, live: false, removed: b.removed, dropped,
        ...(b.removed ? { n: '', tokens: '', cache: '', flags: 'removed' } : { n: n(b.id), tokens: tokens(b.id), cache: cache(b.id), flags: b.id === running ? '' : flagsOf(b, next, dropped) }),
        ...(proposed.has(b.id) && { flags: '◇ proposed', removed: true }),
      };
    });
    for (const live of gate.live()) {
      const at = live.before === null ? -1 : done.findIndex(r => r.id === live.before);
      const counted = live.tokens === undefined ? SPINNER[tick() % SPINNER.length]! : formatTokens(live.tokens);
      const row = { ...live, n: n(live.id), title: titleOf({ ...live, call: running }, blocks), tokens: counted, cache: '', flags: '', live: true, removed: false };
      done.splice(at < 0 ? done.length : at, 0, row);
    }
    // The Kind Filters as the Gate applies them to selection, here also to removed rows.
    return done.filter(r => gate.passes(r.id, r.kind));
  };
}

export const isSelected = (gate: Screen, row: Row) => !row.removed && row.id === gate.selected();

export function BlockTable(props: { gate: Screen; rows: Row[]; visible: Row[]; width: number }) {
  const gate = props.gate;
  const titleWidth = () => Math.max(8, props.width - FIXED_COLUMNS);
  // The wheel over the block table moves the selection, like ↑↓ (also while busy).
  const wheel = (event: MouseEvent) => {
    const step = WHEEL[event.scroll?.direction ?? ''];
    if (step) gate.select(step);
  };
  return (
    <>
      <text fg={MUTED} flexShrink={0}>{`     #  ${'Type'.padEnd(11)}  ${cell('Content', titleWidth())}  Tokens  Cache  Flags`}</text>
      <box flexDirection="column" flexGrow={1} overflow="hidden" onMouseScroll={wheel}>
        <For each={props.visible}>
          {row => {
            const selected = () => isSelected(gate, row);
            const fg = () => columnFg(row, selected());
            return (
              <text flexShrink={0} bg={selected() ? SELECTED_BG : undefined} fg={fg().text}>
                <span style={{ fg: ACCENT }}>{`${selected() ? '┃' : ' '} ${gate.marked().has(row.id) ? '●' : ' '}`}</span>
                <span style={{ fg: fg().muted }}>{`${right(row.n, 3)}  `}</span>
                <span style={{ fg: fg().kind, strikethrough: row.removed }}>{row.kind.padEnd(11)}</span>
                <span>{'  '}</span>
                <span style={{ fg: fg().muted, strikethrough: row.removed, italic: row.kind === 'Thinking' }}>{cell(row.title, titleWidth())}</span>
                <span>{'  '}</span>
                <span style={{ fg: fg().tokens }}>{right(row.tokens, 6)}</span>
                <span style={{ fg: CACHE_COLOR[row.cache] }}>{`    ${row.cache.padEnd(1)}    `}</span>
                <span style={{ fg: fg().flags }}>{cell(row.flags, FLAGS_WIDTH).trimEnd()}</span>
              </text>
            );
          }}
        </For>
        <Show when={gate.hiding() && props.rows.every(r => r.removed)}>
          <text fg={MUTED} flexShrink={0}>{'        no blocks shown'}</text>
        </Show>
        <text fg={MUTED} flexShrink={0}>
          {`        ${'Template'.padEnd(11)}  ${cell('BOS · generation prompt', titleWidth())}  ${right(gate.split() ? String(gate.split()!.template) : '…', 6)}`}
        </text>
      </box>
    </>
  );
}

// Colours of a row: a removed one is muted throughout, one the chat template drops all but its flags.
const rowFg = (row: Row) =>
  row.removed || row.dropped
    ? { text: MUTED, kind: MUTED, flags: row.dropped ? TONE.warn : MUTED }
    : { text: TEXT, kind: KIND_COLOR[row.kind], flags: TONE.warn };
// A row's column colours: # and Content muted unless selected; Tokens yellow while live (not yet in the Context).
const columnFg = (row: Row, selected: boolean) => {
  const muted = selected ? TEXT : MUTED;
  return { ...rowFg(row), muted, tokens: row.live && !row.removed ? TONE.warn : muted };
};

// The Gate's header: profile and modes, the Context's tokens with its bar, and the Kind Filters line below.
import { For } from 'solid-js';
import type { Gate } from './gate';
import { formatTokens, thinkingLabel } from './format';
import { HeaderBand } from './parts';
import { ACCENT, BORDER, FAINT, KIND_COLOR, MUTED, TEXT, TONE } from './theme';

export function Header(props: { gate: Gate; width: number }) {
  const total = () => props.gate.split()?.total ?? 0;
  const used = () => (props.gate.split() ? formatTokens(total()) : '…');
  const budget = () => props.gate.budget();
  // ±X drift of an inexact tokenizer, dimmed; above the window red `over by X`.
  const window = () => ` / ${formatTokens(props.gate.window())}`;
  const drift = () => {
    const label = budget()?.driftLabel;
    return label ? ` ${label}` : '';
  };
  const over = () => {
    const tokens = budget()?.over;
    return tokens ? ` over by ${formatTokens(tokens)}` : '';
  };
  const tone = () => ({ ok: undefined, warn: TONE.warn, over: TONE.error })[budget()?.tone ?? 'ok'];
  const profile = () => props.gate.profile();
  // The active Context Policy follows the thinking mode (ADR 0001), then auto-approve, then the git branch
  // and the worktree.
  const git = () => (props.gate.branch() ? ` · ⎇ ${props.gate.branch()}${props.gate.dirty() ? '*' : ''}` : '') + (props.gate.worktree() ? ' · worktree' : '');
  const thinking = () =>
    ` · thinking ${thinkingLabel(props.gate.thinking())}${props.gate.policy() ? ` · policy ${props.gate.policy()}` : ''}${props.gate.autoApprove() ? ' · auto-approve' : ''}${git()}`;
  return (
    <HeaderBand
      width={props.width}
      title={<span style={{ fg: MUTED }}>{profile() + thinking()}</span>}
      titleWidth={profile().length + thinking().length}
      right={
        <>
          <span style={{ fg: tone() ?? TEXT }}>{used()}</span>
          <span style={{ fg: tone() ?? MUTED }}>{window()}</span>
          <span style={{ fg: MUTED }}>{drift()}</span>
          <span style={{ fg: TONE.error }}>{over()}</span>
        </>
      }
      rightWidth={used().length + window().length + drift().length + over().length}
      below={
        <text>
          <span>{'  '}</span>
          <For each={contextBar(props.gate, Math.max(0, props.width - 4))}>{c => <span style={{ fg: c.color }}>{c.char}</span>}</For>
        </text>
      }
    />
  );
}

// While blocks are hidden: the Kind Filters off below the header, and the share of the blocks and tokens sent that is shown; removed ones are not.
export function FilterLine(props: { gate: Gate }) {
  const share = () => props.gate.filterShare();
  const tokens = () => (share().total === null ? '…' : `${formatTokens(share().tokens!)}/${formatTokens(share().total!)}`);
  return (
    <text flexShrink={0}>
      <span style={{ fg: ACCENT }}>{`  hidden: ${props.gate.hidden().map(f => f.name).join(' ')}`}</span>
      <span style={{ fg: MUTED }}>{` · ${share().blocks}/${share().all} blocks · ${tokens()} tokens`}</span>
    </text>
  );
}

// One segment per block in Context order (plus Template), proportional to tokens; free space in the border colour.
// Over the window the bar is scaled to the Context and marks the window edge.
// Half cells: thicker than a line, lighter than a solid strip.
const BAR = '▀';
const EDGE = '│';
function contextBar(gate: Gate, width: number): { char: string; color: string }[] {
  const split = gate.split();
  const cells = Array.from({ length: width }, () => ({ char: BAR, color: BORDER }));
  if (!split) return cells;
  const scale = Math.max(split.total, gate.window());
  const segments = [
    ...gate.sent().map((b, i) => ({ tokens: split.blocks[i]!, color: b.id === gate.selected() ? TEXT : KIND_COLOR[b.kind], selected: b.id === gate.selected() })),
    { tokens: split.template, color: FAINT, selected: false },
  ];
  let sum = 0;
  let filled = 0;
  for (const s of segments) {
    const from = Math.max(filled, Math.round((sum / scale) * width));
    sum += s.tokens;
    const to = Math.max(Math.round((sum / scale) * width), s.selected ? from + 1 : 0);
    for (let x = from; x < Math.min(to, width); x++) cells[x] = { char: BAR, color: s.color };
    filled = Math.max(filled, to);
  }
  const edge = Math.round((gate.window() / scale) * width);
  if (split.total > gate.window() && edge < width) cells[edge] = { char: EDGE, color: TONE.error };
  return cells;
}

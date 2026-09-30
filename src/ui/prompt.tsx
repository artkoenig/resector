// The prompt band's meta line (what Enter does, or the Compaction's effect) and the status line of the step under way.
import { Show } from 'solid-js';
import type { Compaction, Gate, Status } from './gate';
import { cell } from './format';
import { count, formatTokens, titleOf } from './gate/text';
import { ACCENT, KIND_COLOR, MUTED, TONE } from './theme';

export type Mode = 'context' | 'input';

// Meta line of the prompt band: what Enter does with the draft.
export function PromptMeta(props: { mode: Mode }) {
  return (
    <Show when={props.mode !== 'context'}>
      <span style={{ fg: KIND_COLOR.User }}>User</span>
      <span style={{ fg: MUTED }}>  adds a block and sends the Context · @path[:a-b] adds a file</span>
    </Show>
  );
}

// Compaction: the header while writing the instruction, the proposal's effect while it is reviewed.
export function CompactionMeta(props: { gate: Gate; compaction: Compaction }) {
  const c = () => props.compaction;
  const tokens = (t: number | null) => (t === null ? '…' : formatTokens(t));
  const fits = () => c().request === null || c().request! < c().backend.window;
  const request = () =>
    fits() ? `request ${tokens(c().request)} / ${formatTokens(c().backend.window)}` : `request ${tokens(c().request)} ≥ window ${formatTokens(c().backend.window)} – does not fit`;
  const review = () => props.gate.review();
  return (
    <Show
      when={c().phase === 'instruction'}
      fallback={
        <span style={{ fg: review()?.cold ? TONE.warn : MUTED }}>{c().phase === 'running' ? `compacting with ${c().profile} …` : (review()?.cache ?? 'counting …')}</span>
      }
    >
      <span style={{ fg: ACCENT }}>{`◇ Compact ${count(c().sources.length, 'block')} (${tokens(props.gate.sourceTokens())} tok)`}</span>
      <span style={{ fg: MUTED }}>{` · ${c().profile} · `}</span>
      <span style={{ fg: fits() ? MUTED : TONE.error }}>{request()}</span>
    </Show>
  );
}

// Status line: a running command, policy or Compaction, the streaming answer (both with the row's spinner), else the last action.
export function statusOf(gate: Gate, spin: string): Status | null {
  // Esc pressed once: the loop stops after this step.
  const stop = (step: string) => (gate.stopping() ? ` · stops after this ${step}` : '');
  const r = gate.running();
  if (r) return { text: `${spin} running: ${cell(titleOf(r.call), 50).trimEnd()} · ${Math.round((Date.now() - r.started) / 1000)}s / ${r.timeout}s${stop('call')}`, tone: 'warn' };
  if (gate.policing()) return { text: `${spin} policy ${gate.policing()} running`, tone: 'warn' };
  if (gate.compacting()?.phase === 'running') return { text: `${spin} compacting with ${gate.compacting()!.profile}`, tone: 'warn' };
  const s = gate.streaming();
  if (!s) return gate.status();
  return { text: `${spin} model is ${s.thinking && !s.text ? 'thinking' : 'responding'}${stop('answer')}`, tone: 'warn' };
}

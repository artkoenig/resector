// The user's Compaction at the Gate: the instruction is written, the proposal streams, then it is reviewed.
import type * as ops from '../core/context/operations';
import * as compaction from '../core/compaction/compaction';
import { fold } from '../core/log/fold';
import { renderPrefixes, type Request } from '../core/render/native';
import { errorText, formatTokens } from './text';
import type { Kernel } from './kernel';
import type { Compaction, Compactor, Live, Review, Status, View } from './types';

export function createCompaction(k: Kernel, sel: View, deps: { editor: ops.Editor; instruction: () => string; compactor: () => Promise<Compactor | null> }) {
  const { context, nextId, setStatus, backend, compacting, setCompacting, tokensOf } = k;
  const { editor, instruction } = deps;
  const update = (change: Partial<Compaction>) => setCompacting({ ...compacting()!, ...change });

  // c: the marked blocks, else the selected one, are compacted; first the instruction is written.
  async function start() {
    const found = compaction.sourcesOf(context(), sel.marked(), sel.selectedBlock()?.id ?? -1);
    if ('error' in found) return setStatus({ text: found.error, tone: 'info' });
    try {
      const own = await deps.compactor();
      const on = own ?? { profile: context().profile, backend: backend() };
      setCompacting({ ...on, sources: found.sources, same: !own, phase: 'instruction', attempt: 0, instruction: '', draft: '', text: '', abort: null, request: null, after: null });
      setStatus(null);
    } catch (e) {
      setStatus({ text: `compaction profile: ${errorText(e)}`, tone: 'error' });
    }
  }
  const instructionOf = (draft: string) => draft.trim() || instruction();
  const requestOf = (c: Compaction, draft: string) => compaction.compactionRequest(context(), c.sources, instructionOf(draft));
  // The request with the instruction being written, counted for the header; only the latest counts.
  let measuring = '';
  async function measure(draft: string) {
    const c = compacting();
    if (!c) return;
    measuring = draft;
    const { total } = await c.backend.count([requestOf(c, draft)]).catch(() => ({ total: null }));
    if (measuring === draft && compacting()) update({ request: total });
  }

  // Enter on the instruction: a new run from the sources, unless the request does not fit the window.
  // The instruction line closes at once: the run starts with counting.
  async function run(draft: string) {
    const c = compacting()!;
    const request = requestOf(c, draft);
    const abort = new AbortController();
    update({ phase: 'running', draft, abort });
    setStatus(null);
    try {
      const total = await fits(c, request);
      if (total !== null) await propose(c, request, draft, abort, c.backend.window - total);
    } catch (e) {
      end({ text: `compaction failed: ${errorText(e)}`, tone: 'error' });
    } finally {
      // The server's cache now holds the compaction request.
      if (c.same) k.recount();
    }
  }
  // The request's tokens; too big for the window of the Compaction's Model Profile: null, back to the
  // instruction, no chunking.
  async function fits(c: Compaction, request: Request): Promise<number | null> {
    const { total } = await c.backend.count([request]);
    if (total < c.backend.window) return total;
    update({ phase: 'instruction', abort: null });
    setStatus({ text: `compaction request ${formatTokens(total)} ≥ window ${formatTokens(c.backend.window)} of ${c.profile} – shrink the selection (Esc, then d / e)`, tone: 'error' });
    return null;
  }
  // The proposal streams into its row, with the rest of the window as max_tokens; Esc aborts, also while
  // the request is still counted.
  async function propose(c: Compaction, request: Request, draft: string, abort: AbortController, maxTokens: number) {
    const aborted = () => end({ text: 'compaction aborted – Context unchanged', tone: 'info' });
    if (abort.signal.aborted) return aborted();
    update({ attempt: c.attempt + 1, instruction: instructionOf(draft), text: '', after: null });
    sel.setSelected(nextId());
    const onDelta = (d: string) => update({ text: compacting()!.text + d });
    const result = await c.backend.chat(request, { signal: abort.signal, onDelta, maxTokens });
    if (result.finish === 'aborted') return aborted();
    update({ phase: 'review', abort: null });
    if (result.finish === 'length') setStatus({ text: '⚠ proposal cut off at max_tokens', tone: 'warn' });
    await countProposal();
  }
  function end(status: Status) {
    const c = compacting();
    setCompacting(null);
    if (c && !context().blocks.some(b => b.id === sel.selected())) sel.setSelected(c.sources[0]!);
    sel.keepSelection();
    setStatus(status);
  }
  // The Context as it would be after accept, counted: the Note's tokens and the Context total.
  async function countProposal() {
    const c = compacting()!;
    const after = fold([...k.events(), { type: 'Compact', sources: c.sources, instruction: c.instruction, noteId: nextId(), content: c.text }]);
    const counted = await backend().count(renderPrefixes(after)).catch(() => null);
    const note = after.blocks.findIndex(b => b.id === nextId());
    if (counted && compacting()?.text === c.text) update({ after: { note: counted.blocks[note]!, total: counted.total } });
  }
  // Under review: tokens before → after and the Context after accept; the cache effect.
  function review(c: Compaction): Review | null {
    const before = tokensOf(c.sources);
    if (!c.after || before === null) return null;
    const saved = compaction.reduction(before, c.after.note);
    const change = saved < 0 ? `+${-saved}%` : `−${saved}%`;
    const window = backend().window;
    const context = `Context ${formatTokens(k.split()!.total)} → ${formatTokens(c.after.total)} / ${formatTokens(window)}`;
    const session = c.same ? 'session cache cold (same model/slot)' : 'session cache untouched';
    return { tokens: `${formatTokens(before)} → ${formatTokens(c.after.note)} tok (${change}) · ${context}`, over: c.after.total >= window, cache: `${session} · cold from #${sel.rows().indexOf(nextId()) + 1} after accept`, cold: c.same };
  }

  function accept() {
    const c = compacting()!;
    const id = nextId();
    const before = tokensOf(c.sources);
    if (!k.apply(compaction.accept(c.sources, c.instruction, id, c.text))) return;
    setCompacting(null);
    sel.setMarked(new Set<number>());
    sel.setSelected(id);
    setStatus({ text: `◇ accepted: ${before ?? '?'} → ${c.after?.note ?? '?'} tok · u = undo`, tone: 'ok' });
  }
  // i: the instruction again, the last one to change; Esc there returns to the proposal.
  const refine = () => update({ phase: 'instruction' });
  function leaveInstruction() {
    const c = compacting()!;
    if (c.attempt) update({ phase: 'review' });
    else end({ text: 'compaction cancelled', tone: 'info' });
  }
  // e: the proposal in $EDITOR; the edited text is what accept adds.
  async function editProposal() {
    const c = compacting()!;
    try {
      const text = (await editor(c.text)).replace(/\n$/, c.text.endsWith('\n') ? '\n' : '');
      if (text === c.text) return setStatus({ text: 'unchanged', tone: 'info' });
      update({ text, after: null });
      setStatus({ text: 'proposal edited by hand', tone: 'info' });
      await countProposal();
    } catch (e) {
      setStatus({ text: `editor failed: ${errorText(e)} – unchanged`, tone: 'error' });
    }
  }

  return {
    compacting,
    sourceTokens: () => (compacting() ? tokensOf(compacting()!.sources) : null),
    review: () => (compacting()?.phase === 'review' ? review(compacting()!) : null),
    defaultInstruction: instruction,
    startCompaction: () => void start(),
    measure: (draft: string) => void measure(draft),
    runCompaction: (draft: string) => void run(draft),
    acceptCompaction: accept,
    discardCompaction: () => end({ text: 'proposal discarded – Context unchanged', tone: 'info' }),
    refine,
    leaveInstruction,
    editProposal: () => void editProposal(),
  };
}

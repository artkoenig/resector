// Review Gate state: the Session Log in memory, Context = fold(events), token split, streaming answer.
import { createEffect, createMemo, createSignal } from 'solid-js';
import type { Clipboard } from '../adapters/clipboard/clipboard';
import type { Backend, ChatResult, Counted } from '../core/backend';
import { evaluate, quoted, sessionAllowed, sessionRules, type Rule, type Split, type Verdict } from '../core/approval/approval';
import { warmRows } from '../core/cache/cache';
import * as compaction from '../core/compaction/compaction';
import * as ops from '../core/context/operations';
import type { Kind, SessionEvent, SessionLog } from '../core/log/events';
import { afterCalls, fold, pairOf, type Block } from '../core/log/fold';
import { refreshEnvironment } from '../core/notes/environment';
import { parseReference, peekReferences, readReferences, references, type ReadFile } from '../core/notes/files';
import { renderNative, renderPrefixes, sentBlocks, type Request } from '../core/render/native';
import { answerBlocks } from '../core/toolcall/answer';
import type { Runner } from '../core/toolcall/bash';
import { count, errorText, formatTokens, titleOf } from './format';

export type Status = { text: string; tone: 'info' | 'ok' | 'warn' | 'error' };
// events: the Session Log so far (new or resumed); reconnect: re-reads the config and opens the session's
// Model Profile again (/reload, FR-44); openSessions: shows /sessions; notice: initial status line.
// runner: runs approved bash calls (FR-21); approval: decides which may run (FR-22); editor: $EDITOR for `e` (FR-8);
// clipboard: copy on select.
export type GateOptions = {
  backend: Backend;
  runner: Runner;
  approval: Approval;
  editor: ops.Editor;
  clipboard: Clipboard;
  log: SessionLog;
  events: SessionEvent[];
  project: Project;
  reconnect: () => Promise<Backend>;
  openSessions: () => void;
  notice?: Status;
  // Default Compaction instruction (FR-13); the Model Profile Compaction runs on, null = the session's own (FR-17).
  instruction?: () => string;
  compactor?: () => Promise<Compactor | null>;
};
export type Compactor = { profile: string; backend: Backend };
// The project on disk: files for @path references and their completion (FR-27), the environment Note's text now
// (FR-28), and $EDITOR on a file of the project (`e` on a reference).
export type Project = { read: ReadFile; list: () => string[]; environment: () => string; open: (path: string) => Promise<void> };
// Tool Approval (FR-22, FR-25): the splitter, the project root arguments must stay in, and the config's rules as read
// at open and on /reload (ignored: project allow patterns).
export type Approval = { split: Split; root: string; permissions: () => { rules: Rule[]; ignored: string[] } };

// Slash commands (FR-6), in suggestion order.
export const COMMANDS = [
  { name: '/sessions', arg: '', description: 'list, resume, rename, delete sessions' },
  { name: '/rename', arg: '<title>', description: 'rename session' },
  { name: '/reload', arg: '', description: 're-read config' },
] as const;
type CommandName = (typeof COMMANDS)[number]['name'];
// In-flight answer, its reasoning apart; never persisted until complete or aborted (FR-37).
export type Streaming = { thinking: string; text: string; abort: AbortController };
// Approved Tool Call running; its output so far is shown, the result is logged when it ends.
export type Running = { call: Block; output: string; started: number; abort: AbortController };
// The row of an answer or result not in the Context yet, shown before the block `before` (null: at the end).
// A proposal has its own title, heading and, once counted, tokens.
export type Live = { id: number; kind: Kind; content: string; before: number | null; title?: string; heading?: string; tokens?: number };
// What accepting the proposal changes: tokens and Context (over: not below the window), and the cache.
export type Review = { tokens: string; over: boolean; cache: string; cold: boolean };
// Compaction under way (FR-13–FR-17): the instruction being written, the proposal streaming, or under review.
export type Compaction = Compactor & {
  sources: number[];
  // Runs on the session's backend (same model/slot), which leaves the session cache cold.
  same: boolean;
  phase: 'instruction' | 'running' | 'review';
  attempt: number;
  instruction: string;
  // What the instruction line shows when it opens again: the draft of the last run.
  draft: string;
  text: string;
  abort: AbortController | null;
  // Tokens of the request with the instruction being written.
  request: number | null;
  // The proposal counted in the Context: the Note's tokens and the Context total.
  after: { note: number; total: number } | null;
};

// Undone operations whose event type does not read as one.
const UNDONE: Partial<Record<SessionEvent['type'], string>> = { PairToNote: 'Tool Pair → Note' };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const APPROVE = 'y run once · a allow for session · n reject · e edit';
// The prediction checked against the server (FR-41); a server reusing more than predicted is harmless.
const cacheMiss = ({ predicted, cached }: ChatResult) =>
  predicted !== null && cached !== null && cached < predicted ? `cache: predicted ${predicted} · server reused ${cached}` : null;

export function createGate({ log, reconnect, openSessions, runner, approval, editor, clipboard, project, instruction = () => compaction.DEFAULT_INSTRUCTION, compactor = async () => null, ...options }: GateOptions) {
  const [events, setEvents] = createSignal(options.events);
  const [counted, setCounted] = createSignal<{ prefixes: Request[]; split: Counted } | null>(null);
  const [streaming, setStreaming] = createSignal<Streaming | null>(null);
  const [running, setRunning] = createSignal<Running | null>(null);
  const [status, setStatus] = createSignal<Status | null>(withHint(options.notice ?? null, ignoredHint(approval)));
  const [selected, setSelected] = createSignal(1);
  // Marked blocks (Space) for Compaction; UI state, not logged.
  const [marked, setMarked] = createSignal<ReadonlySet<number>>(new Set());
  const [backend, setBackend] = createSignal(options.backend);
  // Moving or pinning a Tool Pair asks first: the operation and block awaiting the same key again (FR-9).
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [compacting, setCompacting] = createSignal<Compaction | null>(null);
  // Bumped when the server's cache changed without a new request to count (a Compaction on its slot).
  const [recount, setRecount] = createSignal(0);
  // Bumped when a referenced file may have changed (edited via `e`): the Gate shows it as it is now.
  const [reread, setReread] = createSignal(0);

  const append = (event: SessionEvent) => {
    log.append(event);
    setEvents([...events(), event]);
  };
  // Unread @path references show the file as it would be read now; only sending reads them (FR-27).
  const context = createMemo(() => {
    reread();
    return peekReferences(fold(events()), project.read);
  });
  const sent = createMemo(() => sentBlocks(context()));
  // An unchanged request (e.g. after a rename) keeps the memo value, so nothing is recounted.
  const prefixes = createMemo(() => renderPrefixes(context()), [], { equals: same });
  const request = () => prefixes().at(-1)!;
  // Token split of the current request only; a stale split would misalign rows after a move.
  const split = () => (counted()?.prefixes === prefixes() ? counted()!.split : null);
  // Per sent block, in Context order: still in the server's prefix cache (FR-3).
  const warm = createMemo(() => (split() ? warmRows(split()!.blocks, split()!.cached.tokens) : null));
  const nextId = () => context().nextId;
  // Messages right after the last answer; a Context changed since then may be sent again as is.
  const lastAnswer = createMemo(() => {
    const last = events().findLastIndex(e => e.type === 'ResponseReceived');
    return last < 0 ? null : renderNative(fold(events().slice(0, last + 1)));
  });
  // The streaming answer (its reasoning first) sits before the bottom pins; a running call's result where it will be added.
  const live = createMemo((): Live[] => {
    const c = compacting();
    if (c && c.phase !== 'instruction') return [proposalRow(c)];
    const s = streaming();
    if (s) return streamingRows(s);
    const r = running();
    const blocks = context().blocks;
    return r ? [{ id: nextId(), kind: 'Tool Result', content: r.output, before: blocks[afterCalls(blocks, r.call.id)]?.id ?? null }] : [];
  });
  // The ids the answer's blocks get: a Thinking block first (FR-46).
  function streamingRows({ thinking, text }: Streaming): Live[] {
    const before = sent().find(b => b.pin === 'bottom')?.id ?? null;
    const reasoning: Live[] = thinking ? [{ id: nextId(), kind: 'Thinking', content: thinking, before }] : [];
    const answer: Live[] = text || !thinking ? [{ id: nextId() + reasoning.length, kind: 'Assistant', content: text, before }] : [];
    return [...reasoning, ...answer];
  }
  // Selectable rows in order: sent blocks and the live rows.
  const rows = createMemo(() => {
    const ids = sent().map(b => b.id);
    for (const l of live()) {
      const at = l.before === null ? -1 : ids.indexOf(l.before);
      ids.splice(at < 0 ? ids.length : at, 0, l.id);
    }
    return ids;
  });
  const selectedBlock = (): Block | undefined => sent().find(b => b.id === selected());
  const selectAt = (i: number) => setSelected(rows()[Math.max(0, Math.min(rows().length - 1, i))]!);
  const keepSelection = () => rows().includes(selected()) || selectAt(rows().length - 1);

  createEffect(() => {
    recount();
    const current = prefixes();
    backend().count(current).then(
      s => prefixes() === current && setCounted({ prefixes: current, split: s }),
      e => setStatus({ text: String(e), tone: 'error' }),
    );
  });

  // The environment Note, refreshed when the environment changed (FR-28).
  function refresh() {
    const edit = refreshEnvironment(events(), context(), project.environment());
    if (edit) append(edit);
  }
  refresh();

  // On send: the references are read into snapshots, a missing file aborts (FR-27); the environment is refreshed.
  function prepare(): boolean {
    const read = readReferences(context(), project.read);
    if ('error' in read) {
      setSelected(read.id);
      setStatus({ text: `${read.error} – sending aborted`, tone: 'error' });
      return false;
    }
    read.events.forEach(append);
    refresh();
    return true;
  }

  function addUser(content: string) {
    const id = nextId();
    append({ type: 'BlockAdded', id, kind: 'User', origin: 'user', content });
    setSelected(id);
  }

  // Appends the operation's event, or shows why not (FR-10, NFR-3). Returns whether it was applied.
  function apply(result: ops.Outcome): boolean {
    if ('error' in result) setStatus({ text: result.error, tone: 'info' });
    else append(result.event);
    return !('error' in result);
  }
  // A Context operation on the selected block; `describe` gives the status line text afterwards.
  function operate(operation: (block: Block) => ops.Outcome, describe: (block: Block) => string | null) {
    const block = selectedBlock();
    if (!block || !apply(operation(block))) return;
    const text = describe(block);
    setStatus(text ? { text, tone: 'info' } : null);
  }

  // A Tool Pair is moved or pinned as a Note: the first press asks, the same key again converts it,
  // then the operation acts on the Note (FR-9). `action` names the operation, `key` its key.
  function viaNote(action: string, key: string, then: () => void) {
    const block = selectedBlock();
    if (!block || !ops.inPair(block)) return then();
    const asked = `${action} ${block.id}`;
    if (confirming() !== asked) {
      setConfirming(asked);
      return setStatus({ text: `⇄ This turns the Tool Pair into a Note – press ${key} again to confirm, any other key cancels`, tone: 'warn' });
    }
    setConfirming(null);
    const id = nextId();
    if (!apply(ops.toNote(block, id))) return;
    setSelected(id);
    then();
  }
  const PINNED = { top: 'pinned ⤒ top', bottom: 'pinned ⤓ bottom (sent as user-role Note at the end)' };
  const move = (dir: -1 | 1) => viaNote(`move ${dir}`, dir < 0 ? '⌥↑' : '⌥↓', () => operate(b => ops.move(context(), b, dir), () => null));
  // A block as it is now, after an operation.
  const blockOf = (id: number) => context().blocks.find(b => b.id === id)!;
  const pinned = ({ pin }: Block) => (pin ? PINNED[pin] : 'unpinned');
  const pin = () => viaNote('pin', 'p', () => operate(ops.pin, b => pinned(blockOf(b.id))));
  const whole = (b: Block) => (ops.inPair(b) ? ' (whole Tool Pair)' : '');
  function remove() {
    const at = rows().indexOf(selected());
    operate(ops.remove, b => `removed${whole(b)} · struck through until sent · u = undo`);
    setMarked(new Set([...marked()].filter(id => sent().some(b => b.id === id))));
    selectAt(at);
  }
  function undo() {
    const result = ops.undo(events());
    if ('error' in result) return apply(result);
    const { type } = events()[result.event.eventId]!;
    apply(result);
    keepSelection();
    setStatus({ text: `undone: ${UNDONE[type] ?? type.toLowerCase()} (counter-event in Session Log)`, tone: 'info' });
  }
  const edited = (b: Block) => `edited → revision ${b.revision} · u = undo`;
  // e: the selected block in $EDITOR; a changed save becomes a new Revision (FR-8). Checked first: a
  // block that cannot be edited is not opened.
  async function editBlock() {
    const block = selectedBlock();
    const error = block ? ops.editable(block) : null;
    if (!block || error) return error && setStatus({ text: error, tone: 'info' });
    try {
      const text = await editor(block.content);
      operate(b => ops.edit(events(), b, text), b => edited(blockOf(b.id)));
      // A pending call edited is decided again by the rules (FR-23).
      if (block.pending && blockOf(block.id).revision !== block.revision) advance([edited(blockOf(block.id))]);
    } catch (e) {
      setStatus({ text: `editor failed: ${errorText(e)} – unchanged`, tone: 'error' });
    }
  }
  // On an unread @path reference, e opens the file itself (FR-27).
  const edit = () => (selectedBlock()?.unread ? openReference(selectedBlock()!) : editBlock());
  // The file of an unread @path reference in $EDITOR; it is read on send.
  async function openReference(block: Block) {
    const { path } = parseReference(block.file!);
    try {
      await project.open(path);
      setReread(reread() + 1);
      setStatus({ text: `${path} – read at send`, tone: 'info' });
    } catch (e) {
      setStatus({ text: `editor failed: ${errorText(e)}`, tone: 'error' });
    }
  }
  // Text selected with the mouse, copied on release.
  const copy = (text: string) => clipboard(text).then(() => setStatus({ text: `copied ${text.length} chars`, tone: 'info' }));
  // A Tool Pair is marked as a whole: it is compacted only as a whole (FR-9); a pending Tool Call not at all.
  function toggleMark() {
    const block = selectedBlock();
    if (!block || ops.isFixed(block) || block.pending) return;
    const pair = pairOf(context().blocks, block.id);
    const on = !marked().has(block.id);
    setMarked(new Set([...marked()].filter(id => !pair.includes(id)).concat(on ? pair : [])));
  }

  // The status line after an answer without calls to decide on: how it ended.
  function answerStatus(result: ChatResult, notRun: string | null): Status {
    const whileThinking = result.content || result.calls.length || !result.thinking ? '' : ' while thinking';
    if (result.finish === 'aborted') return { text: `⚠ aborted${whileThinking} – partial answer kept (cut off)`, tone: 'warn' };
    if (result.finish === 'length') return { text: `⚠ cut off at max_tokens${whileThinking}`, tone: 'warn' };
    if (notRun) return { text: notRunText(notRun), tone: 'warn' };
    return { text: 'answer complete', tone: 'ok' };
  }

  // The answer's text and Tool Calls become blocks; its calls are decided by the rules.
  function finish(result: ChatResult) {
    const { events, notRun } = answerBlocks(result, nextId());
    events.forEach(append);
    held = !!notRun;
    append({ type: 'ResponseReceived', usage: result.usage, cached: result.cached });
    const miss = cacheMiss(result);
    if (ops.nextCall(context())) return advance([notRun && notRunText(notRun), miss && `⚠ ${miss}`].filter((n): n is string => !!n));
    const status = answerStatus(result, notRun);
    setStatus(miss ? { text: `${status.text} · ⚠ ${miss}`, tone: 'warn' } : status);
  }

  // Tool Approval (FR-22–FR-25) ----------------------------------------------------------------------------
  // The rules for a call: built-in, global and project rules, then the ones allowed for this session; last match wins.
  const rules = () => [...approval.permissions().rules, ...sessionAllowed(events())];
  const verdictOf = (call: Block): Verdict => evaluate(call.content, { rules: rules(), split: approval.split, root: approval.root });

  // Whether the answer's calls leave the results for review at the Gate: one was not run (rejected, denied, not a
  // bash call) or was stopped (killed, timeout). Otherwise, once every call ran, the results are sent (FR-23).
  let held = false;

  // Decides the pending calls in order (FR-24): an allowed one runs, a denied one is answered "denied by rule", the
  // first to ask for is selected. Then the results are sent, or held at the Gate. notes: what happened so far.
  function advance(notes: string[] = []) {
    for (let call = ops.nextCall(context()); call; call = ops.nextCall(context())) {
      const { action } = verdictOf(call);
      if (action === 'allow') return void run(call, notes);
      if (action === 'ask') {
        setSelected(call.id);
        return setStatus({ text: [...notes, `? approve – ${APPROVE}`].join(' · '), tone: 'warn' });
      }
      setSelected(nextId());
      held = true;
      apply(ops.deny(context(), call, nextId()));
      notes = [...notes, `⚠ denied by rule: ${titleOf(call)}`];
    }
    if (!held) return void send();
    setStatus({ text: `${notes.join(' · ') || 'tool loop paused'} – review the results, Enter sends`, tone: notes.length ? 'warn' : 'ok' });
  }

  // Runs the call (FR-21); its output streams into a live Tool Result row, then the next call is decided.
  async function run(call: Block, notes: string[]) {
    const abort = new AbortController();
    setRunning({ call, output: '', started: Date.now(), abort });
    setSelected(nextId());
    setStatus(null);
    try {
      const onOutput = (text: string) => setRunning({ ...running()!, output: running()!.output + text });
      const result = await runner.run(call.content, { signal: abort.signal, onOutput });
      setRunning(null);
      setSelected(nextId());
      append(ops.toolResult(call, nextId(), result, runner.timeout));
      if (result.stopped) held = true;
      advance(result.stopped ? [...notes, `⚠ ${result.stopped}`] : notes);
    } catch (e) {
      setRunning(null);
      setSelected(call.id);
      setStatus({ text: `bash failed: ${errorText(e)}`, tone: 'error' });
    }
  }

  // The selected Tool Call, if it may be decided on now.
  function decidable(): Block | null {
    const block = selectedBlock();
    const error = block ? ops.approvable(context(), block) : 'not awaiting approval';
    if (error) setStatus({ text: error, tone: 'info' });
    return error ? null : block!;
  }

  // y: run the call once – unless a rule denies it by now (/reload).
  function approve() {
    const call = decidable();
    if (call) void (verdictOf(call).action === 'deny' ? advance() : run(call, []));
  }

  // a: allow the call's command prefixes for the session (FR-23, FR-25) – the preview shows them beforehand; they
  // are saved as Session Log events, then the call runs as allowed.
  function allowForSession() {
    const call = decidable();
    if (!call) return;
    const found = sessionRules(verdictOf(call));
    if ('error' in found) return setStatus({ text: found.error, tone: 'info' });
    for (const pattern of found.patterns) append({ type: 'AllowRuleAdded', pattern });
    advance([`allowed for session: ${quoted(found.patterns)}`]);
  }

  // n: not run; the result says "rejected by user" (FR-23).
  function reject() {
    const call = decidable();
    if (!call) return;
    held = true;
    setSelected(nextId());
    if (apply(ops.reject(context(), call, nextId()))) advance();
  }

  // Why the Context cannot be sent now, or null: calls await approval, or the model has answered
  // and nothing changed since.
  function unsendable(): Status | null {
    const pending = ops.nextCall(context());
    if (pending) setSelected(pending.id);
    if (pending) return { text: `Tool Calls await approval – ${APPROVE} on the ? approve row`, tone: 'warn' };
    const changed = lastAnswer() !== null && !same(lastAnswer(), request());
    // The last unpinned block: a User message, a Tool Result or a Note (e.g. an @path reference) asks for an answer.
    const last = sent().filter(b => !b.pin).at(-1)?.kind;
    return changed || last === 'User' || last === 'Tool Result' || last === 'Note' ? null : { text: 'nothing to send – Tab to write', tone: 'info' };
  }

  async function send() {
    if (streaming() || running()) return;
    const blocked = unsendable();
    if (blocked) {
      setStatus(blocked);
      return;
    }
    if (!prepare()) return;
    const requested = prefixes();
    const payload = requested.at(-1)!;
    const abort = new AbortController();
    setStreaming({ thinking: '', text: '', abort });
    setStatus(null);
    try {
      const { total } = await backend().count(requested);
      if (abort.signal.aborted) {
        setStreaming(null);
        setStatus({ text: 'send cancelled', tone: 'info' });
        return;
      }
      append({ type: 'RequestSent', hash: Bun.hash(JSON.stringify(payload)).toString(16), tokens: total });
      setMarked(new Set<number>());
      setSelected(nextId());
      const onThinking = (d: string) => setStreaming({ ...streaming()!, thinking: streaming()!.thinking + d });
      // The answer follows its reasoning: the selection moves on with it.
      const onDelta = (d: string) => {
        const { thinking, text } = streaming()!;
        if (thinking && !text && selected() === nextId()) setSelected(nextId() + 1);
        setStreaming({ ...streaming()!, text: text + d });
      };
      const result = await backend().chat(payload, { signal: abort.signal, onDelta, onThinking });
      setStreaming(null);
      finish(result);
    } catch (e) {
      setStreaming(null);
      setStatus({ text: `backend error: ${errorText(e)}`, tone: 'error' });
    }
    keepSelection();
  }

  // Compaction (FR-13–FR-17) ------------------------------------------------------------------------------
  const tokensOf = (ids: number[]) => (split() ? ids.reduce((sum, id) => sum + split()!.blocks[sent().findIndex(b => b.id === id)]!, 0) : null);
  const update = (change: Partial<Compaction>) => setCompacting({ ...compacting()!, ...change });
  // The proposal row goes before the first source, so each source's row number is one more than its place.
  function proposalRow(c: Compaction): Live {
    const numbers = c.sources.map(id => `#${sent().findIndex(b => b.id === id) + 2}`).join(' ');
    const heading = `◇ proposal · attempt ${c.attempt} · replaces ${numbers} · "${c.instruction}"`;
    return { id: nextId(), kind: 'Note', content: c.text, before: c.sources[0]!, title: `◇ proposal · ${count(c.sources.length, 'block')} · attempt ${c.attempt}`, heading, ...(c.after && { tokens: c.after.note }) };
  }

  // c: the marked blocks, else the selected one, are compacted; first the instruction is written.
  async function startCompaction() {
    const found = compaction.sourcesOf(context(), marked(), selected());
    if ('error' in found) return setStatus({ text: found.error, tone: 'info' });
    try {
      const own = await compactor();
      const on = own ?? { profile: context().profile, backend: backend() };
      setCompacting({ ...on, sources: found.sources, same: !own, phase: 'instruction', attempt: 0, instruction: '', draft: '', text: '', abort: null, request: null, after: null });
      setStatus(null);
    } catch (e) {
      setStatus({ text: `compaction profile: ${errorText(e)}`, tone: 'error' });
    }
  }
  const instructionOf = (draft: string) => draft.trim() || instruction();
  const requestOf = (c: Compaction, draft: string) => compaction.compactionRequest(context(), c.sources, instructionOf(draft));
  // The request with the instruction being written, counted for the header (FR-13); only the latest counts.
  let measuring = '';
  async function measure(draft: string) {
    const c = compacting();
    if (!c) return;
    measuring = draft;
    const { total } = await c.backend.count([requestOf(c, draft)]).catch(() => ({ total: null }));
    if (measuring === draft && compacting()) update({ request: total });
  }

  // Enter on the instruction: a new run from the sources, unless the request does not fit the window (FR-14).
  // The instruction line closes at once: the run starts with counting.
  async function runCompaction(draft: string) {
    const c = compacting()!;
    const request = requestOf(c, draft);
    const abort = new AbortController();
    update({ phase: 'running', draft, abort });
    setStatus(null);
    try {
      if (await fits(c, request)) await propose(c, request, draft, abort);
    } catch (e) {
      endCompaction({ text: `compaction failed: ${errorText(e)}`, tone: 'error' });
    } finally {
      // The server's cache now holds the compaction request (FR-17).
      if (c.same) setRecount(recount() + 1);
    }
  }
  // Too big for the window of the Compaction's Model Profile: back to the instruction, no chunking (FR-14).
  async function fits(c: Compaction, request: Request) {
    const { total } = await c.backend.count([request]);
    if (total < c.backend.window) return true;
    update({ phase: 'instruction', abort: null });
    setStatus({ text: `compaction request ${formatTokens(total)} ≥ window ${formatTokens(c.backend.window)} of ${c.profile} – shrink the selection (Esc, then d / e)`, tone: 'error' });
    return false;
  }
  // The proposal streams into its row; Esc aborts, also while the request is still counted.
  async function propose(c: Compaction, request: Request, draft: string, abort: AbortController) {
    const aborted = () => endCompaction({ text: 'compaction aborted – Context unchanged', tone: 'info' });
    if (abort.signal.aborted) return aborted();
    update({ attempt: c.attempt + 1, instruction: instructionOf(draft), text: '', after: null });
    setSelected(nextId());
    const onDelta = (d: string) => update({ text: compacting()!.text + d });
    const result = await c.backend.chat(request, { signal: abort.signal, onDelta });
    if (result.finish === 'aborted') return aborted();
    update({ phase: 'review', abort: null });
    if (result.finish === 'length') setStatus({ text: '⚠ proposal cut off at max_tokens', tone: 'warn' });
    await countProposal();
  }
  function endCompaction(status: Status) {
    const c = compacting();
    setCompacting(null);
    if (c && !context().blocks.some(b => b.id === selected())) setSelected(c.sources[0]!);
    keepSelection();
    setStatus(status);
  }
  // The Context as it would be after accept, counted: the Note's tokens and the Context total (FR-15).
  async function countProposal() {
    const c = compacting()!;
    const after = fold([...events(), { type: 'Compact', sources: c.sources, instruction: c.instruction, noteId: nextId(), content: c.text }]);
    const counted = await backend().count(renderPrefixes(after)).catch(() => null);
    const note = sentBlocks(after).findIndex(b => b.id === nextId());
    if (counted && compacting()?.text === c.text) update({ after: { note: counted.blocks[note]!, total: counted.total } });
  }
  // Under review: tokens before → after and the Context after accept; the cache effect (FR-15, FR-17).
  function review(c: Compaction): Review | null {
    const before = tokensOf(c.sources);
    if (!c.after || before === null) return null;
    const saved = compaction.reduction(before, c.after.note);
    const change = saved < 0 ? `+${-saved}%` : `−${saved}%`;
    const window = backend().window;
    const context = `Context ${formatTokens(split()!.total)} → ${formatTokens(c.after.total)} / ${formatTokens(window)}`;
    const session = c.same ? 'session cache cold (same model/slot)' : 'session cache untouched';
    return { tokens: `${formatTokens(before)} → ${formatTokens(c.after.note)} tok (${change}) · ${context}`, over: c.after.total >= window, cache: `${session} · cold from #${rows().indexOf(nextId()) + 1} after accept`, cold: c.same };
  }

  function acceptCompaction() {
    const c = compacting()!;
    const id = nextId();
    const before = tokensOf(c.sources);
    if (!apply(compaction.accept(c.sources, c.instruction, id, c.text))) return;
    setCompacting(null);
    setMarked(new Set<number>());
    setSelected(id);
    setStatus({ text: `◇ accepted: ${before ?? '?'} → ${c.after?.note ?? '?'} tok · u = undo`, tone: 'ok' });
  }
  // i: the instruction again, the last one to change; Esc there returns to the proposal.
  const refine = () => update({ phase: 'instruction' });
  function leaveInstruction() {
    const c = compacting()!;
    if (c.attempt) update({ phase: 'review' });
    else endCompaction({ text: 'compaction cancelled', tone: 'info' });
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

  async function reload() {
    try {
      setBackend(await reconnect());
      setStatus(withHint({ text: 'config reloaded', tone: 'ok' }, ignoredHint(approval)));
    } catch (e) {
      setStatus({ text: `reload failed: ${errorText(e)}`, tone: 'error' });
    }
  }

  function renameSession(title: string) {
    append({ type: 'SessionRenamed', title });
    setStatus({ text: title ? `session renamed: ${title}` : 'session title reset to the first User message', tone: 'info' });
  }

  const commands: Record<CommandName, (arg: string) => void> = { '/sessions': openSessions, '/rename': renameSession, '/reload': () => void reload() };
  // Input text: a known command runs with the rest as argument; an unknown `/word` is an error; anything else becomes
  // a User block and is sent right away – if sending is blocked, the block stays and the status says why (FR-6).
  function submit(text: string) {
    const name = text.trim().split(/\s/)[0]!;
    if (name in commands) commands[name as CommandName](text.trim().slice(name.length).trim());
    else if (/^\/\w+$/.test(name)) setStatus({ text: `unknown command ${name} – ${COMMANDS.map(c => c.name).join(' ')}`, tone: 'error' });
    else if (text.trim()) addInput(text);
  }
  // `@path` references become rows of their own before the text; only a text is sent right away (FR-27).
  function addInput(input: string) {
    const { files, text } = references(input);
    for (const file of files) {
      const id = nextId();
      append({ type: 'FileReferenced', id, file });
      setSelected(id);
    }
    if (text) {
      addUser(text);
      void send();
    } else setStatus({ text: `${count(files.length, 'file reference')} added – read at send · e opens the file · Enter sends`, tone: 'info' });
  }

  // Calls still pending when the Gate opens (resume) are decided like fresh ones.
  if (ops.nextCall(context())) queueMicrotask(() => advance(status() ? [status()!.text] : []));

  return {
    context,
    sent,
    split,
    streaming,
    running,
    live,
    // Streaming or running: only Esc (abort, kill) acts.
    nextCall: () => ops.nextCall(context()),
    busy: () => streaming() !== null || running() !== null || compacting()?.phase === 'running',
    timeout: runner.timeout,
    status,
    rows,
    selected,
    selectedBlock,
    marked,
    window: () => backend().window,
    // Whether a sent block is still cached; null while counting.
    warm: (id: number) => warm()?.[sent().findIndex(b => b.id === id)] ?? null,
    profile: () => context().profile,
    submit,
    send,
    abort: () => (streaming() ?? running() ?? compacting())?.abort?.abort(),
    compacting,
    sourceTokens: () => (compacting() ? tokensOf(compacting()!.sources) : null),
    review: () => (compacting()?.phase === 'review' ? review(compacting()!) : null),
    defaultInstruction: instruction,
    startCompaction: () => void startCompaction(),
    measure: (draft: string) => void measure(draft),
    runCompaction: (draft: string) => void runCompaction(draft),
    acceptCompaction,
    discardCompaction: () => endCompaction({ text: 'proposal discarded – Context unchanged', tone: 'info' }),
    refine,
    leaveInstruction,
    editProposal: () => void editProposal(),
    approve,
    allowForSession,
    reject,
    // Why the rules ask for a pending call, per sub-command (FR-22); null for any other block.
    verdict: (block: Block): Verdict | null => (block.pending ? verdictOf(block) : null),
    select: (delta: number) => selectAt(rows().indexOf(selected()) + delta),
    move,
    pin,
    remove,
    undo,
    edit: () => void edit(),
    copy: (text: string) => void copy(text),
    toggleMark,
    // Any other key than the one asked for cancels the confirmation.
    cancelConfirm: () => {
      if (confirming()) setStatus(null);
      setConfirming(null);
    },
    clearMarks: () => setMarked(new Set<number>()),
    dismiss: () => setStatus(null),
  };
}

export type Gate = ReturnType<typeof createGate>;

// Project config may only tighten: its allow entries are ignored, and the Gate says so (FR-25).
function ignoredHint(approval: Approval): string | null {
  const { ignored } = approval.permissions();
  return ignored.length ? `project config: allow ${quoted(ignored)} ignored (project config may only tighten)` : null;
}
const notRunText = (why: string) => `⚠ tool call not run: ${why}`;
const withHint = (status: Status | null, hint: string | null): Status | null =>
  hint ? { text: status ? `${status.text} · ${hint}` : hint, tone: 'warn' } : status;

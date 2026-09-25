// Review Gate state: the Session Log in memory, Context = fold(events), token split, streaming answer.
import { createEffect, createMemo, createSignal } from 'solid-js';
import type { Clipboard } from '../adapters/clipboard/clipboard';
import type { Backend, ChatResult, Counted } from '../core/backend';
import { warmRows } from '../core/cache/cache';
import * as ops from '../core/context/operations';
import type { Kind, SessionEvent, SessionLog } from '../core/log/events';
import { afterCalls, fold, pairOf, type Block } from '../core/log/fold';
import { renderNative, renderPrefixes, sentBlocks, type Request } from '../core/render/native';
import { answerBlocks } from '../core/toolcall/answer';
import type { Runner } from '../core/toolcall/bash';
import { errorText } from './format';

export type Status = { text: string; tone: 'info' | 'ok' | 'warn' | 'error' };
// events: the Session Log so far (new or resumed); reconnect: re-reads the config and opens the session's
// Model Profile again (/reload, FR-44); openSessions: shows /sessions; notice: initial status line.
// runner: runs approved bash calls (FR-21); editor: $EDITOR for `e` (FR-8); clipboard: copy on select.
export type GateOptions = {
  backend: Backend;
  runner: Runner;
  editor: ops.Editor;
  clipboard: Clipboard;
  log: SessionLog;
  events: SessionEvent[];
  reconnect: () => Promise<Backend>;
  openSessions: () => void;
  notice?: Status;
};

// Slash commands (FR-6), in suggestion order.
export const COMMANDS = [
  { name: '/sessions', arg: '', description: 'list, resume, rename, delete sessions' },
  { name: '/rename', arg: '<title>', description: 'rename session' },
  { name: '/reload', arg: '', description: 're-read config' },
] as const;
type CommandName = (typeof COMMANDS)[number]['name'];
// In-flight answer; never persisted until complete or aborted (FR-37).
export type Streaming = { text: string; abort: AbortController };
// Approved Tool Call running; its output so far is shown, the result is logged when it ends.
export type Running = { call: Block; output: string; started: number; abort: AbortController };
// The row of an answer or result not in the Context yet, shown before the block `before` (null: at the end).
export type Live = { id: number; kind: Kind; content: string; before: number | null };

// Undone operations whose event type does not read as one.
const UNDONE: Partial<Record<SessionEvent['type'], string>> = { PairToNote: 'Tool Pair → Note' };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const APPROVE = 'y run once · n reject · e edit';
// The prediction checked against the server (FR-41); a server reusing more than predicted is harmless.
const cacheMiss = ({ predicted, cached }: ChatResult) =>
  predicted !== null && cached !== null && cached < predicted ? `cache: predicted ${predicted} · server reused ${cached}` : null;

export function createGate({ log, reconnect, openSessions, runner, editor, clipboard, ...options }: GateOptions) {
  const [events, setEvents] = createSignal(options.events);
  const [counted, setCounted] = createSignal<{ prefixes: Request[]; split: Counted } | null>(null);
  const [streaming, setStreaming] = createSignal<Streaming | null>(null);
  const [running, setRunning] = createSignal<Running | null>(null);
  const [status, setStatus] = createSignal<Status | null>(options.notice ?? null);
  const [selected, setSelected] = createSignal(1);
  // Marked blocks (Space) for Compaction; UI state, not logged.
  const [marked, setMarked] = createSignal<ReadonlySet<number>>(new Set());
  const [backend, setBackend] = createSignal(options.backend);
  // Moving or pinning a Tool Pair asks first: the operation and block awaiting the same key again (FR-9).
  const [confirming, setConfirming] = createSignal<string | null>(null);

  const append = (event: SessionEvent) => {
    log.append(event);
    setEvents([...events(), event]);
  };
  const context = createMemo(() => fold(events()));
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
  // The streaming answer sits before the bottom pins; a running call's result where it will be added.
  const live = createMemo((): Live | null => {
    const s = streaming();
    if (s) return { id: nextId(), kind: 'Assistant', content: s.text, before: sent().find(b => b.pin === 'bottom')?.id ?? null };
    const r = running();
    const blocks = context().blocks;
    return r && { id: nextId(), kind: 'Tool Result', content: r.output, before: blocks[afterCalls(blocks, r.call.id)]?.id ?? null };
  });
  // Selectable rows in order: sent blocks and the live row.
  const rows = createMemo(() => {
    const ids = sent().map(b => b.id);
    const l = live();
    if (!l) return ids;
    const at = l.before === null ? -1 : ids.indexOf(l.before);
    ids.splice(at < 0 ? ids.length : at, 0, l.id);
    return ids;
  });
  const selectedBlock = (): Block | undefined => sent().find(b => b.id === selected());
  const selectAt = (i: number) => setSelected(rows()[Math.max(0, Math.min(rows().length - 1, i))]!);
  const keepSelection = () => rows().includes(selected()) || selectAt(rows().length - 1);

  createEffect(() => {
    const current = prefixes();
    backend().count(current).then(
      s => prefixes() === current && setCounted({ prefixes: current, split: s }),
      e => setStatus({ text: String(e), tone: 'error' }),
    );
  });

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
  const rename = (title: string) =>
    operate(b => ops.rename(b, title), () => (title.trim() ? 'renamed (display only – Context and cache unchanged)' : 'title reset'));
  const edited = (b: Block) => `edited → revision ${b.revision} · u = undo`;
  // e: the selected block in $EDITOR; a changed save becomes a new Revision (FR-8). Checked first: a
  // block that cannot be edited is not opened.
  async function edit() {
    const block = selectedBlock();
    const error = block ? ops.editable(block) : null;
    if (!block || error) return error && setStatus({ text: error, tone: 'info' });
    try {
      const text = await editor(block.content);
      operate(b => ops.edit(events(), b, text), b => edited(blockOf(b.id)));
    } catch (e) {
      setStatus({ text: `editor failed: ${errorText(e)} – unchanged`, tone: 'error' });
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

  // The status line for the Tool Call to decide on next (FR-23); the call itself is in the preview.
  const askFor = (): Status => ({ text: `? approve – ${APPROVE}`, tone: 'warn' });

  // The status line after an answer: how it ended, else the call to decide on next.
  function answerStatus(result: ChatResult, notRun: string | null, next: Block | undefined): Status {
    if (result.finish === 'aborted') return { text: '⚠ aborted – partial answer kept (cut off)', tone: 'warn' };
    if (result.finish === 'length') return { text: '⚠ cut off at max_tokens', tone: 'warn' };
    if (notRun) return { text: `⚠ tool call not run: ${notRun}`, tone: 'warn' };
    return next ? askFor() : { text: 'answer complete', tone: 'ok' };
  }

  // The answer's text and Tool Calls become blocks; the first call to decide on is selected.
  function finish(result: ChatResult) {
    const { events, notRun } = answerBlocks(result, nextId());
    events.forEach(append);
    append({ type: 'ResponseReceived', usage: result.usage, cached: result.cached });
    const next = ops.nextCall(context());
    if (next) setSelected(next.id);
    const status = answerStatus(result, notRun, next);
    const miss = cacheMiss(result);
    setStatus(miss ? { text: `${status.text} · ⚠ ${miss}`, tone: 'warn' } : status);
  }

  // After a decision: the next call awaiting approval, else back at the Gate – approval never sends (FR-23).
  function decided(result: Block) {
    const next = ops.nextCall(context());
    setSelected(next?.id ?? result.id);
    const ended = result.stopped ? `⚠ ${result.stopped}` : null;
    if (next) setStatus(ended ? { text: `${ended} · ${askFor().text}`, tone: 'warn' } : askFor());
    else setStatus({ text: `${ended ?? 'tool loop paused'} – review the results, Enter sends`, tone: ended ? 'warn' : 'ok' });
  }
  const resultOf = (call: Block) => context().blocks.find(b => b.call === call.id)!;
  // The selected Tool Call, if it may be decided on now.
  function decidable(): Block | null {
    const block = selectedBlock();
    const error = block ? ops.approvable(context(), block) : 'not awaiting approval';
    if (error) setStatus({ text: error, tone: 'info' });
    return error ? null : block!;
  }

  // y: run the call once (FR-21); its output streams into a live Tool Result row.
  async function approve() {
    const call = decidable();
    if (!call) return;
    const abort = new AbortController();
    setRunning({ call, output: '', started: Date.now(), abort });
    setSelected(nextId());
    setStatus(null);
    try {
      const onOutput = (text: string) => setRunning({ ...running()!, output: running()!.output + text });
      const run = await runner.run(call.content, { signal: abort.signal, onOutput });
      setRunning(null);
      append(ops.toolResult(call, nextId(), run, runner.timeout));
      decided(resultOf(call));
    } catch (e) {
      setRunning(null);
      setSelected(call.id);
      setStatus({ text: `bash failed: ${errorText(e)}`, tone: 'error' });
    }
  }

  // n: not run; the result says "rejected by user" (FR-23).
  function reject() {
    const call = decidable();
    if (call && apply(ops.reject(context(), call, nextId()))) decided(resultOf(call));
  }

  // Why the Context cannot be sent now, or null: calls await approval, or the model has answered
  // and nothing changed since.
  function unsendable(): Status | null {
    const pending = ops.nextCall(context());
    if (pending) setSelected(pending.id);
    if (pending) return { text: `Tool Calls await approval – ${APPROVE} on the ? approve row`, tone: 'warn' };
    const changed = lastAnswer() !== null && !same(lastAnswer(), request());
    const last = sent().filter(b => b.pin !== 'bottom').at(-1)?.kind;
    return changed || last === 'User' || last === 'Tool Result' ? null : { text: 'nothing to send – Tab to write', tone: 'info' };
  }

  async function send() {
    if (streaming() || running()) return;
    const blocked = unsendable();
    if (blocked) {
      setStatus(blocked);
      return;
    }
    const requested = prefixes();
    const payload = requested.at(-1)!;
    const abort = new AbortController();
    setStreaming({ text: '', abort });
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
      const onDelta = (d: string) => setStreaming({ text: streaming()!.text + d, abort });
      const result = await backend().chat(payload, { signal: abort.signal, onDelta });
      setStreaming(null);
      finish(result);
    } catch (e) {
      setStreaming(null);
      setStatus({ text: `backend error: ${errorText(e)}`, tone: 'error' });
    }
    keepSelection();
  }

  async function reload() {
    try {
      setBackend(await reconnect());
      setStatus({ text: 'config reloaded', tone: 'ok' });
    } catch (e) {
      setStatus({ text: `reload failed: ${errorText(e)}`, tone: 'error' });
    }
  }

  function renameSession(title: string) {
    append({ type: 'SessionRenamed', title });
    setStatus({ text: title ? `session renamed: ${title}` : 'session title reset to the first User message', tone: 'info' });
  }

  const commands: Record<CommandName, (arg: string) => void> = { '/sessions': openSessions, '/rename': renameSession, '/reload': () => void reload() };
  // Input text: a known command runs with the rest as argument; an unknown `/word` is an error; anything else becomes a User block.
  function submit(text: string) {
    const name = text.trim().split(/\s/)[0]!;
    if (name in commands) commands[name as CommandName](text.trim().slice(name.length).trim());
    else if (/^\/\w+$/.test(name)) setStatus({ text: `unknown command ${name} – ${COMMANDS.map(c => c.name).join(' ')}`, tone: 'error' });
    else if (text.trim()) addUser(text);
  }

  return {
    context,
    sent,
    split,
    streaming,
    running,
    live,
    // Streaming or running: only Esc (abort, kill) acts.
    nextCall: () => ops.nextCall(context()),
    busy: () => streaming() !== null || running() !== null,
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
    abort: () => (streaming() ?? running())?.abort.abort(),
    approve: () => void approve(),
    reject,
    select: (delta: number) => selectAt(rows().indexOf(selected()) + delta),
    move,
    pin,
    remove,
    undo,
    rename,
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

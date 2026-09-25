// Review Gate state: the Session Log in memory, Context = fold(events), token split, streaming answer.
import { createEffect, createMemo, createSignal } from 'solid-js';
import type { Backend, ChatResult } from '../core/backend';
import * as ops from '../core/context/operations';
import type { SessionEvent, SessionLog } from '../core/log/events';
import { fold, type Block } from '../core/log/fold';
import { renderNative, sentBlocks, type Message } from '../core/render/native';
import type { TokenSplit } from '../core/tokens/split';
import { errorText, titleOf } from './format';

export type Status = { text: string; tone: 'info' | 'ok' | 'warn' | 'error' };
// events: the Session Log so far (new or resumed); reconnect: re-reads the config and opens the session's
// Model Profile again (/reload, FR-44); openSessions: shows /sessions; notice: initial status line.
export type GateOptions = {
  backend: Backend;
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

const sameMessages = (a: Message[], b: Message[]) => JSON.stringify(a) === JSON.stringify(b);

export function createGate({ log, reconnect, openSessions, ...options }: GateOptions) {
  const [events, setEvents] = createSignal(options.events);
  const [counted, setCounted] = createSignal<{ messages: Message[]; split: TokenSplit } | null>(null);
  const [streaming, setStreaming] = createSignal<Streaming | null>(null);
  const [status, setStatus] = createSignal<Status | null>(options.notice ?? null);
  const [selected, setSelected] = createSignal(1);
  // Marked blocks (Space) for Compaction; UI state, not logged.
  const [marked, setMarked] = createSignal<ReadonlySet<number>>(new Set());
  const [backend, setBackend] = createSignal(options.backend);

  const append = (event: SessionEvent) => {
    log.append(event);
    setEvents([...events(), event]);
  };
  const context = createMemo(() => fold(events()));
  const sent = createMemo(() => sentBlocks(context()));
  // Unchanged messages (e.g. after a rename) keep the memo value, so nothing is recounted.
  const messages = createMemo(() => renderNative(context()), [], { equals: sameMessages });
  // Token split of the current messages only; a stale split would misalign rows after a move.
  const split = () => (counted()?.messages === messages() ? counted()!.split : null);
  const nextId = () => context().nextId;
  // Messages right after the last answer; a Context changed since then may be sent again as is.
  const answered = createMemo(() => {
    const last = events().findLastIndex(e => e.type === 'ResponseReceived');
    return last < 0 ? null : renderNative(fold(events().slice(0, last + 1)));
  });
  // Selectable rows in order: sent blocks; the streaming answer sits before the bottom pins.
  const rows = createMemo(() => {
    const ids = sent().map(b => b.id);
    if (!streaming()) return ids;
    const bottom = sent().findIndex(b => b.pin === 'bottom');
    ids.splice(bottom < 0 ? ids.length : bottom, 0, nextId());
    return ids;
  });
  const selectedBlock = (): Block | undefined => sent().find(b => b.id === selected());
  const selectAt = (i: number) => setSelected(rows()[Math.max(0, Math.min(rows().length - 1, i))]!);
  const keepSelection = () => rows().includes(selected()) || selectAt(rows().length - 1);

  createEffect(() => {
    const current = messages();
    backend().count(current).then(
      s => messages() === current && setCounted({ messages: current, split: s }),
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

  const PINNED = { top: 'pinned ⤒ top', bottom: 'pinned ⤓ bottom (sent as user-role Note at the end)' };
  const move = (dir: -1 | 1) => operate(b => ops.move(context(), b, dir), () => null);
  const pinOf = (id: number) => context().blocks.find(b => b.id === id)!.pin;
  const pin = () => operate(ops.pin, b => (pinOf(b.id) ? PINNED[pinOf(b.id)!] : 'unpinned'));
  function remove() {
    const at = rows().indexOf(selected());
    operate(ops.remove, b => `removed: ${titleOf(b)} · struck through until sent · u = undo`);
    setMarked(new Set([...marked()].filter(id => sent().some(b => b.id === id))));
    selectAt(at);
  }
  function undo() {
    const result = ops.undo(events());
    if ('error' in result) return apply(result);
    const { type } = events()[result.event.eventId]!;
    apply(result);
    keepSelection();
    setStatus({ text: `undone: ${type.toLowerCase()} (counter-event in Session Log)`, tone: 'info' });
  }
  const rename = (title: string) =>
    operate(b => ops.rename(b, title), () => (title.trim() ? 'renamed (display only – Context and cache unchanged)' : 'title reset'));
  function toggleMark() {
    const block = selectedBlock();
    if (!block || ops.isFixed(block)) return;
    const next = new Set(marked());
    if (!next.delete(block.id)) next.add(block.id);
    setMarked(next);
  }

  function finish(result: ChatResult) {
    const cutOff = result.finish !== 'stop';
    append({ type: 'BlockAdded', id: nextId(), kind: 'Assistant', origin: 'model', content: result.content, ...(cutOff && { cutOff }) });
    append({ type: 'ResponseReceived', usage: result.usage, cached: result.cached });
    setStatus(
      result.finish === 'aborted' ? { text: '⚠ aborted – partial answer kept (cut off)', tone: 'warn' }
      : cutOff ? { text: '⚠ cut off at max_tokens', tone: 'warn' }
      : { text: 'answer complete', tone: 'ok' },
    );
  }

  async function send() {
    if (streaming()) return;
    const changed = answered() !== null && !sameMessages(answered()!, messages());
    if (!changed && sent().filter(b => b.pin !== 'bottom').at(-1)?.kind !== 'User') {
      setStatus({ text: 'nothing to send – Tab to write', tone: 'info' });
      return;
    }
    const request = messages();
    const abort = new AbortController();
    setStreaming({ text: '', abort });
    setStatus(null);
    try {
      const { total } = await backend().count(request);
      if (abort.signal.aborted) {
        setStreaming(null);
        setStatus({ text: 'send cancelled', tone: 'info' });
        return;
      }
      append({ type: 'RequestSent', hash: Bun.hash(JSON.stringify(request)).toString(16), tokens: total });
      setMarked(new Set<number>());
      setSelected(nextId());
      const onDelta = (d: string) => setStreaming({ text: streaming()!.text + d, abort });
      const result = await backend().chat(request, { signal: abort.signal, onDelta });
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
    status,
    rows,
    selected,
    selectedBlock,
    marked,
    window: () => backend().window,
    profile: () => context().profile,
    submit,
    send,
    abort: () => streaming()?.abort.abort(),
    select: (delta: number) => selectAt(rows().indexOf(selected()) + delta),
    move,
    pin,
    remove,
    undo,
    rename,
    toggleMark,
    clearMarks: () => setMarked(new Set<number>()),
  };
}

export type Gate = ReturnType<typeof createGate>;

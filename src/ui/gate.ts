// Review Gate state: the Session Log in memory, Context = fold(events), token split, streaming answer.
import { createEffect, createMemo, createSignal } from 'solid-js';
import type { Backend, ChatResult } from '../core/backend';
import type { SessionEvent, SessionLog } from '../core/log/events';
import { fold } from '../core/log/fold';
import { renderNative, type Message } from '../core/render/native';
import type { TokenSplit } from '../core/tokens/split';

export type GateOptions = { backend: Backend; log: SessionLog; profile: string; systemPrompt: string };
export type Status = { text: string; tone: 'info' | 'ok' | 'warn' | 'error' };
// In-flight answer; never persisted until complete or aborted (FR-37).
export type Streaming = { text: string; abort: AbortController };

const sameMessages = (a: Message[], b: Message[]) => JSON.stringify(a) === JSON.stringify(b);

export function createGate({ backend, log, profile, systemPrompt }: GateOptions) {
  const initial: SessionEvent[] = [
    { type: 'SessionCreated', profile, protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: systemPrompt },
  ];
  initial.forEach(log.append);
  const [events, setEvents] = createSignal(initial);
  const [split, setSplit] = createSignal<TokenSplit | null>(null);
  const [streaming, setStreaming] = createSignal<Streaming | null>(null);
  const [status, setStatus] = createSignal<Status | null>(null);
  const [selected, setSelected] = createSignal(0);

  const append = (event: SessionEvent) => {
    log.append(event);
    setEvents([...events(), event]);
  };
  const context = createMemo(() => fold(events()));
  const messages = createMemo(() => renderNative(context()), [], { equals: sameMessages });
  const nextId = () => context().blocks.length + 1;
  // The streaming answer is a row after the last block.
  const lastRow = () => context().blocks.length - (streaming() ? 0 : 1);
  const selectLast = () => setSelected(lastRow());

  createEffect(() => {
    const current = messages();
    backend.count(current).then(
      s => messages() === current && setSplit(s),
      e => setStatus({ text: String(e), tone: 'error' }),
    );
  });

  function addUser(content: string) {
    append({ type: 'BlockAdded', id: nextId(), kind: 'User', origin: 'user', content });
    selectLast();
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
    if (context().blocks.at(-1)?.kind !== 'User') {
      setStatus({ text: 'nothing to send – Tab to write', tone: 'info' });
      return;
    }
    const request = messages();
    const abort = new AbortController();
    setStreaming({ text: '', abort });
    setStatus(null);
    try {
      const { total } = await backend.count(request);
      if (abort.signal.aborted) {
        setStreaming(null);
        setStatus({ text: 'send cancelled', tone: 'info' });
        return;
      }
      append({ type: 'RequestSent', hash: Bun.hash(JSON.stringify(request)).toString(16), tokens: total });
      selectLast();
      const onDelta = (d: string) => setStreaming({ text: streaming()!.text + d, abort });
      const result = await backend.chat(request, { signal: abort.signal, onDelta });
      setStreaming(null);
      finish(result);
    } catch (e) {
      setStreaming(null);
      setStatus({ text: `backend error: ${e instanceof Error ? e.message : e}`, tone: 'error' });
    }
    selectLast();
  }

  return {
    context,
    split,
    streaming,
    status,
    selected,
    window: backend.window,
    profile,
    addUser,
    send,
    abort: () => streaming()?.abort.abort(),
    select: (i: number) => setSelected(Math.max(0, Math.min(lastRow(), i))),
  };
}

export type Gate = ReturnType<typeof createGate>;

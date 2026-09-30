// Gate kernel: the Session Log in memory, Context = fold(events), its token split, the status line and the step under way.
import { createEffect, createMemo, createSignal } from 'solid-js';
import type { Backend, Counted } from '../core/backend';
import { commonPrefix, warmRows } from '../core/cache/cache';
import * as ops from '../core/context/operations';
import type { SessionEvent, SessionLog } from '../core/log/events';
import { fold, type Block } from '../core/log/fold';
import { peekReferences } from '../core/notes/files';
import { renderPrefixes, sentBlocks, type Request } from '../core/render/native';
import { budget, lastDrift, type Budget } from '../core/tokens/budget';
import { toolsIn } from '../core/toolcall/bash';
import type { Compaction, Project, Running, Status, Streaming } from './types';

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export type Kernel = ReturnType<typeof createKernel>;

export function createKernel(options: { log: SessionLog; backend: Backend; events: SessionEvent[]; project: Project; status: Status | null }) {
  const { log, project } = options;
  const [events, setEvents] = createSignal(options.events);
  const [counted, setCounted] = createSignal<{ prefixes: Request[]; split: Counted } | null>(null);
  const [status, setStatus] = createSignal<Status | null>(options.status);
  // The step under way: the answer streaming, a call running, the user's Compaction, the active policy.
  const [streaming, setStreaming] = createSignal<Streaming | null>(null);
  const [running, setRunning] = createSignal<Running | null>(null);
  const [compacting, setCompacting] = createSignal<Compaction | null>(null);
  // The active policy editing the Context before a request; Esc aborts its Compaction.
  const [policing, setPolicing] = createSignal<{ name: string; abort: AbortController } | null>(null);
  // Bumped when the server's cache changed without a new request to count (a Compaction on its slot).
  const [recount, setRecount] = createSignal(0);
  // Bumped when a referenced file may have changed (edited via `e`): the Gate shows it as it is now.
  const [reread, setReread] = createSignal(0);
  const backend = () => options.backend;

  const append = (event: SessionEvent) => {
    log.append(event);
    setEvents([...events(), event]);
  };
  // Unread @path references show the file as it would be read now; only sending reads them.
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
  // Per sent block while the request is recounted: the last count's tokens of the blocks before the first changed
  // prefix, so the table does not blank out on every change; the rest are unknown until the count arrives.
  const known = createMemo(() => {
    const c = counted();
    if (!c) return null;
    if (c.prefixes === prefixes()) return c.split;
    return { ...c.split, blocks: c.split.blocks.slice(0, commonPrefix(c.prefixes, prefixes(), same)) };
  });
  // Per sent block, in Context order: still in the server's prefix cache.
  const warm = createMemo(() => (known() ? warmRows(known()!.blocks, known()!.cached.tokens) : null));
  const nextId = () => context().nextId;
  // The budget of a Context of `total` tokens: max_tokens, and whether it may be sent.
  const budgetOf = (total: number): Budget =>
    budget({ total, window: backend().window, exact: backend().exact, drift: lastDrift(events()) });
  // A block as it is now, after an operation.
  const blockOf = (id: number): Block => context().blocks.find(b => b.id === id)!;
  // The tokens of sent blocks; null while counting.
  const tokensOf = (ids: number[]) => (split() ? ids.reduce((sum, id) => sum + split()!.blocks[sent().findIndex(b => b.id === id)]!, 0) : null);
  // The tools in the Tools Block, switched on or off with /tools.
  const toolsOn = () => toolsIn(context().blocks.find(b => b.kind === 'Tools')?.content ?? '[]');
  const idle = () => !streaming() && !running() && !policing();

  createEffect(() => {
    recount();
    const current = prefixes();
    backend().count(current).then(
      s => prefixes() === current && setCounted({ prefixes: current, split: s }),
      e => setStatus({ text: String(e), tone: 'error' }),
    );
  });

  // Appends the operation's event, or shows why not. Returns whether it was applied.
  function apply(result: ops.Outcome): boolean {
    if ('error' in result) setStatus({ text: result.error, tone: 'info' });
    else append(ops.attributed(result.event, 'user'));
    return !('error' in result);
  }

  return {
    backend, events, append, apply, context, sent, prefixes, request, split, known, warm, nextId, budgetOf, blockOf, tokensOf, toolsOn,
    status, setStatus,
    streaming, setStreaming, running, setRunning, compacting, setCompacting, policing, setPolicing, idle,
    recount: () => setRecount(recount() + 1),
    reread: () => setReread(reread() + 1),
  };
}

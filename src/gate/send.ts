// Sending the Context: whether it may go, reading its references, the count right before, and the streaming answer.
import { createMemo } from 'solid-js';
import * as ops from '../core/context/operations';
import { fold, type Block } from '../core/log/fold';
import { readReferences } from '../core/notes/files';
import type { Policy } from '../core/policy/policy';
import { renderNative } from '../core/render/native';
import { openingBlocks } from '../core/session/session';
import { errorText, formatTokens, generationRate, speedText } from './text';
import type { GitSlice } from './git';
import { same, type Kernel } from './kernel';
import type { PolicySlice } from './policy';
import { APPROVE, QUESTION_HINT, type ToolLoop } from './tool-loop';
import type { Policies, Project, Status, View } from './types';

// The last block: a User message, a Tool Result or a Note (e.g. an @path reference) asks for an answer,
// not the Notes a new session starts with (environment, project instructions).
function asksForAnswer(blocks: Block[], opening: Set<number>): boolean {
  const last = blocks.findLast(b => !opening.has(b.id))?.kind;
  return last === 'User' || last === 'Tool Result' || last === 'Note';
}

export function createSend(k: Kernel, sel: View, deps: { loop: ToolLoop; policy: PolicySlice; git: GitSlice; project: Project; policies: Policies }) {
  const { context, events, nextId, append, setStatus, backend, streaming, setStreaming, split } = k;
  const { follow, setSelected } = sel;
  const { loop } = deps;

  // Messages right after the last answer; a Context changed since then may be sent again as is.
  const lastAnswer = createMemo(() => {
    const last = events().findLastIndex(e => e.type === 'ResponseReceived');
    return last < 0 ? null : renderNative(fold(events().slice(0, last + 1)));
  });

  // On send: the references are read into snapshots, a missing file aborts; the environment is refreshed.
  function prepare(): boolean {
    const read = readReferences(context(), deps.project.read);
    if ('error' in read) {
      setSelected(read.id);
      setStatus({ text: `${read.error} – sending aborted`, tone: 'error' });
      return false;
    }
    read.events.forEach(append);
    deps.git.refresh();
    return true;
  }

  // Why the Context cannot be sent now, or null: calls await approval, or the model has answered
  // and nothing changed since.
  function unsendable(): Status | null {
    const pending = ops.nextCall(context());
    if (pending) {
      sel.release();
      setSelected(pending.id);
      return { text: pending.tool === 'question' ? QUESTION_HINT : `Tool Calls await approval – ${APPROVE} on the ? approve row`, tone: 'warn' };
    }
    const changed = lastAnswer() !== null && !same(lastAnswer(), k.request());
    return changed || asksForAnswer(k.sent(), openingBlocks(events())) ? null : { text: 'nothing to send – Tab to write', tone: 'info' };
  }

  // A Context as big as the window is not sent; the user makes room.
  function overBudget(total: number): boolean {
    const { over } = k.budgetOf(total);
    if (over) setStatus({ text: `over by ${formatTokens(over)} – sending blocked · d remove · e edit · c compact`, tone: 'error' });
    return over > 0;
  }

  // Whether the Context may go: nothing blocks it, it fits, and its references are read. The window is checked
  // first on the Gate's count, so a Context known to be too big reads no references; the count right
  // before sending checks again (halted).
  function ready(): boolean {
    return !blocked() && !(split() && overBudget(split()!.total)) && prepare();
  }
  // With an active policy the references are read first, then the policy edits the Context; the count right before
  // sending checks it.
  async function readyWith(policy: Policy): Promise<boolean> {
    return !blocked() && prepare() && (await deps.policy.runPolicy(policy));
  }
  function blocked(): boolean {
    const why = unsendable();
    if (why) setStatus(why);
    return why !== null;
  }
  // After the count right before sending: Esc cancelled it, or the Context does not fit.
  function halted(aborted: boolean, total: number): boolean {
    if (aborted) setStatus({ text: 'send cancelled', tone: 'info' });
    const halt = aborted || overBudget(total);
    if (halt) setStreaming(null);
    return halt;
  }

  // The check stays synchronous without a policy: a second send in the same tick finds the first streaming.
  async function send() {
    if (!k.idle() || loop.wentOn()) return;
    const policy = deps.policies.active();
    if (!(policy ? await readyWith(policy) : ready())) return;
    const did = deps.policy.takeRan();
    const requested = k.prefixes();
    const payload = requested.at(-1)!;
    const abort = new AbortController();
    loop.setStopping(false);
    setStreaming({ thinking: '', text: '', abort, tokens: 0, first: null });
    setStatus(null);
    try {
      const { total } = await backend().count(requested);
      if (halted(abort.signal.aborted, total)) return deps.policy.withDid(did);
      append({ type: 'RequestSent', hash: Bun.hash(JSON.stringify(payload)).toString(16), tokens: total });
      sel.setMarked(new Set<number>());
      follow(nextId());
      const onThinking = (d: string) => setStreaming({ ...streaming()!, thinking: streaming()!.thinking + d });
      // The answer follows its reasoning: the selection moves on with it.
      const onDelta = (d: string) => {
        const { thinking, text } = streaming()!;
        if (thinking && !text && sel.selected() === nextId()) follow(nextId() + 1);
        setStreaming({ ...streaming()!, text: text + d });
      };
      const onToken = () => {
        const s = streaming()!;
        setStreaming({ ...s, tokens: s.tokens + 1, first: s.first ?? Date.now() });
      };
      const sent = Date.now();
      const result = await backend().chat(payload, { signal: abort.signal, onDelta, onThinking, onToken, maxTokens: k.budgetOf(total).maxTokens });
      // What the server measured; else measured here: generation by the server's token count when it reports one,
      // without prefill (before the first token); a first token within half a second is not worth telling.
      const { tokens, first } = streaming()!;
      const server = result.speed ?? {};
      const speed = first === null ? speedText(server) : speedText({
        generation: server.generation ?? generationRate(result.usage?.completion_tokens ?? tokens, Date.now() - first) ?? undefined,
        prompt: server.prompt,
        firstToken: server.firstToken ?? (first - sent < 500 ? undefined : first - sent),
      });
      setStreaming(null);
      loop.finish(result, did, speed);
    } catch (e) {
      setStreaming(null);
      setStatus({ text: `backend error: ${errorText(e)}`, tone: 'error' });
      deps.policy.withDid(did);
    }
    sel.keepSelection();
  }

  return { send };
}

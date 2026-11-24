// Headless Run: the Tool Loop driven without the Review Gate. The prompt is sent and the loop goes on until the model
// answers without calls; a Hold does not stop it. The run ends with an Outcome.
import * as ops from '../core/context/operations';
import type { SessionEvent } from '../core/log/events';
import type { Block } from '../core/log/fold';
import { errorText } from './text';
import type { Kernel } from './kernel';
import type { Terminal } from './ports';
import type { Rules } from './rules';
import type { ToolLoop } from './tool-loop';

// text: the answer, or the Gate's status line of the error; turns: requests sent; tokens: the Context at the last one.
export type Outcome = { kind: 'answer' | 'error' | 'aborted' | 'max-turns'; text: string; turns: number; tokens: number; summary?: Summary };
// What the summary request brought: its text, or why there is none.
export type Summary = { text: string } | { error: string };
// maxTurns: requests to the model at most, a policy's send on too, Compaction never; signal: aborts like Esc (the
// stream, the running call); terminal: asks the person running it – without one, a Question is declined and a call
// the rules ask for is not run; summary: a Subagent's, asked for once the run has ended with an answer or at max
// turns.
export type RunInput = { prompt: string; maxTurns?: number; signal?: AbortSignal; terminal?: Terminal | null; summary?: SummaryInput };
// prompt: what the request asks; asking: called before the request, which is none of the run's turns.
export type SummaryInput = { prompt: string; asking?: () => void };

export const MAX_TURNS = 50;

// signal: aborted with the caller's; summaryFrom: where the summary starts in the events, null during the run.
type Run = { from: number; summaryFrom: number | null; maxTurns: number; maxed: boolean; signal: AbortSignal; terminal: Terminal | null; waiting: number };

// What the terminal said, or null once the run is aborted: it may never answer.
const until = <T>(asked: Promise<T>, signal: AbortSignal) =>
  Promise.race([asked, new Promise<null>(resolve => (signal.aborted ? resolve(null) : signal.addEventListener('abort', () => resolve(null), { once: true })))]);

export function createHeadless(k: Kernel, loop: ToolLoop, rules: Rules, submit: (text: string) => void, send: () => void, addExitNotes: () => void) {
  let current: Run | null = null;
  let driven = false;
  const requests = (r: Run, from = r.from) => k.events().slice(from).filter((e): e is Extract<SessionEvent, { type: 'RequestSent' }> => e.type === 'RequestSent');

  // Before each request: none once the run is aborted or has used its turns (noted for its Outcome).
  function mayRequest(): boolean {
    if (!current) return true;
    if (current.signal.aborted) return false;
    // The summary's only one.
    if (current.summaryFrom !== null) return requests(current, current.summaryFrom).length === 0;
    current.maxed = requests(current).length >= current.maxTurns;
    return !current.maxed;
  }

  // A call the rules ask for, or a Question: the terminal decides, else nobody can.
  async function ask(r: Run, call: Block) {
    r.waiting++;
    try {
      await (call.tool === 'question' ? answer(r) : approve(r, call));
    } catch (e) {
      k.setStatus({ text: `terminal: ${errorText(e)}`, tone: 'error' });
    } finally {
      r.waiting--;
    }
  }

  async function answer(r: Run) {
    const asked = loop.api.asked();
    const answers = asked && r.terminal ? await until(r.terminal.answer(asked.questions, r.signal), r.signal) : null;
    if (!r.signal.aborted) void (answers ? loop.api.answer(answers) : loop.api.decline());
  }

  async function approve(r: Run, call: Block) {
    const choice = r.terminal ? await until(r.terminal.approve(call, rules.verdictOf(call), r.signal), r.signal) : 'unattended';
    if (choice && !r.signal.aborted) loop.decide(call, choice);
  }

  // The run has ended once the Gate stays idle over a timer tick: a step hands over to the next synchronously or
  // within microtasks.
  async function ended(r: Run) {
    const busy = () => !k.idle() || r.waiting > 0;
    for (let quiet = 0; quiet < 2; quiet = busy() ? 0 : quiet + 1) await new Promise(resolve => setTimeout(resolve, busy() ? 5 : 0));
  }

  function outcome(r: Run): Outcome {
    const sent = requests(r);
    const counts = { turns: sent.length, tokens: sent.at(-1)?.tokens ?? 0 };
    if (r.signal.aborted) return { kind: 'aborted', text: '', ...counts };
    if (r.maxed) return { kind: 'max-turns', text: '', ...counts };
    const status = k.status();
    if (status?.tone === 'error') return { kind: 'error', text: status.text, ...counts };
    return { kind: 'answer', text: k.context().blocks.findLast(b => b.kind === 'Assistant')?.content ?? '', ...counts };
  }

  // What the model wrote since `from`; it says so when cut off at max_tokens.
  function writtenSince(from: number): string {
    const answers = k.events().slice(from).flatMap(e => (e.type === 'BlockAdded' && e.kind === 'Assistant' ? [e] : []));
    const text = answers.map(a => a.content).join('\n').trim();
    return text && answers.some(a => a.cutOff) ? `${text}\n\n[summary cut off at max_tokens]` : text;
  }

  // Answered, or a resumed Session would run them.
  function answerCalls() {
    for (let call = ops.nextCall(k.context()); call; call = ops.nextCall(k.context())) k.apply(ops.afterRun(k.context(), call, k.nextId()));
  }

  function summaryOf(text: string): Summary {
    const status = k.status();
    return text ? { text } : { error: status?.tone === 'error' ? status.text : 'the model wrote none' };
  }

  // One more request of the run that ended with `done`: neither its calls run nor a policy sends on after it. Aborted
  // meanwhile, the run is.
  async function summarize(r: Run, done: Outcome, { prompt, asking }: SummaryInput): Promise<Outcome> {
    asking?.();
    const from = (r.summaryFrom = k.events().length);
    k.setStatus(null);
    answerCalls();
    // Before the prompt: the prompt comes last.
    addExitNotes();
    k.append({ type: 'BlockAdded', id: k.nextId(), kind: 'User', origin: 'user', content: prompt });
    send();
    await ended(r);
    answerCalls();
    if (r.signal.aborted) return { ...done, kind: 'aborted', text: '' };
    return { ...done, summary: summaryOf(writtenSince(from)) };
  }

  async function run({ prompt, maxTurns = MAX_TURNS, signal, terminal = null, summary }: RunInput): Promise<Outcome> {
    driven = true;
    const stop = new AbortController();
    const r: Run = (current = { from: k.events().length, summaryFrom: null, maxTurns, maxed: false, signal: stop.signal, terminal, waiting: 0 });
    // Like Esc twice: the step is aborted at once.
    const abort = () => (stop.abort(), loop.api.abort(), loop.api.abort());
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort);
    loop.drive({ ask: call => void ask(r, call), stopped: () => stop.signal.aborted || r.summaryFrom !== null });
    try {
      submit(prompt);
      await ended(r);
      const done = outcome(r);
      return summary && (done.kind === 'answer' || done.kind === 'max-turns') ? await summarize(r, done, summary) : done;
    } finally {
      signal?.removeEventListener('abort', abort);
      loop.drive(null);
      current = null;
    }
  }

  return { api: { run }, mayRequest, driven: () => driven, summing: () => current !== null && current.summaryFrom !== null };
}

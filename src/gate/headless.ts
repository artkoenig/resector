// Headless Run: the Tool Loop driven without the Review Gate. The prompt is sent and the loop goes on until the model
// answers without calls; a Hold does not stop it. The run ends with an Outcome.
import type { SessionEvent } from '../core/log/events';
import type { Block } from '../core/log/fold';
import { errorText } from './text';
import type { Kernel } from './kernel';
import type { Terminal } from './ports';
import type { Rules } from './rules';
import type { ToolLoop } from './tool-loop';

// text: the answer, or the Gate's status line of the error; turns: requests sent; tokens: the Context at the last one.
export type Outcome = { kind: 'answer' | 'error' | 'aborted' | 'max-turns'; text: string; turns: number; tokens: number };
// maxTurns: requests to the model at most, a policy's send on too, Compaction never; signal: aborts like Esc (the
// stream, the running call); terminal: asks the person running it – without one, a Question is declined and a call
// the rules ask for is not run.
export type RunInput = { prompt: string; maxTurns?: number; signal?: AbortSignal; terminal?: Terminal | null };

export const MAX_TURNS = 50;

// signal: aborted with the caller's.
type Run = { from: number; maxTurns: number; maxed: boolean; signal: AbortSignal; terminal: Terminal | null; waiting: number };

// What the terminal said, or null once the run is aborted: it may never answer.
const until = <T>(asked: Promise<T>, signal: AbortSignal) =>
  Promise.race([asked, new Promise<null>(resolve => (signal.aborted ? resolve(null) : signal.addEventListener('abort', () => resolve(null), { once: true })))]);

export function createHeadless(k: Kernel, loop: ToolLoop, rules: Rules, submit: (text: string) => void) {
  let current: Run | null = null;
  const requests = (r: Run) => k.events().slice(r.from).filter((e): e is Extract<SessionEvent, { type: 'RequestSent' }> => e.type === 'RequestSent');

  // Before each request: none once the run is aborted or has used its turns (noted for its Outcome).
  function mayRequest(): boolean {
    if (!current) return true;
    if (current.signal.aborted) return false;
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

  async function run({ prompt, maxTurns = MAX_TURNS, signal, terminal = null }: RunInput): Promise<Outcome> {
    const stop = new AbortController();
    const r: Run = (current = { from: k.events().length, maxTurns, maxed: false, signal: stop.signal, terminal, waiting: 0 });
    // Like Esc twice: the step is aborted at once.
    const abort = () => (stop.abort(), loop.api.abort(), loop.api.abort());
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort);
    loop.drive({ ask: call => void ask(r, call), stopped: () => stop.signal.aborted });
    try {
      submit(prompt);
      await ended(r);
      return outcome(r);
    } finally {
      signal?.removeEventListener('abort', abort);
      loop.drive(null);
      current = null;
    }
  }

  return { api: { run }, mayRequest };
}

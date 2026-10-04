// The tool loop: an answer's calls are decided in order, run, answered by the user or held; then the results are sent.
import { batch, createMemo, createSignal } from 'solid-js';
import { quoted, sessionRules } from '../core/approval/approval';
import type { ChatResult } from '../core/tools/answer';
import * as ops from '../core/context/operations';
import type { Block } from '../core/log/fold';
import { answerBlocks } from '../core/tools/answer';
import type { Runner } from './ports';
import { answerText, parseQuestions, type Answer } from '../core/tools/question';
import { errorText, titleOf } from './text';
import type { GitSlice } from './git';
import type { Kernel } from './kernel';
import type { Rules } from './rules';
import type { Asked, Status, View } from './types';

export const APPROVE = 'y run once · a allow for session · n reject · e edit';
export const QUESTION_HINT = 'the model asks – answer in the dock';
// The prediction checked against the server; a server reusing more than predicted is harmless.
const cacheMiss = ({ predicted, cached }: ChatResult) =>
  predicted !== null && cached !== null && cached < predicted ? `cache: predicted ${predicted} · server reused ${cached}` : null;
const notRunText = (why: string) => `⚠ tool call not run: ${why}`;

export type ToolLoop = ReturnType<typeof createToolLoop>;

export function createToolLoop(k: Kernel, sel: View, rules: Rules, git: GitSlice, tools: { runner: Runner; searcher: Runner; send: () => void }) {
  const { context, nextId, append, apply, setStatus, running, setRunning } = k;
  const { follow } = sel;

  // Whether the answer's calls leave the results for review at the Gate: one was not run (rejected, denied, not a
  // bash call) or was stopped (killed, timeout). Otherwise, once every call ran, the results are sent.
  let held = false;

  // Esc while an answer streams or a call runs: the step finishes, then the tool loop stops at the Gate for changes;
  // Esc again aborts the step. Enter goes on.
  const [stopping, setStopping] = createSignal(false);
  // Esc: the first stops after the step, the second aborts it (then the loop stops anyway); while the policy runs
  // the step is the answer after it. The user's Compaction is aborted at once.
  function abort() {
    const step = k.streaming() ?? running() ?? k.policing();
    if (step && !stopping()) return void setStopping(true);
    setStopping(false);
    (k.policing() ?? step ?? k.compacting())?.abort?.abort();
  }
  // The loop goes on after a step, unless Esc asked to stop: then the next call waits, its results are held.
  function goOn(notes: string[]) {
    if (!stopping()) return advance(notes);
    setStopping(false);
    held = true;
    follow(ops.nextCall(context())?.id ?? nextId());
    setStatus({ text: [...notes, 'stopped – make your changes, Enter goes on'].join(' · '), tone: 'info' });
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
  // `policy`: what the active policy did before the request; `speed`: how fast the answer was generated.
  function finish(result: ChatResult, policy: string | null, speed: string | null = null) {
    // Calls to a tool denied by rule are parsed too: they are answered "denied by rule".
    const { events, notRun } = answerBlocks(result, nextId(), [...k.toolsOn(), ...rules.denied()]);
    // At once: a rejected Question is never pending without its Tool Result.
    batch(() => {
      events.forEach(append);
      append({ type: 'ResponseReceived', usage: result.usage, cached: result.cached });
    });
    held = !!notRun;
    const miss = cacheMiss(result);
    // Calls to decide, or only a rejected Question already answered: the loop goes on.
    if (events.some(e => e.kind === 'Tool Call')) return goOn([policy, notRun && notRunText(notRun), miss && `⚠ ${miss}`].filter((n): n is string => !!n));
    const status = answerStatus(result, notRun);
    const text = [policy, status.text, speed, miss && `⚠ ${miss}`].filter(Boolean).join(' · ');
    setStatus({ text, tone: miss ? 'warn' : status.tone });
  }

  // Decides the pending calls in order: an allowed one runs, a denied one is answered "denied by rule", the
  // first to ask for is selected. Then the results are sent, or held at the Gate. notes: what happened so far.
  function advance(notes: string[] = []) {
    for (let call = ops.nextCall(context()); call; call = ops.nextCall(context())) {
      const action = rules.decided(call);
      if (action === 'allow') return void run(call, notes);
      if (action !== 'deny') return awaitUser(call, notes);
      follow(nextId());
      held = true;
      apply(ops.deny(context(), call, nextId()));
      notes = [...notes, `⚠ denied by rule: ${titleOf(call)}`];
    }
    if (!held) return void tools.send();
    setStatus({ text: `${notes.join(' · ') || 'tool loop paused'} – review the results, Enter sends`, tone: notes.length ? 'warn' : 'ok' });
  }
  // Calls left pending by a stop go on as the rules decide them; one to ask for still blocks the send.
  function wentOn(): boolean {
    const pending = ops.nextCall(context());
    if (!pending || rules.decided(pending) === 'ask') return false;
    held = false;
    advance();
    return true;
  }

  // The call waits for the user: a Question for its answer in the dock (it never needs Tool Approval), others for approval.
  function awaitUser(call: Block, notes: string[]) {
    follow(call.id);
    setStatus({ text: [...notes, call.tool === 'question' ? `? ${QUESTION_HINT}` : `? approve – ${APPROVE}`].join(' · '), tone: 'warn' });
  }

  // Runs the call with its tool's runner; its output streams into a live Tool Result row, then the next call is decided.
  async function run(call: Block, notes: string[]) {
    const abort = new AbortController();
    const tool = call.tool === 'search' ? tools.searcher : tools.runner;
    setStopping(false);
    setRunning({ call, output: '', started: Date.now(), timeout: tool.timeout, abort });
    follow(nextId());
    setStatus(null);
    try {
      const onOutput = (text: string) => setRunning({ ...running()!, output: running()!.output + text });
      const result = await tool.run(call.content, { signal: abort.signal, onOutput });
      setRunning(null);
      follow(nextId());
      append(ops.toolResult(call, nextId(), result, tool.timeout));
      git.lookAgain();
      if (result.stopped) held = true;
      goOn(result.stopped ? [...notes, `⚠ ${result.stopped}`] : notes);
    } catch (e) {
      setRunning(null);
      follow(call.id);
      setStatus({ text: `${call.tool ?? 'bash'} failed: ${errorText(e)}`, tone: 'error' });
    }
  }

  // The Question the dock asks now: the next pending call, while nothing streams or runs.
  const asked = createMemo((): Asked | null => {
    const call = ops.nextCall(context());
    if (call?.tool !== 'question' || k.streaming() || running() || rules.verdictOf(call).action === 'deny') return null;
    const parsed = parseQuestions(JSON.parse(call.content));
    return 'questions' in parsed ? { call, questions: parsed.questions } : null;
  });
  // The user's answers, one per question: the Tool Result, written by the user; then the loop goes on.
  function answer(answers: Answer[]) {
    const question = asked();
    if (!question) return;
    follow(nextId());
    append({ type: 'BlockAdded', id: nextId(), kind: 'Tool Result', origin: 'user', content: answerText(question.questions, answers), call: question.call.id });
    advance();
  }
  // Esc: the Question is declined; the results are held at the Gate.
  function decline() {
    const question = asked();
    if (!question) return;
    notRun(ops.decline, question.call, ['question declined']);
  }

  // The selected Tool Call, if it may be decided on now.
  function decidable(): Block | null {
    const block = sel.selectedBlock();
    const error = block?.tool === 'question' && block.pending ? QUESTION_HINT : block ? ops.approvable(context(), block) : 'not awaiting approval';
    if (error) setStatus({ text: error, tone: 'info' });
    else sel.release();
    return error ? null : block!;
  }

  // y: run the call once. A call a rule denies never waits here: it is decided at once, an edited one too.
  function approve() {
    const call = decidable();
    if (call) void run(call, []);
  }
  // a: allow the call's command prefixes for the session – the preview shows them beforehand; they
  // are saved as Session Log events, then the call runs as allowed.
  function allowForSession() {
    const call = decidable();
    if (!call) return;
    const found = sessionRules(rules.verdictOf(call));
    if ('error' in found) return setStatus({ text: found.error, tone: 'info' });
    for (const pattern of found.patterns) append({ type: 'AllowRuleAdded', pattern });
    advance([`allowed for session: ${quoted(found.patterns)}`]);
  }
  // n: not run; the result says "rejected by user".
  function reject() {
    const call = decidable();
    if (!call) return;
    notRun(ops.reject, call);
  }
  // The call is answered without running; the results are held at the Gate.
  function notRun(operation: typeof ops.reject, call: Block, notes: string[] = []) {
    held = true;
    follow(nextId());
    if (apply(operation(context(), call, nextId()))) advance(notes);
  }

  return {
    // What the view shows and does.
    api: {
      stopping, abort, asked, answer, decline, approve, allowForSession, reject,
      nextCall: () => ops.nextCall(context()),
    },
    setStopping, finish, advance, wentOn,
  };
}

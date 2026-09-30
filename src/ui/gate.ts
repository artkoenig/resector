// Review Gate state: the Session Log in memory, Context = fold(events), token split, streaming answer.
import { batch, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { Clipboard } from '../adapters/clipboard/clipboard';
import type { Branches } from '../adapters/git/git';
import type { Backend, ChatResult, Counted } from '../core/backend';
import { deniedTools, quoted, sessionAllowed, sessionRules, verdictOf as decide, type Rule, type Split, type Verdict } from '../core/approval/approval';
import { warmRows } from '../core/cache/cache';
import * as compaction from '../core/compaction/compaction';
import * as ops from '../core/context/operations';
import type { Kind, SessionEvent, SessionLog, Thinking } from '../core/log/events';
import { afterCalls, fold, pairOf, type Block } from '../core/log/fold';
import { refreshEnvironment } from '../core/notes/environment';
import { parseReference, peekReferences, readReferences, references, type ReadFile } from '../core/notes/files';
import { applyPolicy, summary, type Policy, type Ports } from '../core/policy/policy';
import { renderNative, renderPrefixes, sentBlocks, type Request } from '../core/render/native';
import { inWorktree, openingBlocks } from '../core/session/session';
import { DEFAULT_MODES } from '../core/render/template';
import { budget, lastDrift, type Budget } from '../core/tokens/budget';
import { answerBlocks } from '../core/toolcall/answer';
import { toolsIn, type Runner } from '../core/toolcall/bash';
import { answerText, parseQuestions, type Answer, type Question } from '../core/toolcall/question';
import { count, errorText, formatTokens, thinkingLabel, titleOf } from './format';

export type Status = { text: string; tone: 'info' | 'ok' | 'warn' | 'error' };
// events: the Session Log so far (new or resumed); openSessions: shows /sessions; notice: initial status line.
// runner: runs approved bash calls, searcher: search calls; approval: decides which may run; editor: $EDITOR for `e`;
// clipboard: copy on select.
export type GateOptions = {
  backend: Backend;
  runner: Runner;
  searcher: Runner;
  approval: Approval;
  editor: ops.Editor;
  clipboard: Clipboard;
  log: SessionLog;
  events: SessionEvent[];
  project: Project;
  openSessions: () => void;
  notice?: Status;
  // Default Compaction instruction; the Model Profile Compaction runs on, null = the session's own.
  instruction?: () => string;
  compactor?: () => Promise<Compactor | null>;
  policies?: Policies;
  autoApprove?: AutoApprove;
  // The Kind Filters off at start.
  hidden?: readonly string[];
  // Absent outside a git repository: the /git: commands are then not offered.
  git?: Git | null;
};
// Context Policies (ADR 0001): the ones loaded at start, and the active one, which belongs to the app, not the session.
export type Policies = { all: Policy[]; active: () => Policy | null; set: (policy: Policy | null) => void };
const NO_POLICIES: Policies = { all: [], active: () => null, set: () => {} };
// Auto-approve: every call a rule asks for runs without asking; like the active policy it belongs to the app.
export type AutoApprove = { on: () => boolean; set: (on: boolean) => void };
export type Compactor = { profile: string; backend: Backend };
// The project on disk: files for @path references and their completion, the environment Note's text now,
// and $EDITOR on a file of the project (`e` on a reference).
export type Project = { read: ReadFile; list: () => string[]; environment: () => string; open: (path: string) => Promise<void> };
// Tool Approval: the splitter, the project root arguments must stay in, and the config's rules as read
// when the session opened (ignored: project allow patterns).
export type Approval = { split: Split; root: string; permissions: () => { rules: Rule[]; ignored: string[] } };

// Git where the session runs: the branches, switching to one and watching for switches; worktree(on) prepares the session's own worktree
// (or the project directory) and returns it, reopen shows the Gate again running there, with a status.
export type Git = {
  branches: () => Branches;
  switchBranch: (name: string) => void;
  watch: (onChange: () => void) => () => void;
  worktree: (on: boolean) => string;
  reopen: (notice: Status) => void;
};

// Slash commands, in suggestion order.
export const COMMANDS = [
  { name: '/sessions', arg: '', description: 'list, resume, rename, delete sessions' },
  { name: '/rename', arg: '<title>', description: 'rename session' },
  { name: '/tools', arg: '<tool>', description: 'switch a tool on or off' },
  { name: '/filter', arg: '<kind>', description: 'show or hide blocks of a Kind' },
  { name: '/policy', arg: '<name>', description: 'switch a Context Policy on or off' },
  { name: '/auto', arg: '', description: 'switch auto-approve of Tool Calls on or off' },
  { name: '/thinking', arg: '<mode>', description: 'set thinking for the next requests' },
  { name: '/git:branch', arg: '<branch>', description: 'show or switch the git branch' },
  { name: '/git:worktree', arg: '<on|off>', description: 'run the session in its own git worktree' },
] as const;
// The Kind Filters, in glossary order: the Kinds each shows; a Tool Call never without its Tool Result.
// Additive: each is on or off on its own; the blocks shown are those of the ones on.
export type Filter = { name: string; kinds: readonly Kind[] };
export const FILTERS: readonly Filter[] = [
  { name: 'system', kinds: ['System', 'Tools'] },
  { name: 'user', kinds: ['User'] },
  { name: 'thinking', kinds: ['Thinking'] },
  { name: 'assistant', kinds: ['Assistant'] },
  { name: 'tool-calls', kinds: ['Tool Call', 'Tool Result'] },
  { name: 'note', kinds: ['Note'] },
];
type CommandName = (typeof COMMANDS)[number]['name'];
// In-flight answer, its reasoning apart; never persisted until complete or aborted.
export type Streaming = { thinking: string; text: string; abort: AbortController };
// Approved Tool Call running; its output so far is shown, the result is logged when it ends. timeout: its tool's.
export type Running = { call: Block; output: string; started: number; timeout: number; abort: AbortController };
// A Question awaiting the user's answer in the dock: its Tool Call and questions.
export type Asked = { call: Block; questions: Question[] };
// The row of an answer or result not in the Context yet, shown before the block `before` (null: at the end).
// A proposal has its own title, heading and, once counted, tokens.
export type Live = { id: number; kind: Kind; content: string; before: number | null; title?: string; heading?: string; tokens?: number };
// What accepting the proposal changes: tokens and Context (over: not below the window), and the cache.
export type Review = { tokens: string; over: boolean; cache: string; cold: boolean };
// Compaction under way: the instruction being written, the proposal streaming, or under review.
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
// The last block: a User message, a Tool Result or a Note (e.g. an @path reference) asks for an answer,
// not the Notes a new session starts with (environment, project instructions).
function asksForAnswer(blocks: Block[], opening: Set<number>): boolean {
  const last = blocks.findLast(b => !opening.has(b.id))?.kind;
  return last === 'User' || last === 'Tool Result' || last === 'Note';
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const APPROVE = 'y run once · a allow for session · n reject · e edit';
const QUESTION_HINT = 'the model asks – answer in the dock';
// The prediction checked against the server; a server reusing more than predicted is harmless.
const cacheMiss = ({ predicted, cached }: ChatResult) =>
  predicted !== null && cached !== null && cached < predicted ? `cache: predicted ${predicted} · server reused ${cached}` : null;

// Without an app-wide one, the Gate keeps its own, off.
function ownAutoApprove(): AutoApprove {
  const [on, set] = createSignal(false);
  return { on, set };
}

export function createGate({ log, openSessions, runner, searcher, approval, editor, clipboard, project, instruction = () => compaction.DEFAULT_INSTRUCTION, compactor = async () => null, policies = NO_POLICIES, autoApprove = ownAutoApprove(), hidden: hiddenAtStart = ['tool-calls'], git = null, ...options }: GateOptions) {
  const [events, setEvents] = createSignal(options.events);
  const [counted, setCounted] = createSignal<{ prefixes: Request[]; split: Counted } | null>(null);
  const [streaming, setStreaming] = createSignal<Streaming | null>(null);
  const [running, setRunning] = createSignal<Running | null>(null);
  const [status, setStatus] = createSignal<Status | null>(withHint(options.notice ?? null, ignoredHint(approval)));
  const [selected, setSelected] = createSignal(1);
  // Marked blocks (Space) for Compaction; UI state, not logged.
  const [marked, setMarked] = createSignal<ReadonlySet<number>>(new Set());
  // Kind Filters switched off: what the block table hides; UI state, not logged. Tool Calls are off at first.
  const [hidden, setHidden] = createSignal<readonly Filter[]>(FILTERS.filter(f => hiddenAtStart.includes(f.name)));
  const hides = (kind: Kind) => hidden().some(f => f.kinds.includes(kind));
  const backend = () => options.backend;
  // Moving a Tool Pair asks first: the operation and block awaiting the same key again.
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [compacting, setCompacting] = createSignal<Compaction | null>(null);
  // Bumped when the server's cache changed without a new request to count (a Compaction on its slot).
  const [recount, setRecount] = createSignal(0);
  // Bumped when a referenced file may have changed (edited via `e`): the Gate shows it as it is now.
  const [reread, setReread] = createSignal(0);
  // The active policy editing the Context before a request; Esc aborts its Compaction.
  const [policing, setPolicing] = createSignal<AbortController | null>(null);

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
  // Per sent block, in Context order: still in the server's prefix cache.
  const warm = createMemo(() => (split() ? warmRows(split()!.blocks, split()!.cached.tokens) : null));
  const nextId = () => context().nextId;
  // The budget of a Context of `total` tokens: max_tokens, and whether it may be sent.
  const budgetOf = (total: number): Budget =>
    budget({ total, window: backend().window, exact: backend().exact, drift: lastDrift(events()) });
  // Messages right after the last answer; a Context changed since then may be sent again as is.
  const lastAnswer = createMemo(() => {
    const last = events().findLastIndex(e => e.type === 'ResponseReceived');
    return last < 0 ? null : renderNative(fold(events().slice(0, last + 1)));
  });
  // The streaming answer (its reasoning first) sits at the end; a running call's result where it will be added.
  const live = createMemo((): Live[] => {
    const c = compacting();
    if (c && c.phase !== 'instruction') return [proposalRow(c)];
    const s = streaming();
    if (s) return streamingRows(s);
    const r = running();
    const blocks = context().blocks;
    return r ? [{ id: nextId(), kind: 'Tool Result', content: r.output, before: blocks[afterCalls(blocks, r.call.id)]?.id ?? null }] : [];
  });
  // The ids the answer's blocks get: a Thinking block first.
  function streamingRows({ thinking, text }: Streaming): Live[] {
    const reasoning: Live[] = thinking ? [{ id: nextId(), kind: 'Thinking', content: thinking, before: null }] : [];
    const answer: Live[] = text || !thinking ? [{ id: nextId() + reasoning.length, kind: 'Assistant', content: text, before: null }] : [];
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
  // Whether the Kind Filters let a row through. Always passing: a Compaction's proposal, and Tool Calls awaiting
  // approval or running with their output, since they are decided or stopped at their row.
  const proposing = () => compacting()?.phase === 'running' || compacting()?.phase === 'review';
  const unfiltered = createMemo(() => new Set([
    ...(proposing() && live()[0] ? [live()[0]!.id] : []),
    ...sent().filter(b => b.pending && !b.removed).map(b => b.id),
    ...(running() ? [running()!.call.id, ...live().map(l => l.id)] : []),
  ]));
  const passes = (id: number, kind: Kind) => !hides(kind) || unfiltered().has(id);
  // The rows shown, in order.
  const shown = createMemo(() => {
    const kinds = new Map<number, Kind>([...sent(), ...live()].map(b => [b.id, b.kind]));
    return rows().filter(id => passes(id, kinds.get(id)!));
  });
  // Only a shown block is selected: a hidden one gives way to the next shown row, else the previous.
  createEffect(() => {
    const ids = shown();
    const at = rows().indexOf(selected());
    // Not a row yet (the next block, selected ahead of it): nothing to give way to.
    if (!ids.length || ids.includes(selected()) || at < 0) return;
    setSelected(ids.find(id => rows().indexOf(id) > at) ?? ids.at(-1)!);
  });
  const selectedBlock = (): Block | undefined => (shown().includes(selected()) ? sent().find(b => b.id === selected()) : undefined);
  const selectAt = (i: number) => {
    if (shown().length) setSelected(shown()[Math.max(0, Math.min(shown().length - 1, i))]!);
  };
  const keepSelection = () => shown().includes(selected()) || selectAt(shown().length - 1);
  // Whether the user moved up to read an older row: the tool loop then leaves the selection alone. Moving back to
  // the last row, writing, sending or deciding a call follows the loop again.
  let reading = false;
  const follow = (id: number) => void (reading || setSelected(id));
  function select(delta: number) {
    selectAt(shown().indexOf(selected()) + delta);
    reading = selected() !== shown().at(-1);
  }

  createEffect(() => {
    recount();
    const current = prefixes();
    backend().count(current).then(
      s => prefixes() === current && setCounted({ prefixes: current, split: s }),
      e => setStatus({ text: String(e), tone: 'error' }),
    );
  });

  // The git branch where the session runs, as of the last look: tool calls may switch it too.
  const branchesNow = (): Branches => {
    try {
      return git?.branches() ?? { current: null, all: [], elsewhere: {} };
    } catch {
      return { current: null, all: [], elsewhere: {} };
    }
  };
  const branchNow = () => branchesNow().current;
  const [branch, setBranch] = createSignal(branchNow());
  // Switched outside the Gate too (another terminal): the header follows.
  const unwatch = git?.watch(() => setBranch(branchNow()));
  if (unwatch) onCleanup(unwatch);
  // The environment Note, refreshed when the environment changed.
  function refresh() {
    setBranch(branchNow());
    const edit = refreshEnvironment(events(), context(), project.environment());
    if (edit) append(edit);
  }
  refresh();

  // On send: the references are read into snapshots, a missing file aborts; the environment is refreshed.
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
    reading = false;
    setSelected(id);
  }

  // Appends the operation's event, or shows why not. Returns whether it was applied.
  function apply(result: ops.Outcome): boolean {
    if ('error' in result) setStatus({ text: result.error, tone: 'info' });
    else append(ops.attributed(result.event, 'user'));
    return !('error' in result);
  }
  // A Context operation on the selected block; `describe` gives the status line text afterwards.
  function operate(operation: (block: Block) => ops.Outcome, describe: (block: Block) => string | null) {
    const block = selectedBlock();
    if (!block || !apply(operation(block))) return;
    const text = describe(block);
    setStatus(text ? { text, tone: 'info' } : null);
  }

  // A Tool Pair is moved as a Note: the first press asks, the same key again converts it,
  // then the operation acts on the Note. `action` names the operation, `key` its key.
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
  // Not while a Kind Filter hides neighbours the block would move past.
  const hiding = () => shown().length < rows().length;
  function move(dir: -1 | 1) {
    if (hiding()) return;
    viaNote(`move ${dir}`, dir < 0 ? '⌥↑' : '⌥↓', () => operate(b => ops.move(context(), b, dir), () => null));
  }
  // A block as it is now, after an operation.
  const blockOf = (id: number) => context().blocks.find(b => b.id === id)!;
  const whole = (b: Block) => (ops.inPair(b) ? ' (whole Tool Pair)' : '');
  // d: the marked blocks, else the selected one.
  function remove() {
    const at = shown().indexOf(selected());
    if (marked().size) removeMarked();
    else operate(ops.remove, b => `removed${whole(b)} · struck through until sent · u = undo`);
    setMarked(new Set([...marked()].filter(id => sent().some(b => b.id === id))));
    selectAt(at);
  }
  function removeMarked() {
    const blocks = context().blocks.filter(b => marked().has(b.id));
    if (!apply(ops.removeAll(blocks))) return;
    setStatus({ text: `removed ${blocks.length} marked blocks · struck through until sent · u = undo`, tone: 'info' });
    setMarked(new Set<number>());
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
  // e: the selected block in $EDITOR; a changed save becomes a new Revision. Checked first: a
  // block that cannot be edited is not opened.
  async function editBlock() {
    const block = selectedBlock();
    const error = block ? ops.editable(block) : null;
    if (!block || error) return error && setStatus({ text: error, tone: 'info' });
    try {
      const text = await editor(block.content);
      operate(b => ops.edit(events(), b, text), b => edited(blockOf(b.id)));
      // A pending call edited is decided again by the rules.
      if (block.pending && blockOf(block.id).revision !== block.revision) advance([edited(blockOf(block.id))]);
    } catch (e) {
      setStatus({ text: `editor failed: ${errorText(e)} – unchanged`, tone: 'error' });
    }
  }
  // On an unread @path reference, e opens the file itself.
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
  // A Tool Pair is marked as a whole: it is compacted only as a whole; a pending Tool Call not at all.
  // Like d, the selection then moves on to the next row.
  function toggleMark() {
    const block = selectedBlock();
    if (!block || ops.isFixed(block) || block.pending) return;
    const pair = pairOf(context().blocks, block.id);
    const on = !marked().has(block.id);
    setMarked(new Set([...marked()].filter(id => !pair.includes(id)).concat(on ? pair : [])));
    selectAt(Math.max(...pair.map(id => shown().indexOf(id))) + 1);
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
  // `policy`: what the active policy did before the request.
  function finish(result: ChatResult, policy: string | null) {
    // Calls to a tool denied by rule are parsed too: they are answered "denied by rule".
    const { events, notRun } = answerBlocks(result, nextId(), [...toolsOn(), ...deniedTools(rules())]);
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
    const text = [policy, status.text, miss && `⚠ ${miss}`].filter(Boolean).join(' · ');
    setStatus({ text, tone: miss ? 'warn' : status.tone });
  }

  // Tool Approval ----------------------------------------------------------------------------
  // The rules for a call: built-in, global and project rules, then the ones allowed for this session; last match wins.
  const rules = () => [...approval.permissions().rules, ...sessionAllowed(events())];
  const verdictOf = (call: Block): Verdict => decide(call, { rules: rules(), split: approval.split, root: approval.root });

  // Whether the answer's calls leave the results for review at the Gate: one was not run (rejected, denied, not a
  // bash call) or was stopped (killed, timeout). Otherwise, once every call ran, the results are sent.
  let held = false;

  // What happens to a call: it runs (allow), waits for the user (ask) or is denied. Auto-approve runs what a rule
  // asks for; a deny stays a deny, a Question still waits for its answer.
  function decided(call: Block): Verdict['action'] {
    const { action } = verdictOf(call);
    if (call.tool === 'question') return action === 'deny' ? 'deny' : 'ask';
    return action === 'ask' && autoApprove.on() ? 'allow' : action;
  }

  // Esc while an answer streams or a call runs: the step finishes, then the tool loop stops at the Gate for changes;
  // Esc again aborts the step. Enter goes on.
  const [stopping, setStopping] = createSignal(false);
  // Esc: the first stops after the step, the second aborts it (then the loop stops anyway); a policy's or the
  // user's Compaction is aborted at once.
  function abort() {
    const step = streaming() ?? running();
    if (step && !stopping()) return void setStopping(true);
    setStopping(false);
    (policing() ?? (step ?? compacting())?.abort)?.abort();
  }
  // The loop goes on after a step, unless Esc asked to stop: then the next call waits, its results are held.
  function goOn(notes: string[]) {
    if (!stopping()) return advance(notes);
    setStopping(false);
    held = true;
    follow(ops.nextCall(context())?.id ?? nextId());
    setStatus({ text: [...notes, 'stopped – make your changes, Enter goes on'].join(' · '), tone: 'info' });
  }

  // Decides the pending calls in order: an allowed one runs, a denied one is answered "denied by rule", the
  // first to ask for is selected. Then the results are sent, or held at the Gate. notes: what happened so far.
  function advance(notes: string[] = []) {
    for (let call = ops.nextCall(context()); call; call = ops.nextCall(context())) {
      const action = decided(call);
      if (action === 'allow') return void run(call, notes);
      if (action !== 'deny') return awaitUser(call, notes);
      follow(nextId());
      held = true;
      apply(ops.deny(context(), call, nextId()));
      notes = [...notes, `⚠ denied by rule: ${titleOf(call)}`];
    }
    if (!held) return void send();
    setStatus({ text: `${notes.join(' · ') || 'tool loop paused'} – review the results, Enter sends`, tone: notes.length ? 'warn' : 'ok' });
  }

  // The call waits for the user: a Question for its answer in the dock (it never needs Tool Approval), others for approval.
  function awaitUser(call: Block, notes: string[]) {
    follow(call.id);
    setStatus({ text: [...notes, call.tool === 'question' ? `? ${QUESTION_HINT}` : `? approve – ${APPROVE}`].join(' · '), tone: 'warn' });
  }

  // Runs the call with its tool's runner; its output streams into a live Tool Result row, then the next call is decided.
  async function run(call: Block, notes: string[]) {
    const abort = new AbortController();
    const tool = call.tool === 'search' ? searcher : runner;
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
      setBranch(branchNow());
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
    if (call?.tool !== 'question' || streaming() || running() || verdictOf(call).action === 'deny') return null;
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
    const block = selectedBlock();
    const error = block?.tool === 'question' && block.pending ? QUESTION_HINT : block ? ops.approvable(context(), block) : 'not awaiting approval';
    if (error) setStatus({ text: error, tone: 'info' });
    else reading = false;
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
    const found = sessionRules(verdictOf(call));
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

  // Why the Context cannot be sent now, or null: calls await approval, or the model has answered
  // and nothing changed since.
  function unsendable(): Status | null {
    const pending = ops.nextCall(context());
    if (pending) {
      reading = false;
      setSelected(pending.id);
      return { text: pending.tool === 'question' ? QUESTION_HINT : `Tool Calls await approval – ${APPROVE} on the ? approve row`, tone: 'warn' };
    }
    const changed = lastAnswer() !== null && !same(lastAnswer(), request());
    return changed || asksForAnswer(sent(), openingBlocks(events())) ? null : { text: 'nothing to send – Tab to write', tone: 'info' };
  }

  // A Context as big as the window is not sent; the user makes room.
  function overBudget(total: number): boolean {
    const { over } = budgetOf(total);
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
    return !blocked() && prepare() && (await runPolicy(policy));
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

  const idle = () => !streaming() && !running() && !policing();
  // Calls left pending by a stop go on as the rules decide them; one to ask for still blocks the send.
  function wentOn(): boolean {
    const pending = ops.nextCall(context());
    if (!pending || decided(pending) === 'ask') return false;
    held = false;
    advance();
    return true;
  }

  // The check stays synchronous without a policy: a second send in the same tick finds the first streaming.
  async function send() {
    if (!idle() || wentOn()) return;
    const policy = policies.active();
    if (!(policy ? await readyWith(policy) : ready())) return;
    const did = ran;
    ran = null;
    const requested = prefixes();
    const payload = requested.at(-1)!;
    const abort = new AbortController();
    setStopping(false);
    setStreaming({ thinking: '', text: '', abort });
    setStatus(null);
    try {
      const { total } = await backend().count(requested);
      if (halted(abort.signal.aborted, total)) return withDid(did);
      append({ type: 'RequestSent', hash: Bun.hash(JSON.stringify(payload)).toString(16), tokens: total });
      setMarked(new Set<number>());
      follow(nextId());
      const onThinking = (d: string) => setStreaming({ ...streaming()!, thinking: streaming()!.thinking + d });
      // The answer follows its reasoning: the selection moves on with it.
      const onDelta = (d: string) => {
        const { thinking, text } = streaming()!;
        if (thinking && !text && selected() === nextId()) follow(nextId() + 1);
        setStreaming({ ...streaming()!, text: text + d });
      };
      const result = await backend().chat(payload, { signal: abort.signal, onDelta, onThinking, maxTokens: budgetOf(total).maxTokens });
      setStreaming(null);
      finish(result, did);
    } catch (e) {
      setStreaming(null);
      setStatus({ text: `backend error: ${errorText(e)}`, tone: 'error' });
      withDid(did);
    }
    keepSelection();
  }

  // Context Policy (ADR 0001) ---------------------------------------------------------------
  // What the policy did before the request being sent, for its status line.
  let ran: string | null = null;
  // A request not sent after the policy ran still says what the policy did.
  const withDid = (did: string | null) => void (did && setStatus({ ...status()!, text: `${status()!.text} · ${did}` }));
  // The active policy edits the Context; an error, its Compaction's too, stops the Gate: nothing is sent.
  async function runPolicy(policy: Policy): Promise<boolean> {
    const abort = new AbortController();
    setPolicing(abort);
    setStatus({ text: `policy ${policy.name} running`, tone: 'warn' });
    try {
      const { changes, error } = await applyPolicy(policy, policyPorts(abort.signal));
      const did = changes.length ? summary(policy.name, changes) : null;
      if (error) setStatus({ text: [`policy ${policy.name}: ${error} – not sent`, did].filter(Boolean).join(' · '), tone: 'error' });
      else ran = did;
      return !error;
    } catch (e) {
      setStatus({ text: `policy ${policy.name}: ${errorText(e)} – not sent`, tone: 'error' });
      return false;
    } finally {
      setPolicing(null);
      keepSelection();
    }
  }
  const policyPorts = (signal: AbortSignal): Ports => ({
    events, append, window: backend().window, aborted: () => signal.aborted,
    count: context => backend().count(renderPrefixes(context)),
    compact: (context, sources, instruction, inContext) =>
      policyCompaction(inContext ? compaction.inContextRequest(context, instruction) : compaction.compactionRequest(context, sources, instruction), signal),
  });
  // A policy's Compaction runs like the user's, without review; its Note is the answer.
  async function policyCompaction(request: Request, signal: AbortSignal): Promise<string> {
    const own = await compactor();
    const on = own?.backend ?? backend();
    try {
      const { total } = await on.count([request]);
      if (total >= on.window) throw new Error(`request ${formatTokens(total)} ≥ window ${formatTokens(on.window)}`);
      const result = await on.chat(request, { signal, onDelta: () => {}, maxTokens: on.window - total });
      if (result.finish === 'aborted' || result.finish === 'length') throw new Error(result.finish === 'length' ? 'cut off at max_tokens' : 'aborted');
      return (request.answerStart ?? '') + result.content;
    } finally {
      // The session's server cache now holds the compaction request.
      if (!own) setRecount(recount() + 1);
    }
  }

  // /policy <name> switches a policy on, /policy off off; alone it shows the active one and the names.
  function switchPolicy(name: string) {
    const values = ['off', ...policies.all.map(p => p.name)].join(' ');
    if (!name) return setStatus({ text: `policy ${policies.active()?.name ?? 'off'} · /policy ${values}`, tone: 'info' });
    const chosen = name === 'off' ? null : policies.all.find(p => p.name === name);
    if (chosen === undefined) return setStatus({ text: `unknown policy ${name}: ${values}`, tone: 'error' });
    policies.set(chosen);
    setStatus({ text: chosen ? `policy ${chosen.name} on – edits the Context before every request` : 'policy off', tone: 'info' });
  }

  // /auto switches auto-approve on or off; a call awaiting approval then runs at once.
  function switchAutoApprove() {
    autoApprove.set(!autoApprove.on());
    const text = autoApprove.on() ? 'auto-approve on – Tool Calls run without asking, deny rules still apply' : 'auto-approve off';
    const call = ops.nextCall(context());
    if (autoApprove.on() && call && call.tool !== 'question' && !running() && !streaming()) return advance([text]);
    setStatus({ text, tone: 'info' });
  }

  // Compaction ------------------------------------------------------------------------------
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
    const found = compaction.sourcesOf(context(), marked(), selectedBlock()?.id ?? -1);
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
  async function runCompaction(draft: string) {
    const c = compacting()!;
    const request = requestOf(c, draft);
    const abort = new AbortController();
    update({ phase: 'running', draft, abort });
    setStatus(null);
    try {
      const total = await fits(c, request);
      if (total !== null) await propose(c, request, draft, abort, c.backend.window - total);
    } catch (e) {
      endCompaction({ text: `compaction failed: ${errorText(e)}`, tone: 'error' });
    } finally {
      // The server's cache now holds the compaction request.
      if (c.same) setRecount(recount() + 1);
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
    const aborted = () => endCompaction({ text: 'compaction aborted – Context unchanged', tone: 'info' });
    if (abort.signal.aborted) return aborted();
    update({ attempt: c.attempt + 1, instruction: instructionOf(draft), text: '', after: null });
    setSelected(nextId());
    const onDelta = (d: string) => update({ text: compacting()!.text + d });
    const result = await c.backend.chat(request, { signal: abort.signal, onDelta, maxTokens });
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
  // The Context as it would be after accept, counted: the Note's tokens and the Context total.
  async function countProposal() {
    const c = compacting()!;
    const after = fold([...events(), { type: 'Compact', sources: c.sources, instruction: c.instruction, noteId: nextId(), content: c.text }]);
    const counted = await backend().count(renderPrefixes(after)).catch(() => null);
    const note = sentBlocks(after).findIndex(b => b.id === nextId());
    if (counted && compacting()?.text === c.text) update({ after: { note: counted.blocks[note]!, total: counted.total } });
  }
  // Under review: tokens before → after and the Context after accept; the cache effect.
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

  // Thinking for the following requests: the one set at the Gate, else the Model Profile's.
  const thinking = (): Thinking => context().thinking ?? backend().thinking ?? 'off';
  // The modes of the model's chat template, as the backend read them when it connected (session opened, setup).
  const thinkingModes = () => backend().thinkingModes ?? DEFAULT_MODES;
  // The options /thinking offers: `on` only when no efforts exist (edge case), otherwise the efforts with their labels.
  const thinkingOptions = () => {
    const modes = thinkingModes();
    const hasEfforts = modes.some(m => m !== 'off' && m !== 'on');
    const filtered = hasEfforts ? modes.filter(m => m !== 'on') : modes;
    return filtered.map(m => ({ name: thinkingLabel(m), value: m }));
  };
  function setThinking(arg: string) {
    const options = thinkingOptions();
    if (!options.length) return setStatus({ text: 'the chat template has no thinking switch', tone: 'info' });
    if (!arg) return setStatus({ text: `thinking ${thinkingLabel(thinking())} · /thinking ${options.map(o => o.name).join(' ')}`, tone: 'info' });
    const match = options.find(o => o.name === arg);
    if (!match) return setStatus({ text: `unknown thinking ${arg}: ${options.map(o => o.name).join(' ')}`, tone: 'error' });
    append({ type: 'ThinkingSet', thinking: match.value });
    setStatus({ text: `thinking ${thinkingLabel(match.value)}`, tone: 'info' });
  }

  function renameSession(title: string) {
    append({ type: 'SessionRenamed', title });
    setStatus({ text: title ? `session renamed: ${title}` : 'session title reset to the first User message', tone: 'info' });
  }

  // The tools in the Tools Block, switched on or off with /tools.
  const toolsOn = () => toolsIn(context().blocks.find(b => b.kind === 'Tools')?.content ?? '[]');
  function toggleTool(name: string) {
    if (!name) return setStatus({ text: `tools: ${toolsOn().join(', ') || 'none'} · /tools <tool> switches one`, tone: 'info' });
    if (!apply(ops.toggleTool(events(), context(), name, deniedTools(rules())))) return;
    setStatus({ text: `${name} ${toolsOn().includes(name) ? 'on' : 'off'} · u = undo`, tone: 'info' });
  }

  // /filter <kind> switches that Kind Filter on or off, /filter all shows every block; alone it lists them.
  // Marks on blocks now hidden are cleared: none stay hidden.
  function filterBy(name: string) {
    const values = `all ${FILTERS.map(f => f.name).join(' ')}`;
    const state = FILTERS.map(f => `${f.name} ${hidden().includes(f) ? 'off' : 'on'}`).join(', ');
    if (!name) return setStatus({ text: `filter: ${state} · /filter ${values}`, tone: 'info' });
    const chosen = FILTERS.find(f => f.name === name.toLowerCase());
    if (name.toLowerCase() === 'all') setHidden([]);
    else if (!chosen) return setStatus({ text: `unknown filter ${name}: ${values}`, tone: 'error' });
    else setHidden(hidden().includes(chosen) ? hidden().filter(f => f !== chosen) : FILTERS.filter(f => f === chosen || hidden().includes(f)));
    setMarked(new Set([...marked()].filter(id => shown().includes(id))));
  }

  // Git (only in a repository) -------------------------------------------------------------------------------
  // /git:branch <name> switches to an existing branch where the session runs; alone it shows the current one.
  function switchBranch(name: string) {
    const { current, all } = git!.branches();
    if (!name) return setStatus({ text: `branch ${current ?? '(detached)'} · /git:branch ${all.filter(b => b !== current).join(' ')}`, tone: 'info' });
    if (!idle()) return setStatus({ text: 'busy – switch the branch at the Gate', tone: 'info' });
    try {
      git!.switchBranch(name);
    } catch (e) {
      return setStatus({ text: `git: ${errorText(e)}`, tone: 'error' });
    }
    refresh();
    setStatus({ text: `switched to branch ${name}`, tone: 'ok' });
  }
  // /git:worktree on runs the session in its own worktree, off in the project again; the worktree stays for the
  // next on. Alone it says where the session runs.
  function switchWorktree(value: string) {
    const refusal = worktreeRefusal(value);
    if (refusal) return setStatus(refusal);
    try {
      const dir = git!.worktree(value === 'on');
      append({ type: 'WorktreeSet', on: value === 'on' });
      git!.reopen({ text: value === 'on' ? `worktree on – session runs in ${dir}` : `worktree off – session runs in ${dir}, worktree kept`, tone: 'ok' });
    } catch (e) {
      setStatus({ text: `git: ${errorText(e)}`, tone: 'error' });
    }
  }
  // Why /git:worktree <value> does not switch: no value, an unknown one, already so, or busy; null when it switches.
  function worktreeRefusal(value: string): Status | null {
    const now = inWorktree(events()) ? 'on' : 'off';
    if (!value) return { text: `worktree ${now} · runs in ${approval.root} · /git:worktree ${now === 'on' ? 'off' : 'on'}`, tone: 'info' };
    if (!['on', 'off'].includes(value)) return { text: `unknown value ${value}: /git:worktree on off`, tone: 'error' };
    if (value === now) return { text: `worktree already ${value}`, tone: 'info' };
    if (!idle()) return { text: 'busy – switch the worktree at the Gate', tone: 'info' };
    return null;
  }

  const commands: Record<CommandName, (arg: string) => void> = {
    '/sessions': openSessions, '/rename': renameSession, '/tools': toggleTool, '/filter': filterBy, '/policy': switchPolicy, '/auto': switchAutoApprove, '/thinking': setThinking,
    '/git:branch': switchBranch, '/git:worktree': switchWorktree,
  };
  // The commands offered: the /git: ones only in a git repository.
  const offered = COMMANDS.filter(c => git || !c.name.startsWith('/git:'));
  // Input text: a known command runs with the rest as argument; an unknown `/word` is an error; anything else becomes
  // a User block and is sent right away – if sending is blocked, the block stays and the status says why.
  function submit(text: string) {
    const name = text.trim().split(/\s/)[0]!;
    if (offered.some(c => c.name === name)) commands[name as CommandName](text.trim().slice(name.length).trim());
    else if (/^\/[\w:]+$/.test(name)) setStatus({ text: `unknown command ${name}: ${offered.map(c => c.name).join(' ')}`, tone: 'error' });
    else if (text.trim()) addInput(text);
  }
  // `@path` references become rows of their own before the text; only a text is sent right away.
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

  // Tools denied by rule leave the Tools Block, at open.
  function dropDenied() {
    const edit = ops.withoutDenied(events(), context(), deniedTools(rules()));
    if (edit) append(edit);
  }
  dropDenied();

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
    busy: () => streaming() !== null || running() !== null || policing() !== null || compacting()?.phase === 'running',
    status,
    rows,
    selected,
    selectedBlock,
    marked,
    hidden,
    hiding,
    passes,
    // The Kind Filters' share of the Context: the sent blocks shown, their tokens (null while counting).
    filterShare: () => {
      const indexes = sent().flatMap((b, i) => (hides(b.kind) ? [] : [i]));
      const s = split();
      return { blocks: indexes.length, all: sent().length, tokens: s && indexes.reduce((sum, i) => sum + s.blocks[i]!, 0), total: s && s.total };
    },
    window: () => backend().window,
    // The Context's budget; null while counting.
    budget: () => (split() ? budgetOf(split()!.total) : null),
    // Whether a sent block is still cached; null while counting.
    warm: (id: number) => warm()?.[sent().findIndex(b => b.id === id)] ?? null,
    profile: () => context().profile,
    // The active Context Policy and the ones to switch on (ADR 0001).
    policy: () => policies.active()?.name ?? null,
    policyNames: () => policies.all.map(p => p.name),
    policyDescription: (name: string) => policies.all.find(p => p.name === name)?.description ?? null,
    autoApprove: autoApprove.on,
    commands: offered,
    // Git where the session runs (null outside a repository): the branch, all branches with the other worktree holding
    // one, the worktree on or off.
    branch,
    branches: () => {
      const { all, elsewhere } = branchesNow();
      return all.map(name => ({ name, elsewhere: elsewhere[name] ?? null }));
    },
    worktree: () => inWorktree(events()),
    thinking,
    thinkingOptions,
    submit,
    // Enter: the user sends, the selection follows the answer.
    send: () => {
      reading = false;
      return send();
    },
    abort,
    stopping,
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
    decline,
    allowForSession,
    reject,
    // Why the rules ask for a pending call, per sub-command; null for any other block.
    verdict: (block: Block): Verdict | null => (block.pending && block.tool !== 'question' ? verdictOf(block) : null),
    asked,
    answer,
    select,
    move,
    remove,
    undo,
    edit: () => void edit(),
    copy: (text: string) => void copy(text),
    toggleMark,
    toolsOn,
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

// Project config may only tighten: its allow entries are ignored, and the Gate says so.
function ignoredHint(approval: Approval): string | null {
  const { ignored } = approval.permissions();
  return ignored.length ? `project config: allow ${quoted(ignored)} ignored (project config may only tighten)` : null;
}
const notRunText = (why: string) => `⚠ tool call not run: ${why}`;
const withHint = (status: Status | null, hint: string | null): Status | null =>
  hint ? { text: status ? `${status.text} · ${hint}` : hint, tone: 'warn' } : status;

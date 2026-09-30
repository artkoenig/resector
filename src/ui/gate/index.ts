// Review Gate: state and actions of the main screen, composed of its slices over one kernel.
import { createSignal } from 'solid-js';
import * as compaction from '../../core/compaction/compaction';
import * as ops from '../../core/context/operations';
import type { Verdict } from '../../core/approval/approval';
import type { Block } from '../../core/log/fold';
import { createCommands } from './commands';
import { createCompaction } from './compaction';
import { createEdits } from './edits';
import { createGit } from './git';
import { createKernel } from './kernel';
import { createPolicy } from './policy';
import { createRules, ignoredHint } from './rules';
import { createSelection } from './selection';
import { createSend } from './send';
import { createSettings } from './settings';
import { createToolLoop } from './tool-loop';
import type { AutoApprove, GateOptions, Policies, Status } from './types';

export * from './types';
export { COMMANDS } from './commands';
export { FILTERS, type Filter } from './selection';

const NO_POLICIES: Policies = { all: [], active: () => null, set: () => {} };

// Without an app-wide one, the Gate keeps its own, off.
function ownAutoApprove(): AutoApprove {
  const [on, set] = createSignal(false);
  return { on, set };
}

const withHint = (status: Status | null, hint: string | null): Status | null =>
  hint ? { text: status ? `${status.text} · ${hint}` : hint, tone: 'warn' } : status;

export function createGate({ log, openSessions, runner, searcher, approval, editor, clipboard, project, instruction = () => compaction.DEFAULT_INSTRUCTION, compactor = async () => null, policies = NO_POLICIES, autoApprove = ownAutoApprove(), hidden = ['tool-calls'], git = null, ...options }: GateOptions) {
  const k = createKernel({ log, project, backend: options.backend, events: options.events, status: withHint(options.notice ?? null, ignoredHint(approval)) });
  const sel = createSelection(k, hidden);
  const repo = createGit(k, git, project, approval.root);
  const rules = createRules(k, approval, autoApprove);
  const loop = createToolLoop(k, sel, rules, repo, { runner, searcher, send: () => void sender.send() });
  const policy = createPolicy(k, sel, policies, compactor);
  const sender = createSend(k, sel, { loop, policy, git: repo, project, policies });
  const compacting = createCompaction(k, sel, { editor, instruction, compactor });
  const edits = createEdits(k, sel, loop, { editor, clipboard, project });
  const settings = createSettings(k, sel, rules, loop, autoApprove);
  const input = createCommands(k, sel, {
    '/sessions': openSessions, '/rename': settings.renameSession, '/tools': settings.toggleTool, '/filter': settings.filterBy, '/policy': policy.switchPolicy,
    '/auto': settings.switchAutoApprove, '/thinking': settings.setThinking, '/git:branch': repo.switchBranch, '/git:worktree': repo.switchWorktree,
  }, { inRepo: !!git, send: () => void sender.send() });

  rules.dropDenied();
  // Calls still pending when the Gate opens (resume) are decided like fresh ones.
  if (ops.nextCall(k.context())) queueMicrotask(() => loop.advance(k.status() ? [k.status()!.text] : []));

  const { split, sent } = k;
  return {
    context: k.context,
    sent,
    split,
    streaming: k.streaming,
    running: k.running,
    // The name of the policy editing the Context before a request.
    policing: () => k.policing()?.name ?? null,
    live: sel.live,
    // Streaming or running: only Esc (abort, kill) acts.
    nextCall: () => ops.nextCall(k.context()),
    busy: () => k.streaming() !== null || k.running() !== null || k.policing() !== null || k.compacting()?.phase === 'running',
    status: k.status,
    rows: sel.rows,
    selected: sel.selected,
    selectedBlock: sel.selectedBlock,
    marked: sel.marked,
    hidden: sel.hidden,
    hiding: sel.hiding,
    passes: sel.passes,
    // The Kind Filters' share of the Context: the sent blocks shown, their tokens (null while counting).
    filterShare: () => {
      const indexes = sent().flatMap((b, i) => (sel.hides(b.kind) ? [] : [i]));
      const s = split();
      return { blocks: indexes.length, all: sent().length, tokens: s && indexes.reduce((sum, i) => sum + s.blocks[i]!, 0), total: s && s.total };
    },
    window: () => k.backend().window,
    // The Context's budget; null while counting.
    budget: () => (split() ? k.budgetOf(split()!.total) : null),
    // A sent block's tokens; null while it is counted.
    blockTokens: (id: number) => k.known()?.blocks[sent().findIndex(b => b.id === id)] ?? null,
    // Whether a sent block is still cached; null while it is counted.
    warm: (id: number) => k.warm()?.[sent().findIndex(b => b.id === id)] ?? null,
    profile: () => k.context().profile,
    // The active Context Policy and the ones to switch on (ADR 0001).
    policy: () => policies.active()?.name ?? null,
    policyNames: () => policies.all.map(p => p.name),
    policyDescription: (name: string) => policies.all.find(p => p.name === name)?.description ?? null,
    autoApprove: autoApprove.on,
    commands: input.commands,
    // Git where the session runs (null outside a repository): the branch, all branches with the other worktree holding
    // one, the worktree on or off.
    branch: repo.branch,
    branches: repo.branches,
    worktree: repo.worktree,
    thinking: settings.thinking,
    thinkingOptions: settings.thinkingOptions,
    submit: input.submit,
    // Enter: the user sends, the selection follows the answer.
    send: () => {
      sel.release();
      return sender.send();
    },
    abort: loop.abort,
    stopping: loop.stopping,
    ...compacting,
    approve: loop.approve,
    decline: loop.decline,
    allowForSession: loop.allowForSession,
    reject: loop.reject,
    // Why the rules ask for a pending call, per sub-command; null for any other block.
    verdict: (block: Block): Verdict | null => (block.pending && block.tool !== 'question' ? rules.verdictOf(block) : null),
    asked: loop.asked,
    answer: loop.answer,
    select: sel.select,
    ...edits,
    toolsOn: k.toolsOn,
    clearMarks: () => sel.setMarked(new Set<number>()),
    dismiss: () => k.setStatus(null),
  };
}

export type Gate = ReturnType<typeof createGate>;

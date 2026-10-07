// Review Gate: the request cycle the user steers, composed of its slices over one kernel; it acts on the view's selection (View).
import { createSignal } from 'solid-js';
import * as compaction from '../core/compaction/compaction';
import * as ops from '../core/context/operations';
import { createCommands } from './commands';
import { createCompaction } from './compaction';
import { createEdits } from './edits';
import { createGit } from './git';
import { createKernel } from './kernel';
import { createPolicy } from './policy';
import { createRules } from './rules';
import { createSend } from './send';
import { createSettings } from './settings';
import { createToolLoop } from './tool-loop';
import type { Kernel } from './kernel';
import type { AutoApprove, GateOptions, Policies, View } from './types';

export * from './types';
export type * from './ports';
export { COMMANDS } from './commands';
export type { Kernel } from './kernel';

const NO_POLICIES: Policies = { all: [], active: () => null, set: () => {} };

// Without an app-wide one, the Gate keeps its own, off.
function ownAutoApprove(): AutoApprove {
  const [on, set] = createSignal(false);
  return { on, set };
}

export function createGate({ log, openSessions, runner, searcher, approval, editor, clipboard, project, instruction = () => compaction.DEFAULT_INSTRUCTION, compactor = async () => null, policies = NO_POLICIES, autoApprove = ownAutoApprove(), git = null, ...options }: GateOptions, view: (k: Kernel) => View) {
  const k = createKernel({ log, project, backend: options.backend, events: options.events, status: options.notice ?? null });
  const sel = view(k);
  const repo = createGit(k, git, project, approval.root);
  const rules = createRules(k, approval, autoApprove);
  const loop = createToolLoop(k, sel, rules, repo, { runner, searcher, send: () => void sender.api.send() });
  const policy = createPolicy(k, sel, policies, compactor);
  const sender = createSend(k, sel, { loop, policy, git: repo, project, policies });
  const compacting = createCompaction(k, sel, { editor, instruction, compactor });
  const edits = createEdits(k, sel, loop, { editor, clipboard, project });
  const settings = createSettings(k, rules, loop, autoApprove);
  const input = createCommands(k, sel, {
    '/sessions': openSessions, '/rename': settings.renameSession, '/tools': settings.toggleTool, '/filter': sel.filterBy, '/policy': policy.switchPolicy,
    '/auto': settings.switchAutoApprove, '/thinking': settings.setThinking, '/git:branch': repo.switchBranch, '/git:worktree': repo.switchWorktree,
  }, { inRepo: !!git, send: () => void sender.api.send() });

  rules.dropDenied();
  // Calls still pending when the Gate opens (resume) are decided like fresh ones.
  if (ops.nextCall(k.context())) queueMicrotask(() => loop.advance(k.status() ? [k.status()!.text] : []));

  const { split, sent } = k;
  return {
    context: k.context,
    reviewed: k.reviewed,
    sent,
    split,
    streaming: k.streaming,
    running: k.running,
    // Streaming or running: only Esc (abort, kill) acts.
    busy: () => k.streaming() !== null || k.running() !== null || k.policing() !== null || k.compacting()?.phase === 'running',
    status: k.status,
    window: () => k.backend().window,
    // The Context's budget; null while counting.
    budget: () => (split() ? k.budgetOf(split()!.total) : null),
    // A sent block's tokens; null while it is counted.
    blockTokens: (id: number) => k.known()?.blocks[sent().findIndex(b => b.id === id)] ?? null,
    // Whether a sent block is still cached; null while it is counted.
    warm: (id: number) => k.warm()?.[sent().findIndex(b => b.id === id)] ?? null,
    profile: () => k.context().profile,
    toolsOn: k.toolsOn,
    dismiss: () => k.setStatus(null),
    // Each slice's own: what the view shows and does.
    ...policy.api,
    ...loop.api,
    ...rules.api,
    ...repo.api,
    ...settings.api,
    ...input.api,
    ...sender.api,
    ...compacting.api,
    ...edits.api,
  };
}

export type Gate = ReturnType<typeof createGate>;

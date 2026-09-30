// Tool Approval at the Gate: the rules for a call, what happens to it, and the tools the rules deny.
import { deniedTools, quoted, sessionAllowed, verdictOf as decide, type Verdict } from '../../core/approval/approval';
import * as ops from '../../core/context/operations';
import type { Block } from '../../core/log/fold';
import type { Kernel } from './kernel';
import type { Approval, AutoApprove } from './types';

export type Rules = ReturnType<typeof createRules>;

export function createRules(k: Kernel, approval: Approval, autoApprove: AutoApprove) {
  // The rules for a call: built-in, global and project rules, then the ones allowed for this session; last match wins.
  const rules = () => [...approval.permissions().rules, ...sessionAllowed(k.events())];
  const verdictOf = (call: Block): Verdict => decide(call, { rules: rules(), split: approval.split, root: approval.root });
  const denied = () => deniedTools(rules());

  // What happens to a call: it runs (allow), waits for the user (ask) or is denied. Auto-approve runs what a rule
  // asks for; a deny stays a deny, a Question still waits for its answer.
  function decided(call: Block): Verdict['action'] {
    const { action } = verdictOf(call);
    if (call.tool === 'question') return action === 'deny' ? 'deny' : 'ask';
    return action === 'ask' && autoApprove.on() ? 'allow' : action;
  }

  // Tools denied by rule leave the Tools Block, at open.
  function dropDenied() {
    const edit = ops.withoutDenied(k.events(), k.context(), denied());
    if (edit) k.append(edit);
  }

  return { rules, verdictOf, denied, decided, dropDenied };
}

// Project config may only tighten: its allow entries are ignored, and the Gate says so.
export function ignoredHint(approval: Approval): string | null {
  const { ignored } = approval.permissions();
  return ignored.length ? `project config: allow ${quoted(ignored)} ignored (project config may only tighten)` : null;
}

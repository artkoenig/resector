// The policy hook before every request (ADR 0001): call the policy, apply its operations as attributed Session Log
// events, call it again until it returns nothing.
import * as ops from '../context/operations';
import type { SessionEvent } from '../log/events';
import { fold, type Context } from '../log/fold';
import { plan, type Change, type Compaction } from './plan';
import { parse, viewOf, type Policy, type PolicyContext, type PolicyOperation, type Situation } from './policy';

// Passes applying operations per request: a call after them still returning operations stops the Gate.
export const MAX_PASSES = 8;

// What the policy hook needs from the Gate: the Session Log, the token count of a Context, the Situation passed on to
// the policy, and a Compaction's Note (on the Model Profile's compactionProfile); a failing Compaction throws.
export type Ports = {
  events: () => SessionEvent[];
  append: (event: SessionEvent) => void;
  count: (context: Context) => Promise<{ blocks: number[]; total: number }>;
  situation: Situation;
  compact: (context: Context, sources: number[], instruction: string, inContext?: boolean) => Promise<string>;
  // Esc at the Gate: no further pass or operation.
  aborted: () => boolean;
};
// What the policy did, and why it stopped the Gate (null: the Context may be sent).
export type Ran = { changes: Change[]; error: string | null };

const ABORTED = 'aborted';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function applyPolicy(policy: Policy, ports: Ports): Promise<Ran> {
  const changes: Change[] = [];
  for (let pass = 1; ; pass++) {
    if (ports.aborted()) return { changes, error: ABORTED };
    const context = fold(ports.events());
    const operations = await called(policy, viewOf(context, await ports.count(context), ports.situation));
    if ('error' in operations) return { changes, error: operations.error };
    if (!operations.length) return { changes, error: null };
    if (pass > MAX_PASSES) return { changes, error: `still changing the Context after ${MAX_PASSES} passes` };
    const error = await applyAll(policy.name, operations, ports, changes);
    if (error) return { changes, error };
  }
}

// One pass: the operations in turn, until one is refused or Esc is pressed.
async function applyAll(by: string, operations: unknown[], ports: Ports, changes: Change[]): Promise<string | null> {
  for (const op of operations) {
    const error = ports.aborted() ? ABORTED : await applyOne(by, op, ports, changes);
    if (error) return error;
  }
  return null;
}

// The policy's operations for the view, or why none: it threw, or returned no list.
async function called(policy: Policy, view: PolicyContext): Promise<unknown[] | { error: string }> {
  try {
    const operations: unknown = await policy.run(view);
    return Array.isArray(operations) ? operations : { error: 'returned no list of operations' };
  } catch (e) {
    return { error: `failed: ${message(e)}` };
  }
}

// One operation of the policy `by`; its change is added to `changes`. Returns why not, if not.
async function applyOne(by: string, value: unknown, ports: Ports, changes: Change[]): Promise<string | null> {
  const op = parse(value);
  if ('error' in op) return op.error;
  const planned = plan(ports.events(), op);
  const events = 'error' in planned ? planned : 'compact' in planned ? await compacted(planned.compact, ports) : planned.events;
  if ('error' in events) return `${opText(op)}: ${events.error}`;
  events.forEach(event => ports.append(ops.attributed(event, by)));
  changes.push((planned as { change: Change }).change);
  return null;
}

// The Compaction's Note, accepted without review.
async function compacted({ sources, instruction, inContext }: Compaction, ports: Ports): Promise<SessionEvent[] | { error: string }> {
  const context = fold(ports.events());
  const failed = (why: string) => ({ error: `compaction failed: ${why}` });
  try {
    const content = await ports.compact(context, sources, instruction, inContext);
    return content.trim() ? [{ type: 'Compact', sources, instruction, noteId: context.nextId, content }] : failed('empty Note');
  } catch (e) {
    return failed(message(e));
  }
}

// The operation as the status line names it: `remove 5`, `move 5 after 3`, `compact 3 4`, `note after 2`.
function opText(op: PolicyOperation): string {
  if (op.op === 'compact') return `compact ${op.sources.join(' ')}`;
  if (op.op === 'note') return `note after ${op.after}`;
  return `${op.op} ${op.id}${op.op === 'move' ? ` after ${op.after}` : ''}`;
}

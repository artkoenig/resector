// Context Policies (ADR 0001): a stateless function over the Context whose operations the harness applies before
// every request, checked by the same rules as the user's, until it returns nothing.
import { z } from 'zod';
import * as ops from '../context/operations';
import type { Kind, Origin, SessionEvent } from '../log/events';
import { fold, pairOf, type Block, type Context } from '../log/fold';
import { sentBlocks } from '../render/native';

// A Context Block as a policy sees it: tokens as rendered, the other block of its Tool Pair, whether it awaits approval.
export type PolicyBlock = { id: number; kind: Kind; origin: Origin; content: string; tokens: number; pair: number | null; pending: boolean };
// The Context the next request sends, the window and the tokens it takes.
export type PolicyContext = { window: number; used: number; blocks: PolicyBlock[] };

const id = z.number().int();
const OPERATION = z.discriminatedUnion('op', [
  z.object({ op: z.literal('remove'), id }),
  // inContext: the Compaction continues the Context as sent, the instruction appended (the server's prefix cache holds it).
  z.object({ op: z.literal('compact'), sources: z.array(id), instruction: z.string(), inContext: z.boolean().optional() }),
  z.object({ op: z.literal('edit'), id, content: z.string() }),
  z.object({ op: z.literal('move'), id, after: id }),
  z.object({ op: z.literal('note'), after: id, content: z.string() }),
]);
export type PolicyOperation = z.infer<typeof OPERATION>;
// A policy module's default export; built-in policies are written the same way.
export type PolicyFunction = (context: PolicyContext) => PolicyOperation[] | Promise<PolicyOperation[]>;
// name: the module's file name; description: its `description` export, shown when choosing a policy.
export type Policy = { name: string; run: PolicyFunction; description?: string };

// Passes applying operations per request: a call after them still returning operations stops the Gate.
export const MAX_PASSES = 8;

export function viewOf(context: Context, counted: { blocks: number[]; total: number }, window: number): PolicyContext {
  const blocks = sentBlocks(context);
  const view = ({ id, kind, origin, content, pending }: Block, i: number): PolicyBlock => ({
    id, kind, origin, content, tokens: counted.blocks[i]!, pair: pairOf(blocks, id).find(other => other !== id) ?? null, pending: pending === true,
  });
  return { window, used: counted.total, blocks: blocks.map(view) };
}

// What an operation did, for the status line: counted (`3 Tool Pairs removed`) or as is (a Compaction).
export type Change = { noun: string; verb: string } | { text: string };
// The events an operation appends, or the Compaction to run first; or why not.
export type Plan = { events: SessionEvent[]; change: Change } | { compact: Compaction; change: Change } | { error: string };
type Compaction = { sources: number[]; instruction: string; inContext?: boolean };
type Of<O extends PolicyOperation['op']> = Extract<PolicyOperation, { op: O }>;
type Planner<O extends PolicyOperation['op']> = (events: SessionEvent[], context: Context, op: Of<O>) => Plan;

const EDITED = { noun: 'block', verb: 'edited' };
const MOVED = { noun: 'block', verb: 'moved' };
// A Tool Pair counts once, as a pair.
const nounOf = (block: Block) => (ops.inPair(block) ? 'Tool Pair' : block.kind);
const done = (outcome: ops.Outcome, change: Change): Plan => ('error' in outcome ? outcome : { events: [outcome.event], change });

const PLANNERS: { [O in PolicyOperation['op']]: Planner<O> } = {
  remove: (_, context, op) => withBlock(context, op.id, block => done(ops.remove(block), { noun: nounOf(block), verb: 'removed' })),
  edit: (events, context, op) => withBlock(context, op.id, block => {
    const error = ops.untouchable(block)?.error ?? ops.editable(block);
    return error ? { error } : done(ops.revise(events, block, op.content), EDITED);
  }),
  move: (events, context, op) => withBlock(context, op.id, block => (ops.inPair(block) ? moveAsNote(events, context, block, op.after) : done(ops.moveAfter(context, block, op.after), MOVED))),
  compact: (_, context, op) => compactPlan(context, op),
  note: (_, context, op) => done(ops.addNote(context, context.nextId, op.after, op.content), { noun: 'Note', verb: 'added' }),
};

// A policy's module is not type-checked when loaded: what it returns is checked here.
export function parse(op: unknown): PolicyOperation | { error: string } {
  const parsed = OPERATION.safeParse(op);
  return parsed.success ? parsed.data : { error: `not an operation: ${JSON.stringify(op)}` };
}

// The operation checked against the Context of the Session Log; operations refer to blocks by id.
export function plan(events: SessionEvent[], op: PolicyOperation): Plan {
  return (PLANNERS[op.op] as Planner<PolicyOperation['op']>)(events, fold(events), op);
}

const sent = (context: Context, id: number) => sentBlocks(context).find(b => b.id === id);
function withBlock(context: Context, id: number, then: (block: Block) => Plan): Plan {
  const block = sent(context, id);
  return block ? then(block) : { error: `no block ${id} in the Context` };
}

// Moving a Tool Pair turns it into a Note first; the Note then moves.
function moveAsNote(events: SessionEvent[], context: Context, block: Block, after: number): Plan {
  const note = ops.toNote(block, context.nextId) as { event: SessionEvent };
  const converted = fold([...events, note.event]);
  const moved = ops.moveAfter(converted, sent(converted, context.nextId)!, after);
  return 'error' in moved ? moved : { events: [note.event, moved.event], change: MOVED };
}

// Why a source may not be compacted, if not.
function unfit(context: Context, id: number): string | undefined {
  const block = sent(context, id);
  return block ? ops.untouchable(block)?.error : `no block ${id} in the Context`;
}

function compactPlan(context: Context, { sources, instruction, inContext }: Of<'compact'>): Plan {
  const error = sources.map(id => unfit(context, id)).find(Boolean);
  if (error) return { error };
  if (!sources.length) return { error: 'nothing to compact' };
  if (!instruction.trim()) return { error: 'no instruction' };
  const wanted = new Set(sources.flatMap(id => pairOf(context.blocks, id)));
  const ordered = sentBlocks(context).filter(b => wanted.has(b.id));
  // Kinds in Context order, a Tool Pair once.
  const nouns = new Map<string, number>();
  for (const b of ordered.filter(b => b.kind !== 'Tool Result')) nouns.set(nounOf(b), (nouns.get(nounOf(b)) ?? 0) + 1);
  const text = [...nouns].map(([noun, n]) => `${n} ${noun}`).join(' + ');
  return { compact: { sources: ordered.map(b => b.id), instruction, ...(inContext && { inContext }) }, change: { text: `${text} → 1 Note` } };
}

// Counted nouns in plural; a kind reads as is (`2 Thinking removed`).
const PLURAL = new Set(['Tool Pair', 'block']);
// The status line after the policy ran: `thinking-trail: 3 Tool Pairs removed, 5 Thinking → 1 Note`.
export function summary(name: string, changes: Change[]): string {
  type Counted = { noun: string; verb: string; n: number };
  const counts = new Map<string, Counted>();
  const parts: (string | Counted)[] = [];
  for (const change of changes) {
    if ('text' in change) {
      parts.push(change.text);
      continue;
    }
    const key = `${change.noun} ${change.verb}`;
    const counted = counts.get(key) ?? { ...change, n: 0 };
    if (!counted.n++) parts.push(counts.set(key, counted).get(key)!);
  }
  const text = (part: string | Counted) => (typeof part === 'string' ? part : `${part.n} ${part.noun}${part.n > 1 && PLURAL.has(part.noun) ? 's' : ''} ${part.verb}`);
  return `${name}: ${parts.map(text).join(', ') || 'no change'}`;
}

// What the policy hook needs from the Gate: the Session Log, the token count of a Context, the window, and a
// Compaction's Note (on the Model Profile's compactionProfile); a failing Compaction throws.
export type Ports = {
  events: () => SessionEvent[];
  append: (event: SessionEvent) => void;
  count: (context: Context) => Promise<{ blocks: number[]; total: number }>;
  window: number;
  compact: (context: Context, sources: number[], instruction: string, inContext?: boolean) => Promise<string>;
  // Esc at the Gate: no further pass or operation.
  aborted: () => boolean;
};
// What the policy did, and why it stopped the Gate (null: the Context may be sent).
export type Ran = { changes: Change[]; error: string | null };

const ABORTED = 'aborted';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The hook before every request: call the policy, apply its operations as attributed Session Log events, call it
// again until it returns nothing (ADR 0001).
export async function applyPolicy(policy: Policy, ports: Ports): Promise<Ran> {
  const changes: Change[] = [];
  for (let pass = 1; ; pass++) {
    if (ports.aborted()) return { changes, error: ABORTED };
    const context = fold(ports.events());
    const operations = await called(policy, viewOf(context, await ports.count(context), ports.window));
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

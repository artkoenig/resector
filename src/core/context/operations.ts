// Context operations at the Review Gate (FR-4, FR-10, NFR-3): each yields the event to append, or why not.
import type { SessionEvent } from '../log/events';
import { undone, type Block, type Context } from '../log/fold';
import * as bash from '../toolcall/bash';
import { resultText, type RunResult } from '../toolcall/bash';

export type Outcome<E extends SessionEvent = SessionEvent> = { event: E } | { error: string };
type Undo = Extract<SessionEvent, { type: 'Undo' }>;

type BlockAdded = Extract<SessionEvent, { type: 'BlockAdded' }>;

// System and Tools Block stay first: never moved, pinned, removed or marked (FR-12).
export const isFixed = (block: Block) => block.kind === 'System' || block.kind === 'Tools';
const NAME = { System: 'System prompt', Tools: 'Tools Block' } as Record<string, string>;
const fixed = (block: Block) => ({ error: `${NAME[block.kind]} is fixed` });
// A Tool Call awaiting approval keeps its place until it has a result.
const AWAITS = { error: 'Tool Call awaits approval – y run once · a allow for session · n reject · e edit' };
// Why an operation may not touch the block, if not.
const guard = (block: Block) => (isFixed(block) ? fixed(block) : block.pending ? AWAITS : null);
const UNDOABLE = new Set<SessionEvent['type']>(['Move', 'Pin', 'Unpin', 'Remove', 'Rename', 'Edit', 'PairToNote', 'Compact']);

const isTool = (block: Block | undefined) => block?.kind === 'Tool Call' || block?.kind === 'Tool Result';
// Tool Call and Tool Result behave as a unit once the call has run (FR-9).
export const inPair = (block: Block) => block.kind === 'Tool Result' || (block.kind === 'Tool Call' && !block.pending);

export function move({ blocks }: Context, block: Block, dir: -1 | 1): Outcome {
  const blocked = guard(block);
  if (blocked) return blocked;
  const live = blocks.filter(b => !b.removed);
  let far = live.indexOf(block) + dir;
  const neighbour = live[far];
  // Blocks move only inside their area: top pins, unpinned, bottom pins; System stays first.
  if (!neighbour || isFixed(neighbour) || neighbour.pin !== block.pin) return { error: 'boundary reached (fixed / pinned area)' };
  // The calls and results of an answer are passed as a whole: a block between them breaks the protocol.
  while (isTool(live[far]) && isTool(live[far + dir])) far += dir;
  const after = dir === 1 ? live[far]! : blocks[blocks.indexOf(live[far]!) - 1]!;
  return { event: { type: 'Move', id: block.id, after: after.id } };
}

// p cycles top → bottom → off.
export function pin(block: Block): Outcome {
  const blocked = guard(block);
  if (blocked) return blocked;
  if (block.pin === 'bottom') return { event: { type: 'Unpin', id: block.id } };
  return { event: { type: 'Pin', id: block.id, at: block.pin === 'top' ? 'bottom' : 'top' } };
}

export function remove(block: Block): Outcome {
  if (isFixed(block)) return { error: `${NAME[block.kind]} cannot be removed` };
  if (block.pending) return AWAITS;
  return { event: { type: 'Remove', id: block.id } };
}

// d with marks: every marked block in one event, undone together.
export function removeAll(blocks: Block[]): Outcome {
  for (const block of blocks) {
    const outcome = remove(block);
    if ('error' in outcome) return outcome;
  }
  const [first, ...others] = blocks.map(b => b.id);
  return first === undefined ? { error: 'nothing marked' } : { event: { type: 'Remove', id: first, others } };
}

// Editor port (adapters/editor): the user edits a text; resolves to the saved text.
export type Editor = (text: string) => Promise<string>;

// The content a block is added with.
const FIRST_REVISION = 1;

// Why the block cannot be edited, or null: all kinds but the Tools Block, executed Tool Calls and Questions (FR-8).
export function editable(block: Block): string | null {
  if (block.kind === 'Tools') return 'Tools Block is not editable';
  if (block.tool === 'question' && block.pending) return 'a Question is answered in the dock, not edited';
  return block.kind === 'Tool Call' && !block.pending ? 'executed Tool Calls are immutable' : null;
}

// Moving or pinning a Tool Pair turns it into Note `id` first (FR-9).
export function toNote(block: Block, id: number): Outcome {
  const blocked = guard(block);
  if (blocked) return blocked;
  if (!inPair(block)) return { error: 'not a Tool Pair' };
  return { event: { type: 'PairToNote', id, call: block.kind === 'Tool Call' ? block.id : block.call! } };
}

// e: the edited text becomes a new Revision, numbered after every Revision logged, undone ones too.
// Editors end a saved file with a newline; one the content did not have is dropped, from a command all.
export function edit(events: SessionEvent[], block: Block, edited: string): Outcome {
  const error = editable(block);
  if (error) return { error };
  const content = block.content.endsWith('\n') ? edited : edited.replace(block.kind === 'Tool Call' ? /\n+$/ : /\n$/, '');
  if (content === block.content) return { error: 'unchanged – no new Revision' };
  return { event: { type: 'Edit', id: block.id, revision: nextRevision(events, block.id), content } };
}

// /tools <name>: the Tools Block with the tool switched on or off, as a new Revision.
export function toggleTool(events: SessionEvent[], { blocks }: Context, name: string): Outcome {
  const tools = blocks.find(b => b.kind === 'Tools');
  if (!tools) return { error: 'no Tools Block' };
  const toggled = bash.toggleTool(tools.content, name);
  if ('error' in toggled) return toggled;
  return { event: { type: 'Edit', id: tools.id, revision: nextRevision(events, tools.id), content: toggled.content } };
}

export const nextRevision = (events: SessionEvent[], id: number) =>
  FIRST_REVISION + events.filter(e => e.type === 'Edit' && e.id === id).length + 1;

// Undo cancels the latest Context operation not yet undone, by a counter-event.
export function undo(events: SessionEvent[]): Outcome<Undo> {
  const skip = undone(events);
  const eventId = events.findLastIndex((e, i) => UNDOABLE.has(e.type) && !skip.has(i) && !('harness' in e));
  return eventId === -1 ? { error: 'nothing to undo' } : { event: { type: 'Undo', eventId } };
}

// The Tool Call to decide on next: calls are approved one by one in Context order (FR-24).
export const nextCall = (context: Context): Block | undefined => context.blocks.find(b => b.pending && !b.removed);

// Why the block cannot be run or rejected now, or null.
export function approvable(context: Context, block: Block): string | null {
  if (!block.pending) return 'not awaiting approval';
  return nextCall(context) === block ? null : 'approve the earlier Tool Call first';
}

export const toolResult = (call: Block, id: number, run: RunResult, timeout: number): BlockAdded => ({
  type: 'BlockAdded', id, kind: 'Tool Result', origin: 'tool', content: resultText(run, timeout), call: call.id,
  ...(run.stopped && { stopped: run.stopped }),
});

// A call not run: its result tells the model why.
const notRun = (content: string) => (context: Context, call: Block, id: number): Outcome => {
  const error = approvable(context, call);
  return error ? { error } : { event: { type: 'BlockAdded', id, kind: 'Tool Result', origin: 'tool', content, call: call.id } };
};
// n: the user rejects the call (FR-23).
export const reject = notRun('rejected by user');
// A deny rule matches the call (FR-23).
export const deny = notRun('denied by rule');
// Esc in the dock: the user declines to answer the Question (FR-21).
export const decline = notRun('declined');

// Context operations at the Review Gate: each yields the event to append, or why not.
import type { SessionEvent, Tool } from '../log/events';
import { undone, type Block, type Context } from '../log/fold';
import * as bash from '../toolcall/bash';
import { resultText, type RunResult } from '../toolcall/bash';

export type Outcome<E extends SessionEvent = SessionEvent> = { event: E } | { error: string };
type Undo = Extract<SessionEvent, { type: 'Undo' }>;

type BlockAdded = Extract<SessionEvent, { type: 'BlockAdded' }>;

// System and Tools Block stay first: never moved, removed or marked.
export const isFixed = (block: Block) => block.kind === 'System' || block.kind === 'Tools';
const NAME = { System: 'System prompt', Tools: 'Tools Block' } as Record<string, string>;
const fixed = (block: Block) => ({ error: `${NAME[block.kind]} is fixed` });
// A Tool Call awaiting approval keeps its place until it has a result.
const AWAITS = { error: 'Tool Call awaits approval – y run once · a allow for session · n reject · e edit' };
// Why an operation may not touch the block, if not.
export const untouchable = (block: Block) => (isFixed(block) ? fixed(block) : block.pending ? AWAITS : null);
const UNDOABLE = new Set<SessionEvent['type']>(['Move', 'Remove', 'Rename', 'Edit', 'PairToNote', 'Compact', 'NoteAdded']);

const isTool = (block: Block | undefined) => block?.kind === 'Tool Call' || block?.kind === 'Tool Result';
// Tool Call and Tool Result behave as a unit once the call has run.
export const inPair = (block: Block) => block.kind === 'Tool Result' || (block.kind === 'Tool Call' && !block.pending);

export function move({ blocks }: Context, block: Block, dir: -1 | 1): Outcome {
  const blocked = untouchable(block);
  if (blocked) return blocked;
  const live = blocks.filter(b => !b.removed);
  let far = live.indexOf(block) + dir;
  const neighbour = live[far];
  // System and Tools Block stay first.
  if (!neighbour || isFixed(neighbour)) return { error: 'boundary reached' };
  // The calls and results of an answer are passed as a whole: a block between them breaks the protocol.
  while (isTool(live[far]) && isTool(live[far + dir])) far += dir;
  const after = dir === 1 ? live[far]! : blocks[blocks.indexOf(live[far]!) - 1]!;
  return { event: { type: 'Move', id: block.id, after: after.id } };
}

// A Context Policy's move: the block right after `after`, a block sent next (ADR 0001). A Tool Pair is turned into a Note first.
export function moveAfter({ blocks }: Context, block: Block, after: number): Outcome {
  const blocked = untouchable(block) ?? (inPair(block) ? { error: 'a Tool Pair moves as a Note' } : null);
  if (blocked) return blocked;
  const live = blocks.filter(b => !b.removed);
  const error = misplaced(live.filter(b => b !== block), after);
  if (error) return { error };
  if (live[live.indexOf(block) - 1]!.id === after) return { error: 'unchanged – already there' };
  return { event: { type: 'Move', id: block.id, after } };
}
// Why a block may not go right after `after` among the other blocks sent, if not.
function misplaced(others: Block[], after: number): string | null {
  const at = others.findIndex(b => b.id === after);
  if (at < 0) return `no block ${after} in the Context`;
  if (others[at + 1]?.kind === 'Tools') return 'System and Tools Block stay first';
  return isTool(others[at]) && isTool(others[at + 1]) ? 'not between the Tool Calls and Tool Results of an answer' : null;
}

// A Context Policy's Note: `content` as Note `id` right after `after`, a block sent next.
export function addNote({ blocks }: Context, id: number, after: number, content: string): Outcome {
  if (!content.trim()) return { error: 'empty Note' };
  const error = misplaced(blocks.filter(b => !b.removed), after);
  return error ? { error } : { event: { type: 'NoteAdded', id, after, content } };
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

// Why the block cannot be edited, or null: all kinds but the Tools Block, executed Tool Calls and Questions.
export function editable(block: Block): string | null {
  if (block.kind === 'Tools') return 'Tools Block is not editable';
  if (block.tool === 'question' && block.pending) return 'a Question is answered in the dock, not edited';
  return block.kind === 'Tool Call' && !block.pending ? 'executed Tool Calls are immutable' : null;
}

// Moving a Tool Pair turns it into Note `id` first.
export function toNote(block: Block, id: number): Outcome {
  const blocked = untouchable(block);
  if (blocked) return blocked;
  if (!inPair(block)) return { error: 'not a Tool Pair' };
  return { event: { type: 'PairToNote', id, call: block.kind === 'Tool Call' ? block.id : block.call! } };
}

// e: the edited text becomes a new Revision, numbered after every Revision logged, undone ones too.
// Editors end a saved file with a newline; one the content did not have is dropped, from a command all.
export function edit(events: SessionEvent[], block: Block, edited: string): Outcome {
  const error = editable(block);
  if (error) return { error };
  return revise(events, block, block.content.endsWith('\n') ? edited : edited.replace(block.kind === 'Tool Call' ? /\n+$/ : /\n$/, ''));
}

// The content as the block's next Revision, unless unchanged.
export function revise(events: SessionEvent[], block: Block, content: string): Outcome {
  if (content === block.content) return { error: 'unchanged – no new Revision' };
  return { event: { type: 'Edit', id: block.id, revision: nextRevision(events, block.id), content } };
}

// The Context operations whose events name who made them (ADR 0001); a harness edit keeps its marker instead.
const ATTRIBUTED = new Set<SessionEvent['type']>(['Move', 'Remove', 'Edit', 'PairToNote', 'Compact', 'NoteAdded']);
export const attributed = (event: SessionEvent, by: string): SessionEvent =>
  ATTRIBUTED.has(event.type) && !('harness' in event) ? ({ ...event, by } as SessionEvent) : event;

// /tools <name>: the Tools Block with the tool switched on or off, as a new Revision; a tool denied by rule stays off.
export function toggleTool(events: SessionEvent[], { blocks }: Context, name: string, denied: Tool[]): Outcome {
  const tools = blocks.find(b => b.kind === 'Tools');
  if (!tools) return { error: 'no Tools Block' };
  if (denied.includes(name as Tool) && !bash.toolsIn(tools.content).includes(name)) return { error: `${name} is denied by rule` };
  const toggled = bash.toggleTool(tools.content, name);
  if ('error' in toggled) return toggled;
  return { event: { type: 'Edit', id: tools.id, revision: nextRevision(events, tools.id), content: toggled.content } };
}

// The harness takes the tools denied by rule out of the Tools Block, not undoable.
export function withoutDenied(events: SessionEvent[], { blocks }: Context, denied: Tool[]): Extract<SessionEvent, { type: 'Edit' }> | null {
  const tools = blocks.find(b => b.kind === 'Tools');
  if (!tools) return null;
  const on = bash.toolsIn(tools.content);
  if (!denied.some(name => on.includes(name))) return null;
  const content = bash.toolsWith(on.filter(name => !denied.includes(name as Tool)));
  return { type: 'Edit', id: tools.id, revision: nextRevision(events, tools.id), content, harness: true };
}

export const nextRevision = (events: SessionEvent[], id: number) =>
  FIRST_REVISION + events.filter(e => e.type === 'Edit' && e.id === id).length + 1;

// Undo cancels the latest Context operation not yet undone, by a counter-event.
export function undo(events: SessionEvent[]): Outcome<Undo> {
  const skip = undone(events);
  const eventId = events.findLastIndex((e, i) => UNDOABLE.has(e.type) && !skip.has(i) && !('harness' in e));
  return eventId === -1 ? { error: 'nothing to undo' } : { event: { type: 'Undo', eventId } };
}

// The Tool Call to decide on next: calls are approved one by one in Context order.
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
// n: the user rejects the call.
export const reject = notRun('rejected by user');
// A deny rule matches the call.
export const deny = notRun('denied by rule');
// Esc in the dock: the user declines to answer the Question.
export const decline = notRun('declined');

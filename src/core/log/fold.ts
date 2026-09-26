import type { Kind, Origin, Pin, SessionEvent, Stopped, ToolProtocol } from './events';

export type Block = {
  id: number;
  kind: Kind;
  origin: Origin;
  content: string;
  cutOff: boolean;
  // Tool Result only: its Tool Call, and how the run stopped early.
  call?: number;
  stopped?: Stopped;
  // Note from a Tool Pair only: the pair's command, for its title.
  source?: string;
  // Note from a Compaction only: the blocks it replaced and the instruction (FR-16).
  compacted?: { sources: number[]; instruction: string };
  // Note from a file only: the file (FR-27, FR-29); unread: an @file reference not read yet.
  file?: string;
  unread?: true;
  // An unread reference whose file cannot be read now (set at the Gate, never logged).
  missing?: string;
  // Tool Call only: no Tool Result yet, so it awaits approval (FR-23).
  pending?: boolean;
  title: string | null;
  pin: Pin | null;
  // Struck through until the next request, then hidden.
  removed: boolean;
  // Flags since the last request (FR-5).
  moved: boolean;
  pinChanged: boolean;
  // Current Revision (FR-8); revised: another one than at the last request (`✎n`, FR-5).
  revision: number;
  revised: boolean;
};
export type Context = { profile: string; protocol: ToolProtocol; blocks: Block[]; nextId: number };

type Entry = Omit<Block, 'revised'> & { hidden: boolean; sentPin: Pin | null; sentRevision: number };
// unsent: indices of events logged since the last request.
type State = { profile: string; entries: Map<number, Entry>; order: number[]; events: SessionEvent[]; unsent: Set<number> };
type Apply<T extends SessionEvent['type']> = (state: State, event: Extract<SessionEvent, { type: T }>) => void;

const entry = (state: State, id: number) => state.entries.get(id)!;
const take = (state: State, id: number) => state.order.splice(state.order.indexOf(id), 1);
const insert = (state: State, at: number, id: number) => state.order.splice(at, 0, id);
// New and unpinned blocks go before the bottom pins.
const firstBottom = (state: State) => {
  const i = state.order.findIndex(id => entry(state, id).pin === 'bottom');
  return i === -1 ? state.order.length : i;
};
const afterTop = (state: State) =>
  state.order.findLastIndex(id => ['System', 'Tools'].includes(entry(state, id).kind) || entry(state, id).pin === 'top') + 1;
// Where a Tool Result goes: after its Tool Call and the calls and results following it (FR-24), so
// all calls of one answer precede their results, as the request sends them.
export function afterCalls(blocks: Pick<Block, 'id' | 'kind'>[], call: number): number {
  let at = blocks.findIndex(b => b.id === call) + 1;
  while (blocks[at]?.kind === 'Tool Call' || blocks[at]?.kind === 'Tool Result') at++;
  return at;
}

// The Tool Pair of a Tool Call or Tool Result: both block ids, the call first; any other block alone.
export function pairOf(blocks: Pick<Block, 'id' | 'kind' | 'call'>[], id: number): number[] {
  const block = blocks.find(b => b.id === id)!;
  if (block.kind === 'Tool Result') return [block.call!, id];
  const result = blocks.find(b => b.call === id);
  return result ? [id, result.id] : [id];
}

const NEW_ENTRY = { title: null, removed: false, moved: false, pinChanged: false, revision: 1, hidden: false, sentPin: null, sentRevision: 1 };

function setPin(state: State, id: number, pin: Pin | null) {
  const e = entry(state, id);
  take(state, id);
  e.pin = pin;
  e.pinChanged = pin !== e.sentPin;
  insert(state, pin === 'top' ? afterTop(state) : pin === 'bottom' ? state.order.length : firstBottom(state), id);
}

const pairIn = (state: State, id: number) => pairOf([...state.entries.values()], id);

const APPLY: { [T in SessionEvent['type']]?: Apply<T> } = {
  BlockAdded: (state, e) => {
    const block = { id: e.id, kind: e.kind, origin: e.origin, content: e.content, cutOff: e.cutOff === true,
      ...(e.call !== undefined && { call: e.call }), ...(e.stopped && { stopped: e.stopped }), ...(e.file && { file: e.file }) };
    const pin = e.pin ?? null;
    state.entries.set(e.id, { ...block, ...NEW_ENTRY, pin, sentPin: pin });
    const at = e.call === undefined ? (pin === 'top' ? afterTop(state) : firstBottom(state)) : afterCalls(state.order.map(id => entry(state, id)), e.call);
    insert(state, at, e.id);
  },
  FileReferenced: (state, e) => {
    state.entries.set(e.id, { id: e.id, kind: 'Note', origin: 'file', file: e.file, unread: true, content: '', cutOff: false, ...NEW_ENTRY, pin: null });
    insert(state, firstBottom(state), e.id);
  },
  FileRead: (state, e) => {
    const { unread: _, ...read } = entry(state, e.id);
    state.entries.set(e.id, { ...read, content: e.content });
  },
  Move: (state, e) => {
    take(state, e.id);
    insert(state, state.order.indexOf(e.after) + 1, e.id);
    entry(state, e.id).moved = true;
  },
  Edit: (state, e) => void Object.assign(entry(state, e.id), { content: e.content, revision: e.revision }),
  Pin: (state, e) => setPin(state, e.id, e.at),
  Unpin: (state, e) => setPin(state, e.id, null),
  ProfileFallback: (state, e) => void (state.profile = e.profile),
  Remove: (state, e) => pairIn(state, e.id).forEach(id => (entry(state, id).removed = true)),
  // The pair is gone at once, not struck through: its Note follows the calls and results of its answer,
  // so the other calls of the answer keep their results right after them.
  PairToNote: (state, e) => {
    const [call, result] = pairIn(state, e.call).map(id => entry(state, id));
    const content = `[Tool bash: ${call!.content}]\n${result!.content}`;
    state.entries.set(e.id, { id: e.id, kind: 'Note', origin: 'tool', content, source: call!.content, cutOff: false, ...NEW_ENTRY, pin: call!.pin });
    insert(state, afterCalls(state.order.map(id => entry(state, id)), e.call), e.id);
    for (const b of [call!, result!]) Object.assign(b, { removed: true, hidden: true });
  },
  // The sources are gone at once; the Note takes the first one's place and pin.
  Compact: (state, e) => {
    const [first, ...rest] = e.sources.map(id => entry(state, id));
    const compacted = { sources: e.sources, instruction: e.instruction };
    state.entries.set(e.noteId, { id: e.noteId, kind: 'Note', origin: 'compaction', content: e.content, compacted, cutOff: false, ...NEW_ENTRY, pin: first!.pin });
    insert(state, state.order.indexOf(first!.id), e.noteId);
    for (const b of [first!, ...rest]) Object.assign(b, { removed: true, hidden: true });
  },
  Rename: (state, e) => void (entry(state, e.id).title = e.title || null),
  RequestSent: state => {
    for (const e of state.entries.values()) Object.assign(e, { hidden: e.removed, moved: false, pinChanged: false, sentPin: e.pin, sentRevision: e.revision });
    state.unsent.clear();
  },
  // Undoing an operation that was already sent changes the Context since the last request (FR-5).
  Undo: (state, e) => {
    const target = state.events[e.eventId]!;
    if (state.unsent.has(e.eventId)) return;
    if (target.type === 'Move') entry(state, target.id).moved = true;
    if (target.type === 'Pin' || target.type === 'Unpin') entry(state, target.id).pinChanged = true;
    // The replay skipped the sent Revision; the one restored differs from it.
    if (target.type === 'Edit') entry(state, target.id).sentRevision = target.revision;
  },
};

// Indices of Session Log events cancelled by an Undo counter-event.
export const undone = (events: SessionEvent[]): Set<number> =>
  new Set(events.flatMap(e => (e.type === 'Undo' ? [e.eventId] : [])));

// Context = fold(events): replaying the Session Log, minus undone events, yields the Context.
export function fold(events: SessionEvent[]): Context {
  const [first] = events;
  if (first?.type !== 'SessionCreated') throw new Error('Session Log must start with SessionCreated');
  const skip = undone(events);
  const state: State = { profile: first.profile, entries: new Map(), order: [], events, unsent: new Set() };
  events.forEach((e, i) => {
    state.unsent.add(i);
    if (skip.has(i)) return;
    (APPLY[e.type] as Apply<typeof e.type> | undefined)?.(state, e as never);
  });
  const answered = new Set([...state.entries.values()].map(e => e.call));
  const blocks = state.order
    .map(id => entry(state, id))
    .filter(e => !e.hidden)
    .map(({ hidden, sentPin, sentRevision, ...block }) => ({ ...block, revised: block.revision !== sentRevision }))
    .map(block => (block.kind === 'Tool Call' ? { ...block, pending: !answered.has(block.id) } : block));
  return { profile: state.profile, protocol: first.protocol, blocks, nextId: Math.max(0, ...state.entries.keys()) + 1 };
}

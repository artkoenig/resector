import type { Kind, Origin, Pin, SessionEvent, ToolProtocol } from './events';

export type Block = {
  id: number;
  kind: Kind;
  origin: Origin;
  content: string;
  cutOff: boolean;
  title: string | null;
  pin: Pin | null;
  // Struck through until the next request, then hidden.
  removed: boolean;
  // Flags since the last request (FR-5).
  moved: boolean;
  pinChanged: boolean;
};
export type Context = { profile: string; protocol: ToolProtocol; blocks: Block[]; nextId: number };

type Entry = Block & { hidden: boolean; sentPin: Pin | null };
// unsent: indices of events logged since the last request.
type State = { entries: Map<number, Entry>; order: number[]; events: SessionEvent[]; unsent: Set<number> };
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
  state.order.findLastIndex(id => entry(state, id).kind === 'System' || entry(state, id).pin === 'top') + 1;

function setPin(state: State, id: number, pin: Pin | null) {
  const e = entry(state, id);
  take(state, id);
  e.pin = pin;
  e.pinChanged = pin !== e.sentPin;
  insert(state, pin === 'top' ? afterTop(state) : pin === 'bottom' ? state.order.length : firstBottom(state), id);
}

const APPLY: { [T in SessionEvent['type']]?: Apply<T> } = {
  BlockAdded: (state, e) => {
    const block = { id: e.id, kind: e.kind, origin: e.origin, content: e.content, cutOff: e.cutOff === true };
    state.entries.set(e.id, { ...block, title: null, pin: null, removed: false, moved: false, pinChanged: false, hidden: false, sentPin: null });
    insert(state, firstBottom(state), e.id);
  },
  Move: (state, e) => {
    take(state, e.id);
    insert(state, state.order.indexOf(e.after) + 1, e.id);
    entry(state, e.id).moved = true;
  },
  Pin: (state, e) => setPin(state, e.id, e.at),
  Unpin: (state, e) => setPin(state, e.id, null),
  Remove: (state, e) => void (entry(state, e.id).removed = true),
  Rename: (state, e) => void (entry(state, e.id).title = e.title || null),
  RequestSent: state => {
    for (const e of state.entries.values()) Object.assign(e, { hidden: e.removed, moved: false, pinChanged: false, sentPin: e.pin });
    state.unsent.clear();
  },
  // Undoing an operation that was already sent changes the Context since the last request (FR-5).
  Undo: (state, e) => {
    const target = state.events[e.eventId]!;
    if (state.unsent.has(e.eventId)) return;
    if (target.type === 'Move') entry(state, target.id).moved = true;
    if (target.type === 'Pin' || target.type === 'Unpin') entry(state, target.id).pinChanged = true;
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
  const state: State = { entries: new Map(), order: [], events, unsent: new Set() };
  events.forEach((e, i) => {
    state.unsent.add(i);
    if (skip.has(i)) return;
    (APPLY[e.type] as Apply<typeof e.type> | undefined)?.(state, e as never);
  });
  const blocks = state.order.map(id => entry(state, id)).filter(e => !e.hidden).map(({ hidden, sentPin, ...block }) => block);
  return { profile: first.profile, protocol: first.protocol, blocks, nextId: Math.max(0, ...state.entries.keys()) + 1 };
}

import { isImage } from '../notes/images';
import type { BackgroundEnd, Kind, Origin, SessionEvent, Stopped, Thinking, Tool, ToolProtocol } from './events';

export type Block = {
  id: number;
  kind: Kind;
  origin: Origin;
  content: string;
  cutOff: boolean;
  // Tool Call only: its tool, absent for bash; background: run as a Background Process; worktree: a Subagent's own.
  tool?: Tool;
  background?: true;
  worktree?: true;
  // Tool Call only, once started: its Background Process (process group, log), whether it still runs, how it ended.
  process?: { pid: number; log: string; running: boolean; end?: BackgroundEnd };
  // Both blocks of a Tool Pair whose Background Process runs: no Context operation touches them.
  running?: true;
  // Tool Result only: its Tool Call, and how the run stopped early.
  call?: number;
  stopped?: Stopped;
  // Note from a Tool Pair only: the pair's call (callText), for its title.
  source?: string;
  // Note from a Compaction only: the blocks it replaced and the instruction.
  compacted?: { sources: number[]; instruction: string };
  // Note or Image from a file only: the file; unread: an @path reference not read yet.
  file?: string;
  // Image only, once read: its copy in the Project Home.
  image?: string;
  unread?: true;
  // Note from a loaded Skill only: its name.
  skill?: string;
  // Context of the session rather than its work: a policy clearing the work leaves it. A hint for policies, no lock.
  keep?: true;
  // Tool Call only: no Tool Result yet, so it awaits approval.
  pending?: boolean;
  // Current Revision.
  revision: number;
};
// The blocks sent in the next request, in order; removed ones are gone. thinking: set at the Gate; null = the
// Model Profile's.
export type Context = { profile: string; protocol: ToolProtocol; thinking: Thinking | null; blocks: Block[]; nextId: number };

type Entry = Block & { removed: boolean };
type State = { profile: string; thinking: Thinking | null; entries: Map<number, Entry>; order: number[] };
type Apply<T extends SessionEvent['type']> = (state: State, event: Extract<SessionEvent, { type: T }>) => void;

const entry = (state: State, id: number) => state.entries.get(id)!;
const take = (state: State, id: number) => state.order.splice(state.order.indexOf(id), 1);
const insert = (state: State, at: number, id: number) => state.order.splice(at, 0, id);
// Where a Tool Result goes: after its Tool Call and the calls and results following it, so
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

// A Tool Call as the user reads it: the bash command, or the tool name and its query.
export const callText = ({ tool, content, worktree }: Pick<Block, 'tool' | 'content' | 'worktree'>): string =>
  tool && tool !== 'bash' ? `${tool} ${worktree ? '[worktree] ' : ''}${content}` : content;

const NEW_ENTRY = { revision: 1, removed: false };

const pairIn = (state: State, id: number) => pairOf([...state.entries.values()], id);
// Where a block a call adds goes (a skill's Notes, an attached image): after the answer's calls and results and
// the blocks its calls added before, so they keep their order and none splits the calls and results.
function afterAnswer(state: State, call: number): number {
  let at = afterCalls(state.order.map(id => entry(state, id)), call);
  const added = (b: Entry) => b.skill !== undefined || (b.kind === 'Image' && b.origin === 'tool');
  while (at < state.order.length && added(entry(state, state.order[at]!))) at++;
  return at;
}

// Notes added with these origins: the Environment Note, the Project Instructions, the Skills note. A File Reference has
// its own event.
const SESSION_NOTES = new Set<Origin>(['environment', 'file', 'skill']);
const kept = ({ origin }: Pick<Block, 'origin'>) => (SESSION_NOTES.has(origin) ? { keep: true as const } : {});

const APPLY: { [T in SessionEvent['type']]?: Apply<T> } = {
  BlockAdded: (state, e) => {
    const block = { id: e.id, kind: e.kind, origin: e.origin, content: e.content, cutOff: e.cutOff === true, ...(e.tool && { tool: e.tool }),
      ...(e.call !== undefined && { call: e.call }), ...(e.stopped && { stopped: e.stopped }), ...(e.file && { file: e.file }),
      ...(e.background && { background: e.background }), ...(e.worktree && { worktree: e.worktree }), ...kept(e) };
    state.entries.set(e.id, { ...block, ...NEW_ENTRY });
    insert(state, e.call === undefined ? state.order.length : afterCalls(state.order.map(id => entry(state, id)), e.call), e.id);
  },
  // An image's content is its reference: the model knows where the image comes from. One an `image` call attached
  // (origin tool) follows the calls and results of its answer, as a skill's Notes do.
  FileReferenced: (state, e) => {
    const image = isImage(e.file);
    const origin = e.call === undefined ? 'file' as const : 'tool' as const;
    const block = { id: e.id, kind: image ? 'Image' as const : 'Note' as const, origin, file: e.file, unread: true as const };
    state.entries.set(e.id, { ...block, content: image ? `[${e.file}]` : '', cutOff: false, ...NEW_ENTRY });
    if (e.call === undefined) return void state.order.push(e.id);
    insert(state, afterAnswer(state, e.call), e.id);
  },
  BackgroundStarted: (state, e) => void (entry(state, e.call).process = { pid: e.pid, log: e.log, running: true }),
  // Logged only for a started process.
  BackgroundExited: (state, { type: _, call, report: __, worktree: ___, ...end }) => {
    const started = entry(state, call).process!;
    started.running = false;
    started.end = end as BackgroundEnd;
  },
  ImageRead: (state, e) => {
    const { unread: _, ...read } = entry(state, e.id);
    state.entries.set(e.id, { ...read, image: e.image });
  },
  FileRead: (state, e) => {
    const { unread: _, ...read } = entry(state, e.id);
    state.entries.set(e.id, { ...read, content: e.content });
  },
  Move: (state, e) => {
    take(state, e.id);
    insert(state, state.order.indexOf(e.after) + 1, e.id);
  },
  Edit: (state, e) => void Object.assign(entry(state, e.id), { content: e.content, revision: e.revision }),
  ProfileFallback: (state, e) => void (state.profile = e.profile),
  ThinkingSet: (state, e) => void (state.thinking = e.thinking),
  Remove: (state, e) => [e.id, ...(e.others ?? [])].flatMap(id => pairIn(state, id)).forEach(id => (entry(state, id).removed = true)),
  // Its Note follows the calls and results of its answer, so the other calls of the answer keep their results
  // right after them.
  PairToNote: (state, e) => {
    const [call, result] = pairIn(state, e.call).map(id => entry(state, id));
    const content = `[Tool ${call!.tool ?? 'bash'}: ${call!.content}]\n${result!.content}`;
    state.entries.set(e.id, { id: e.id, kind: 'Note', origin: 'tool', content, source: callText(call!), cutOff: false, ...NEW_ENTRY });
    insert(state, afterCalls(state.order.map(id => entry(state, id)), e.call), e.id);
    for (const b of [call!, result!]) b.removed = true;
  },
  // The Note takes the first source's place; one of a Tool Pair follows the calls and results of its answer, so the
  // answer's other calls keep their results right after them.
  Compact: (state, e) => {
    const [first, ...rest] = e.sources.map(id => entry(state, id));
    const compacted = { sources: e.sources, instruction: e.instruction };
    const blocks = state.order.map(id => entry(state, id));
    // Sources come in Context order, a Tool Pair whole: its call first.
    const at = first!.kind === 'Tool Call' ? afterCalls(blocks, first!.id) : state.order.indexOf(first!.id);
    state.entries.set(e.noteId, { id: e.noteId, kind: 'Note', origin: 'compaction', content: e.content, compacted, cutOff: false, ...NEW_ENTRY });
    insert(state, at, e.noteId);
    for (const b of [first!, ...rest]) b.removed = true;
  },
  NoteAdded: (state, e) => {
    state.entries.set(e.id, { id: e.id, kind: 'Note', origin: 'policy', content: e.content, cutOff: false, ...NEW_ENTRY });
    insert(state, state.order.indexOf(e.after) + 1, e.id);
  },
  SkillLoaded: (state, e) => {
    state.entries.set(e.id, { id: e.id, kind: 'Note', origin: 'skill', skill: e.name, file: e.file, content: e.content, cutOff: false, keep: true, ...NEW_ENTRY });
    if (e.call === undefined) return void state.order.push(e.id);
    insert(state, afterAnswer(state, e.call), e.id);
  },
};

// Indices of Session Log events cancelled by an Undo counter-event.
export const undone = (events: SessionEvent[]): Set<number> =>
  new Set(events.flatMap(e => (e.type === 'Undo' ? [e.eventId] : [])));

// Context = fold(events): replaying the Session Log, minus undone events, yields the Context. skip: the events
// not replayed.
export function fold(events: SessionEvent[], skip = undone(events)): Context {
  const [first] = events;
  if (first?.type !== 'SessionCreated') throw new Error('Session Log must start with SessionCreated');
  const state: State = { profile: first.profile, thinking: null, entries: new Map(), order: [] };
  events.forEach((e, i) => {
    if (skip.has(i)) return;
    (APPLY[e.type] as Apply<typeof e.type> | undefined)?.(state, e as never);
  });
  const answered = new Set([...state.entries.values()].map(e => e.call));
  const blocks = state.order
    .map(id => entry(state, id))
    .filter(e => !e.removed)
    .map(({ removed, ...block }): Block => block)
    .map(block => (block.kind === 'Tool Call' ? { ...block, pending: !answered.has(block.id) } : block));
  const runs = new Set(blocks.filter(b => b.process?.running).map(b => b.id));
  const marked = blocks.map(b => (runs.has(b.id) || runs.has(b.call!) ? { ...b, running: true as const } : b));
  return { profile: state.profile, protocol: first.protocol, thinking: state.thinking, blocks: marked, nextId: Math.max(0, ...state.entries.keys()) + 1 };
}

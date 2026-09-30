// Sessions: a new Session Log, how a session is referred to, and its summary in /sessions.
import type { SessionEvent } from '../log/events';
import { fold } from '../log/fold';
import { fileNote } from '../notes/files';
import { TOOLS } from '../tools/catalog';

export type SessionSummary = { title: string; renamed: boolean; profile: string; blocks: number; tokens: number | null };

// A session to resume or export: its id, or true = the newest one of the project.
export type SessionRef = true | string;

const TITLE_LENGTH = 60;
type BlockAdded = Extract<SessionEvent, { type: 'BlockAdded' }>;
type RequestSent = Extract<SessionEvent, { type: 'RequestSent' }>;

// What a new session starts with besides System prompt and Tools Block: the environment Note and the
// project instructions (`AGENTS.md` and `CLAUDE.md` of the project, then the user's own for it), read once now.
// All are ordinary Notes right after the Tools Block, one per file.
export type Instructions = { file: string; content: string };
export type SessionNotes = { environment?: string; instructions?: Instructions[] };

export function newSession(profile: string, systemPrompt: string, { environment, instructions }: SessionNotes = {}): SessionEvent[] {
  const events: SessionEvent[] = [
    { type: 'SessionCreated', profile, protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: systemPrompt },
    // Always sent, never edited.
    { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: TOOLS },
  ];
  if (environment !== undefined) events.push({ type: 'BlockAdded', id: events.length, kind: 'Note', origin: 'environment', content: environment });
  for (const { file, content } of instructions ?? []) {
    events.push({ type: 'BlockAdded', id: events.length, kind: 'Note', origin: 'file', file, content: fileNote(file, content) });
  }
  return events;
}

// The blocks a session starts with (System prompt, Tools Block, environment Note, project instructions): those
// added right after SessionCreated, before the first message.
export function openingBlocks(events: SessionEvent[]): Set<number> {
  const ids = new Set<number>();
  for (const e of events.slice(1) as Partial<BlockAdded>[]) {
    if (!['System', 'Tools', 'Note'].includes(e.kind!)) break;
    ids.add(e.id!);
  }
  return ids;
}

// Whether the session runs in its own git worktree: the last switch wins, a new session runs in the project.
export const inWorktree = (events: SessionEvent[]): boolean => events.findLast(e => e.type === 'WorktreeSet')?.on === true;

// Title = the last session rename, else the first line of the first User message.
function sessionTitle(events: SessionEvent[]): Pick<SessionSummary, 'title' | 'renamed'> {
  const renamed = events.findLast(e => e.type === 'SessionRenamed')?.title;
  if (renamed) return { title: renamed, renamed: true };
  const first = events.find((e): e is BlockAdded => (e as Partial<BlockAdded>).kind === 'User');
  const line = first?.content.split('\n').find(l => l.trim())?.trim();
  if (!line) return { title: '(new session)', renamed: false };
  return { title: line.length > TITLE_LENGTH ? line.slice(0, TITLE_LENGTH - 1) + '…' : line, renamed: false };
}

// Context tokens are those of the last request: counting every session against its backend is too slow for a list.
export function summarize(events: SessionEvent[]): SessionSummary {
  const context = fold(events);
  const request = events.findLast((e): e is RequestSent => e.type === 'RequestSent');
  return {
    ...sessionTitle(events),
    profile: context.profile,
    blocks: context.blocks.length,
    tokens: request?.tokens ?? null,
  };
}

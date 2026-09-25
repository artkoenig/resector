// Sessions (FR-32–FR-35): a new Session Log, and the summary shown per session in /sessions.
import type { SessionEvent } from '../log/events';
import { fold } from '../log/fold';

export type SessionSummary = { title: string; renamed: boolean; profile: string; blocks: number; tokens: number | null };

const TITLE_LENGTH = 60;
type BlockAdded = Extract<SessionEvent, { type: 'BlockAdded' }>;

export const newSession = (profile: string, systemPrompt: string): SessionEvent[] => [
  { type: 'SessionCreated', profile, protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: systemPrompt },
];

// Title = the last session rename, else the first line of the first User message (FR-34).
function titleOf(events: SessionEvent[]): Pick<SessionSummary, 'title' | 'renamed'> {
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
  const request = events.findLast(e => e.type === 'RequestSent');
  return {
    ...titleOf(events),
    profile: context.profile,
    blocks: context.blocks.filter(b => !b.removed).length,
    tokens: request?.type === 'RequestSent' ? request.tokens : null,
  };
}

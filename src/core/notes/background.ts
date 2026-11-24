// Exit Notes of Background Processes: which Tool Call an exit belongs to, and the Notes owed for logged exits. Read from
// the Session Log alone, so an exit logged before a switch, quit or crash still gets its Note after resume.
import type { BackgroundEnd, SessionEvent } from '../log/events';
import { subagentNoteText } from './subagent';

type Started = Extract<SessionEvent, { type: 'BackgroundStarted' }>;
type Exited = Extract<SessionEvent, { type: 'BackgroundExited' }>;

// The Background Processes by their Tool Call.
const startsOf = (events: SessionEvent[]) =>
  new Map(events.flatMap(e => (e.type === 'BackgroundStarted' ? [[e.call, e] as const] : [])));
const hasExited = (events: SessionEvent[], call: number) => events.some(e => e.type === 'BackgroundExited' && e.call === call);

// The event for an exit of process group `pid`: of the Background Process running with it (the latest, a pid may be
// reused); null when none runs (a call that ended within its wait never started one).
export function exitOf(events: SessionEvent[], pid: number, end: BackgroundEnd): Exited | null {
  const start = [...startsOf(events).values()].findLast(s => s.pid === pid && !hasExited(events, s.call));
  return start ? { type: 'BackgroundExited', call: start.call, ...end } : null;
}

const REASON: Record<string, string> = {
  'session ended': 'stopped when the session ended',
  user: 'stopped by the user',
  orphaned: 'killed after resector stopped unexpectedly',
};
// Whether resector ended it, and why.
export const endedBy = (end: BackgroundEnd, signal: 'user' | 'session ended') => 'signal' in end && end.signal === signal;
const reason = (end: BackgroundEnd) => ('exit' in end ? `exited with ${end.exit}` : (REASON[end.signal] ?? `killed by ${end.signal}`));

// Self-contained: the start call may be gone from the Context.
export const exitNoteText = ({ pid, log, command }: { pid: number; log: string; command: string }, end: BackgroundEnd) =>
  `Background Process pid ${pid} ended: ${reason(end)}\ncommand: ${command}\nlog: ${log}`;

// The command (or a Subagent's prompt) as it ran: the Tool Call's content at its start.
function commandOf(events: SessionEvent[], start: Started): string {
  const before = events.slice(0, events.indexOf(start));
  const written = before.findLast(e => (e.type === 'BlockAdded' || e.type === 'Edit') && e.id === start.call) as { content: string } | undefined;
  return written?.content ?? '';
}

// Only a Tool Call carries `tool`.
const startsSubagent = (events: SessionEvent[], call: number) =>
  (events as { id?: number; tool?: string }[]).some(e => e.id === call && e.tool === 'subagent');

function noteOf(events: SessionEvent[], start: Started, end: BackgroundEnd): string {
  const { pid, log, call } = start;
  const command = commandOf(events, start);
  if (!startsSubagent(events, call)) return exitNoteText({ pid, log, command }, end);
  return subagentNoteText({ pid, log, prompt: command }, reason(end), 'signal' in end, end.report);
}

// The Notes still owed, in the order the exits were logged: every exit no Note was added for yet, whatever ended it.
export function owedExitNotes(events: SessionEvent[]): { exited: number; content: string }[] {
  // Only an exit Note carries `exited`.
  const noted = new Set(events.map(e => (e as { exited?: number }).exited));
  const starts = startsOf(events);
  return events.flatMap(e => {
    if (e.type !== 'BackgroundExited' || noted.has(e.call)) return [];
    const start = starts.get(e.call);
    if (!start) return [];
    const { type: _, call, ...end } = e;
    return [{ exited: call, content: noteOf(events, start, end as BackgroundEnd) }];
  });
}

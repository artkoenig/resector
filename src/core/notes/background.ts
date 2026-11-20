// Exit Notes of Background Processes: which Tool Call an exit belongs to, and the Notes owed for logged exits. Read from
// the Session Log alone, so an exit logged before a switch, quit or crash still gets its Note after resume.
import type { BackgroundEnd, SessionEvent } from '../log/events';

type Started = Extract<SessionEvent, { type: 'BackgroundStarted' }>;
type Exited = Extract<SessionEvent, { type: 'BackgroundExited' }>;

const exitedCalls = (events: SessionEvent[]) => new Set(events.flatMap(e => (e.type === 'BackgroundExited' ? [e.call] : [])));

// The event for an exit of process group `pid`: of the Background Process running with it (the latest, a pid may be
// reused); null when none runs (a call that ended within its wait never started one).
export function exitOf(events: SessionEvent[], pid: number, end: BackgroundEnd): Exited | null {
  const ended = exitedCalls(events);
  const start = events.findLast((e): e is Started => e.type === 'BackgroundStarted' && e.pid === pid && !ended.has(e.call));
  return start ? { type: 'BackgroundExited', call: start.call, ...end } : null;
}

const REASON: Record<string, string> = {
  'session ended': 'stopped when the session ended',
  user: 'stopped by the user',
  orphaned: 'killed after resector stopped unexpectedly',
};
const reason = (end: BackgroundEnd) => ('exit' in end ? `exited with ${end.exit}` : (REASON[end.signal] ?? `killed by ${end.signal}`));

// Self-contained: the start call may be gone from the Context.
export const exitNoteText = ({ pid, log, command }: { pid: number; log: string; command: string }, end: BackgroundEnd) =>
  `Background Process pid ${pid} ended: ${reason(end)}\ncommand: ${command}\nlog: ${log}`;

// The command as it ran: the Tool Call's content at its start.
function commandOf(events: SessionEvent[], start: Started): string {
  const before = events.slice(0, events.indexOf(start));
  const written = before.findLast(e => (e.type === 'BlockAdded' || e.type === 'Edit') && e.id === start.call) as { content: string } | undefined;
  return written?.content ?? '';
}

// The Notes still owed, in the order the exits were logged: every exit no Note was added for yet, whatever ended it.
export function owedExitNotes(events: SessionEvent[]): { exited: number; content: string }[] {
  const noted = new Set(events.flatMap(e => (e.type === 'BlockAdded' && e.exited !== undefined ? [e.exited] : [])));
  return events.flatMap(e => {
    if (e.type !== 'BackgroundExited' || noted.has(e.call)) return [];
    const start = events.find((s): s is Started => s.type === 'BackgroundStarted' && s.call === e.call);
    if (!start) return [];
    const { type: _, call, ...end } = e;
    return [{ exited: call, content: exitNoteText({ pid: start.pid, log: start.log, command: commandOf(events, start) }, end as BackgroundEnd) }];
  });
}

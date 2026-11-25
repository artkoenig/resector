// What a Subagent hands to its parent Session, and the exit Note made of it.
import type { BackgroundEnd, SubagentReport, SubagentWorktree } from '../log/events';
import { formatTokens } from '../tokens/format';

// What a Subagent is asked once its run has ended.
export const DEFAULT_SUMMARY_PROMPT =
  'Your run has ended. Write a summary of it for the one who gave you the task; it is all they get to see. Say what was done, ' +
  'what was found, what is open, the files touched and the commits made. Answer with text only: tool calls are no longer run.';

// Characters of the prompt's first line the Note shows.
const PROMPT_WIDTH = 70;
function firstLine(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!;
  return line.length > PROMPT_WIDTH ? `${line.slice(0, PROMPT_WIDTH - 1)}…` : line;
}

// The run's Outcome; how the process ended when there is none, or when that is why it was aborted.
const endOf = (outcome: SubagentReport['outcome'], reason: string, signalled: boolean) =>
  !outcome || (outcome === 'aborted' && signalled) ? reason : outcome;
const numbers = ({ turns, tokens }: SubagentReport) => ` · ${turns} turn${turns === 1 ? '' : 's'} · ${formatTokens(tokens)} tokens`;

// reason: how its process ended, signalled: ended from outside; without a report (it ended before its Session was
// opened) there is only that. left: its worktree is still there. Self-contained: the start call may be gone from the Context.
export function subagentNoteText(
  start: { pid: number; log: string; prompt: string; worktree?: SubagentWorktree }, reason: string, signalled: boolean, report?: SubagentReport, left?: BackgroundEnd['worktree'],
): string {
  const ended = `Subagent pid ${start.pid} ended: ${endOf(report?.outcome, reason, signalled)}${report ? numbers(report) : ''}`;
  const session = report?.session ? `session: ${report.session} · ` : '';
  const worktree = start.worktree && left ? `\nworktree: ${start.worktree.path} · branch: ${start.worktree.branch}${left.dirty ? ' · uncommitted changes' : ''}` : '';
  const head = `${ended}\nprompt: ${firstLine(start.prompt)}\n${session}log: ${start.log}${worktree}`;
  return report?.text ? `${head}\n\n${report.text}` : head;
}

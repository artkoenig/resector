// The environment Note (FR-28): where the model runs, pinned top, refreshed by the harness before each request.
import { nextRevision } from '../context/operations';
import type { SessionEvent } from '../log/events';
import type { Context } from '../log/fold';

// branch: null outside a git repository or on a detached HEAD.
export type Environment = { cwd: string; os: string; shell: string; date: string; branch: string | null };

export const environmentText = ({ cwd, os, shell, date, branch }: Environment) =>
  `cwd: ${cwd}\nos: ${os} · shell: ${shell}\ndate: ${date}\ngit branch: ${branch ?? '(none)'}`;

type Edit = Extract<SessionEvent, { type: 'Edit' }>;

// A new Revision when the environment changed since the harness last wrote it; a user's edit stays until then.
export function refreshEnvironment(events: SessionEvent[], context: Context, text: string): Edit | null {
  const note = context.blocks.find(b => b.origin === 'environment' && !b.removed);
  if (!note) return null;
  const written = events.findLast(e => (e.type === 'BlockAdded' || 'harness' in e) && e.id === note.id);
  return (written as { content: string }).content === text ? null : { type: 'Edit', id: note.id, revision: nextRevision(events, note.id), content: text, harness: true };
}

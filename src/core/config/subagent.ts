// Whether a Session may start another Subagent, as the config's subagent section says.
import type { Config } from './config';
import { unknownNames } from './headless';

// Subagents running at once per parent Session at most.
const DEFAULT_MAX = 2;

// Whether a Subagent runs in a worktree of its own: its call asks for one, or headless.worktree does for every one.
export const inWorktree = ({ headless }: Pick<Config, 'headless'>, worktree?: true) => worktree === true || headless?.worktree === true;

// Why not, as the Tool Result says it; null when it may. running: the Session's Subagents running now.
// place: whether the call asks for a worktree, and whether the parent Session runs in a git repository.
export function subagentRefusal(
  { profiles, subagent, headless }: Pick<Config, 'profiles' | 'subagent' | 'headless'>, running: number, place: { worktree?: true; repository: boolean } = { repository: true },
): string | null {
  const wrong = unknownNames(['profile', 'profiles'], [subagent?.profile], Object.keys(profiles));
  if (wrong) return `subagent.profile: ${wrong}`;
  if (inWorktree({ headless }, place.worktree) && !place.repository) return 'worktree: not a git repository';
  return running >= (subagent?.max ?? DEFAULT_MAX) ? `limit reached: ${running} running` : null;
}

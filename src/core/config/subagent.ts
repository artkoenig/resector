// Whether a Session may start another Subagent, as the config's subagent section says.
import type { Config } from './config';
import { unknownNames } from './headless';

// Subagents running at once per parent Session at most.
const DEFAULT_MAX = 2;

// Why not, as the Tool Result says it; null when it may. running: the Session's Subagents running now.
export function subagentRefusal({ profiles, subagent }: Pick<Config, 'profiles' | 'subagent'>, running: number): string | null {
  const wrong = unknownNames(['profile', 'profiles'], [subagent?.profile], Object.keys(profiles));
  if (wrong) return `subagent.profile: ${wrong}`;
  return running >= (subagent?.max ?? DEFAULT_MAX) ? `limit reached: ${running} running` : null;
}

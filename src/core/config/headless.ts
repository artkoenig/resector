// The settings a Headless Run starts with: the config's headless section, overridden by the flags, checked against
// what exists.
import type { Config, Headless } from './config';

// Flags of `resector -p`: the headless section's keys, and Auto-approve, which is a flag only.
export type Flags = Headless & { autoApprove?: boolean };
export type Settings = Headless & { autoApprove: boolean };
// What exists: Context Policies loaded, tools in the catalog, whether the run is in a git repository.
export type Known = { policies: string[]; tools: string[]; repository: boolean };

// Unknown names are a usage error listing the valid ones; so is a worktree where none can be made.
export function headlessSettings(config: Config, flags: Flags, known: Known): Settings | { usage: string } {
  const settings: Settings = { ...config.headless, ...defined(flags), autoApprove: flags.autoApprove ?? false };
  const usage = [
    unknown(['profile', 'profiles'], [settings.profile], Object.keys(config.profiles)),
    unknown(['policy', 'policies'], [settings.policy], [...known.policies, 'off']),
    unknown(['tools', 'tools'], settings.tools ?? [], known.tools),
    settings.worktree && !known.repository ? 'worktree: not a git repository' : null,
  ].find(u => u !== null);
  return usage ? { usage } : settings;
}

// The names given that are not valid, listing the valid ones; null when all are (or none is given).
function unknown([one, all]: [string, string], given: (string | undefined)[], valid: string[]): string | null {
  const bad = given.filter(n => n !== undefined && !valid.includes(n));
  return bad.length ? `unknown ${one} ${bad.join(', ')} (${all}: ${valid.join(', ')})` : null;
}

// A flag not given leaves the config's value.
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

// The settings a Headless Run starts with: the config's headless section, overridden by the flags, checked against
// what exists.
import type { Config, Headless } from './config';

// Flags of `resector -p`: the headless section's keys, and Auto-approve, which is a flag only.
export type Flags = Headless & { autoApprove?: boolean };
export type Settings = Headless & { autoApprove: boolean };
// The names that exist: Context Policies loaded, tools in the catalog.
export type Known = { policies: string[]; tools: string[] };

// Unknown names are a usage error listing the valid ones.
export function headlessSettings(config: Config, flags: Flags, known: Known): Settings | { usage: string } {
  const settings: Settings = { ...config.headless, ...defined(flags), autoApprove: flags.autoApprove ?? false };
  const profiles = Object.keys(config.profiles);
  if (settings.profile !== undefined && !profiles.includes(settings.profile)) return { usage: `unknown profile ${settings.profile} (profiles: ${profiles.join(', ')})` };
  const policies = [...known.policies, 'off'];
  if (settings.policy !== undefined && !policies.includes(settings.policy)) return { usage: `unknown policy ${settings.policy} (policies: ${policies.join(', ')})` };
  const unknown = (settings.tools ?? []).filter(t => !known.tools.includes(t));
  if (unknown.length) return { usage: `unknown tools ${unknown.join(', ')} (tools: ${known.tools.join(', ')})` };
  return settings;
}

// A flag not given leaves the config's value.
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

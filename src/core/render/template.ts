// Thinking modes a chat template offers, read from its Jinja source: off and on when it reads
// enable_thinking, then the effort levels it accepts for reasoning_effort, lowest first.
import type { Thinking } from '../log/events';

// When the chat template is not known: only the switch, since which efforts it accepts is not known either.
export const DEFAULT_MODES: Thinking[] = ['off', 'on'];

// Every effort a server may pass on (splash's list), lowest first.
export const RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const rank = (effort: string) => (RANK.includes(effort) ? RANK.indexOf(effort) : RANK.length);
const quoted = (text: string) => [...text.matchAll(/['"]([\w-]+)['"]/g)].map(m => m[1]!);

export function thinkingModes(template: string): Thinking[] {
  const toggle = /\benable_thinking\b/.test(template) ? ['off', 'on'] : [];
  return [...toggle, ...efforts(template)];
}

// The list a template checks the effort against (`reasoning_effort not in ('low', …)`), else the values
// it compares it with (`reasoning_effort == 'low'`).
function efforts(template: string): string[] {
  const listed = [...template.matchAll(/reasoning_effort\s+(?:not\s+)?in\s*[([]([^)\]]*)[)\]]/g)].flatMap(m => quoted(m[1]!));
  const compared = [...template.matchAll(/reasoning_effort\s*[!=]=\s*(['"][\w-]+['"])/g)].flatMap(m => quoted(m[1]!));
  return [...new Set(listed.length ? listed : compared)].sort((a, b) => rank(a) - rank(b));
}

// Thinking modes from the prompts a server rendered for each effort of RANK (null: refused), where the template
// itself is not readable (splash). Efforts that render alike are one mode, named as its prompt names it (splash renders
// an effort the template rejects as its alias: high as xhigh); `none` rendered apart is off, and then on is offered too.
export function probedModes(prompts: (string | null)[]): Thinking[] {
  const groups = new Map<string, string[]>();
  RANK.forEach((effort, i) => {
    const prompt = prompts[i];
    if (prompt != null) groups.set(prompt, [...(groups.get(prompt) ?? []), effort]);
  });
  // All alike: the template does not read the effort.
  if (groups.size < 2) return [];
  return [...groups].flatMap(([prompt, efforts]) => {
    const name = efforts.find(e => new RegExp(`\\b${e}\\b`).test(prompt)) ?? efforts[0]!;
    return name === 'none' ? ['off', 'on'] : [name];
  });
}

// Thinking modes a chat template offers (FR-49), read from its Jinja source: off and on when it reads
// enable_thinking, then the effort levels it accepts for reasoning_effort, lowest first.
import type { Thinking } from '../log/events';

// When the chat template is not known: every mode the backends map (architecture §4).
export const DEFAULT_MODES: Thinking[] = ['off', 'on', 'low', 'medium', 'high'];

const RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
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

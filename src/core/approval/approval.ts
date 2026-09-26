// Tool Approval (FR-22–FR-25, architecture §5): permission rules decide each sub-command of a bash call.
import { posix } from 'node:path';
import type { SessionEvent } from '../log/events';

export type Action = 'allow' | 'ask' | 'deny';
// Where a rule comes from; project config may only tighten (FR-25), session rules come from `a` (FR-23).
export type Source = 'built-in' | 'config' | 'project' | 'session';
export type Rule = { pattern: string; action: Action; source: Source };

// A simple command of a compound one: its text, its arguments and the files it writes by redirection.
// null: not literal ($VAR, $(…)), so where it points is unknown.
export type Command = { text: string; args: (string | null)[]; writes: (string | null)[] };
// Splitter port (adapters/bash): the simple commands of a bash command line, null when it does not parse.
export type Split = (command: string) => Command[] | null;

// fixed: asks for a reason no rule can change (an argument, the parse), so `a` cannot allow it.
export type Check = { text: string; action: Action; why: string; fixed: boolean };
export type Verdict = { action: Action; checks: Check[] };

// FR-22: read-only commands run without asking.
const READ_ONLY = ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'sed -n', 'git status', 'git diff', 'git log', 'git show'];
export const BUILTIN_ALLOW: Rule[] = READ_ONLY.map(command => ({ pattern: `${command} *`, action: 'allow', source: 'built-in' }));

// `<command> *` matches the command alone or with arguments; any other `*` matches anything.
export function matches(pattern: string, text: string): boolean {
  const command = text.trim().replace(/\s+/g, ' ');
  if (pattern.endsWith(' *')) {
    const base = pattern.slice(0, -2);
    return command === base || command.startsWith(`${base} `);
  }
  const literal = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${literal.join('[\\s\\S]*')}$`).test(command);
}

// Devices any command may name.
const DEVICES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr']);

// Why an argument makes the call ask, or null: not literal, or pointing outside the project root.
function argumentProblem(arg: string | null, root: string): string | null {
  if (arg === null) return 'argument not literal';
  const path = arg.replace(/^--?[\w-]+=/, '');
  const inside = !path.startsWith('~') && (DEVICES.has(path) || isInside(posix.resolve(root, path), root));
  return inside ? null : `argument outside project: ${arg}`;
}
const isInside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

type Context = { rules: Rule[]; split: Split; root: string };

// One sub-command: the last matching rule, default ask; arguments outside the project ask whatever the rule
// (unless denied); a read-only command of the built-in list writing a file asks.
function check({ text, args, writes }: Command, { rules, root }: Context): Check {
  const rule = rules.findLast(r => matches(r.pattern, text));
  const decided = { text, action: rule?.action ?? 'ask', why: rule ? `${rule.source} rule "${rule.pattern}"` : 'no rule → default ask', fixed: false };
  if (decided.action === 'deny') return decided;
  const problem = [...args, ...writes].map(arg => argumentProblem(arg, root)).find(p => p !== null);
  if (problem) return { text, action: 'ask', why: problem, fixed: true };
  const written = writes.find(w => !DEVICES.has(w!));
  if (decided.action === 'allow' && rule!.source === 'built-in' && written) return { text, action: 'ask', why: `writes ${written}`, fixed: false };
  return decided;
}

// Every sub-command must be allowed: one deny denies the call, one ask asks (FR-22).
export function evaluate(command: string, context: Context): Verdict {
  const commands = context.split(command);
  if (!commands?.length) return { action: 'ask', checks: [{ text: command, action: 'ask', why: commands ? 'no command' : 'unparseable', fixed: true }] };
  const checks = commands.map(c => check(c, context));
  const action = checks.some(c => c.action === 'deny') ? 'deny' : checks.some(c => c.action === 'ask') ? 'ask' : 'allow';
  return { action, checks };
}

// Words of a command's prefix for "allow for session", by its first words (architecture §5).
const ARITY: Record<string, number> = {
  git: 2, npm: 2, 'npm run': 3, pnpm: 2, 'pnpm run': 3, yarn: 2, 'yarn run': 3, bun: 2, 'bun run': 3, npx: 2, bunx: 2,
  cargo: 2, go: 2, docker: 2, 'docker compose': 3, kubectl: 2, make: 2,
};

// `a` allows the command's prefix and anything after it: `git checkout -b x` → `git checkout *`.
export function prefixRule(text: string): string {
  const words = text.trim().split(/\s+/);
  const arity = ARITY[words.slice(0, 2).join(' ')] ?? ARITY[words[0]!] ?? 1;
  return `${words.slice(0, arity).join(' ')} *`;
}

// The rules `a` adds for a call: one per sub-command asked for; none when a rule cannot help (FR-23).
export function sessionRules({ checks }: Verdict): { patterns: string[] } | { error: string } {
  const asked = checks.filter(c => c.action === 'ask');
  const fixed = asked.find(c => c.fixed);
  if (fixed) return { error: `cannot allow for session: ${fixed.why} – y runs once, e edits` };
  return { patterns: [...new Set(asked.map(c => prefixRule(c.text)))] };
}

// The session's allow rules, in the order they were added (FR-25).
export const sessionAllowed = (events: SessionEvent[]): Rule[] =>
  events.flatMap(e => (e.type === 'AllowRuleAdded' ? [{ pattern: e.pattern, action: 'allow' as const, source: 'session' as const }] : []));

export type Permissions = Record<string, Action>;

// The rules in order: built-in, global config, project config without `allow` (FR-25); ignored: the project's allows.
export function permissionRules(global: Permissions | undefined, project: Permissions | undefined): { rules: Rule[]; ignored: string[] } {
  const own = (permissions: Permissions | undefined, source: Source) =>
    Object.entries(permissions ?? {}).map(([pattern, action]): Rule => ({ pattern, action, source }));
  const fromProject = own(project, 'project');
  return {
    rules: [...BUILTIN_ALLOW, ...own(global, 'config'), ...fromProject.filter(r => r.action !== 'allow')],
    ignored: fromProject.filter(r => r.action === 'allow').map(r => r.pattern),
  };
}

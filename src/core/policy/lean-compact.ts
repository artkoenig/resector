// The built-in Context Policy lean-compact (ADR 0001): from half the window on, read-only Tool Pairs and Thinking under
// 200 tokens are removed, then the rest of the work is compacted into one Note. The newest block (Tool Pair) stays as is.
// Written like a policy module in ~/.config/resector/policies: the reference for one.
import { DEFAULT_INSTRUCTION } from '../compaction/compaction';
import type { PolicyBlock, PolicyContext, PolicyOperation } from './policy';

const COMPACT_FROM = 1 / 2;
const SHORT_THINKING = 200;
// Like the built-in allow list of Tool Approval (FR-22), plus a few harmless ones.
const READ_ONLY = ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'sed -n', 'git status', 'git diff', 'git log', 'git show', 'pwd', 'cd', 'tree', 'stat', 'file', 'echo'];
// Options that make a read-only command write or run something, by its name (as in Tool Approval).
const WRITING: Record<string, RegExp> = {
  find: /\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)(\s|$)/,
  sed: /\s(-[^-\s]*i|--in-place)/,
  git: /\s--output(=|\s|$)/,
  rg: /\s--pre(=|\s|$)/,
};

export const description = 'drops reads and short thinking, compacts at ½';

export default function leanCompact({ window, used, blocks: all }: PolicyContext): PolicyOperation[] {
  if (used < window * COMPACT_FROM) return [];
  // The model has not yet built on the newest block: it is left out, a Tool Pair as a whole.
  const last = all.at(-1);
  const newest = new Set([last?.id, last?.pair]);
  const blocks = all.filter(b => !newest.has(b.id));
  const reads = blocks.filter(b => isRead(b, blocks));
  const short = blocks.filter(b => b.kind === 'Thinking' && b.tokens < SHORT_THINKING);
  const gone = new Set([...reads.flatMap(b => [b.id, b.pair!]), ...short.map(b => b.id)]);
  const sources = blocks.filter(b => compactable(b) && !gone.has(b.id));
  const removals = [...reads, ...short].map(b => ({ op: 'remove' as const, id: b.id }));
  // Only the Note of an earlier Compaction left: compacting it again would not free the window.
  const worth = sources.some(b => b.origin !== 'compaction');
  return worth ? [...removals, { op: 'compact', sources: sources.map(b => b.id), instruction: DEFAULT_INSTRUCTION }] : removals;
}

// The user's word, the project's Notes and a Tool Call awaiting approval stay.
const compactable = (b: PolicyBlock) =>
  b.kind !== 'System' && b.kind !== 'Tools' && b.kind !== 'User' && !b.pending && b.origin !== 'environment' && b.origin !== 'file';

// A bash Tool Call with its result whose every command only reads. A Question's answers (by the user) stay.
function isRead(b: PolicyBlock, blocks: PolicyBlock[]): boolean {
  if (b.kind !== 'Tool Call' || b.pending || b.pair === null) return false;
  if (blocks.find(r => r.id === b.pair)?.origin === 'user') return false;
  // Quoted text is an argument, not an operator (`grep "a\|b"`); double quotes still run `$(…)`. One pass, left to
  // right, so a quote inside the other kind does not pair up.
  let runs = false;
  const command = b.content
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, q => ((runs ||= q[0] === '"' && /`|\$\(/.test(q)), "''"))
    .replace(/\d?>&\d|\d?>\s*\/dev\/null/g, '');
  if (runs || /[>`]|\$\(/.test(command)) return false;
  return command.split(/&&|\|\||[;|\n]/).every(part => readOnly(part.trim()));
}

const readOnly = (command: string) =>
  !command || (READ_ONLY.some(r => command === r || command.startsWith(`${r} `)) && !WRITING[command.split(/\s/)[0]!]?.test(` ${command}`));

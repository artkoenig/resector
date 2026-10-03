// The built-in Context Policy lean-compact (ADR 0001): from half the window on, read-only Tool Pairs and Thinking under
// 200 tokens are removed, then the rest of the work, the user's messages with it, is compacted into one Note. Without
// other work they are compacted instead, so what was read survives. The newest block (Tool Pair) stays as is. A lead
// right before the Note tells the model it continues its own work.
// Written like a policy module in ~/.config/resector/policies: the reference for one.
import instruction from './lean-compact-instruction.md' with { type: 'text' };
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

export const INSTRUCTION = instruction.trimEnd();
// A Note of its own right before the Note of a Compaction: the model reads that Note as a user message, so it is told
// this is its own work, not a new task. Never compacted with it.
export const LEAD =
  'The summary below is of your own earlier work in this session, not a new task. Build on it, do not redo what is under Done; continue with Next steps.';

export const description = 'drops reads and short thinking, compacts at ½';

export default function leanCompact(context: PolicyContext): PolicyOperation[] {
  const lead = led(context.blocks);
  // Alone in its pass: a Compaction moves the Note, so the lead is placed after it.
  return lead.length ? lead : compacted(context);
}

function compacted({ window, used, blocks: all }: PolicyContext): PolicyOperation[] {
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
  const compact = (from: PolicyBlock[]): PolicyOperation => ({ op: 'compact', sources: from.map(b => b.id), instruction: INSTRUCTION });
  if (sources.some(isWork)) return [...removals, compact(sources)];
  // No work but reads and short Thinking: removing them would lose all the model learned, so they are compacted.
  if (removals.length) return [compact(blocks.filter(compactable))];
  // Only the user's messages and the Note of an earlier Compaction left: compacting them would hardly free the window.
  return [];
}

const isLead = (b: PolicyBlock) => b.origin === 'policy' && b.content === LEAD;
// The project's Notes, the lead and a Tool Call awaiting approval stay.
const compactable = (b: PolicyBlock) =>
  b.kind !== 'System' && b.kind !== 'Tools' && !b.pending && b.origin !== 'environment' && b.origin !== 'file' && !isLead(b);
// What the model did since the last Compaction.
const isWork = (b: PolicyBlock) => b.kind !== 'User' && b.origin !== 'compaction' && !isLead(b);

// The lead right before the first Note of a Compaction; one elsewhere, left behind by a Compaction, goes.
function led(blocks: PolicyBlock[]): PolicyOperation[] {
  const first = blocks.findIndex(b => b.origin === 'compaction');
  const before = first > 0 ? blocks[first - 1]! : undefined;
  const stale = blocks.filter(b => isLead(b) && b !== before).map(b => ({ op: 'remove' as const, id: b.id }));
  return before && !isLead(before) ? [...stale, { op: 'note', after: before.id, content: LEAD }] : stale;
}

// A bash Tool Call with its result whose every command only reads. A Question's answers (by the user) stay.
function isRead(b: PolicyBlock, blocks: PolicyBlock[]): boolean {
  // A pending Tool Call has no result yet, so no pair.
  if (b.kind !== 'Tool Call' || b.pair === null) return false;
  if (blocks.find(r => r.id === b.pair)!.origin === 'user') return false;
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

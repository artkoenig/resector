// The built-in Context Policy guided-compaction (ADR 0001): like lean-compact, but the model decides which reads stay.
// From half the window on, the model gets the Context as sent and compacts the work, the user's later messages with
// it, into one Note that ends with the paths of the files it will change; the user's first message stays as it is. The
// newest read-only Tool Pair naming one of them stays, the other reads go. No Goal: the first message is it. The newest
// block (Tool Pair) stays as is; a lead right before the Note as in lean-compact.
import instruction from './guided-compaction-instruction.md' with { type: 'text' };
import { compactable, isRead, isWork, led } from './lean-compact';
import type { PolicyBlock, PolicyContext, PolicyOperation } from './policy';

const COMPACT_FROM = 1 / 2;

export const INSTRUCTION = instruction.trimEnd();

export const description = 'compacts at ½, keeps the reads the model asks for';

export default function guidedCompaction(context: PolicyContext): PolicyOperation[] {
  const lead = led(context.blocks);
  // Alone in its pass: a Compaction moves the Note, so the lead is placed after it.
  if (lead.length) return lead;
  const dropped = unkept(context.blocks);
  return dropped.length ? dropped : compacted(context);
}

// Two passes, as a policy is stateless: the Compaction leaves the reads out of its sources (the model saw them in
// the Context), the next pass removes those its Note does not keep.
function compacted({ window, used, blocks: all }: PolicyContext): PolicyOperation[] {
  if (used < window * COMPACT_FROM) return [];
  // The model has not yet built on the newest block: it is left out, a Tool Pair as a whole.
  const last = newest(all);
  const blocks = all.filter(b => !last.has(b.id));
  const reads = new Set(blocks.filter(b => isRead(b, blocks)).flatMap(b => [b.id, b.pair!]));
  const kept = keptBy(guide(blocks), blocks);
  // Reads the last Note kept are no new work: compacting again would only repeat it.
  const isNew = (b: PolicyBlock) => compactable(b) && isWork(b) && !(reads.has(b.id) && kept.has(readOf(b, blocks)));
  if (!blocks.some(isNew)) return [];
  // The task as the user put it: never rewritten.
  const first = blocks.find(b => b.kind === 'User');
  const sources = blocks.filter(b => compactable(b) && !reads.has(b.id) && b !== first).map(b => b.id);
  return [{ op: 'compact', sources, instruction: INSTRUCTION, inContext: true }];
}

// The reads older than the guiding Note that it does not keep; never the newest block.
function unkept(blocks: PolicyBlock[]): PolicyOperation[] {
  const note = guide(blocks);
  if (!note) return [];
  const kept = keptBy(note, blocks);
  const last = newest(blocks);
  return olderReads(note, blocks)
    .filter(b => !last.has(b.id) && !kept.has(b))
    .map(b => ({ op: 'remove' as const, id: b.id }));
}

const newest = (blocks: PolicyBlock[]) => new Set([blocks.at(-1)?.id, blocks.at(-1)?.pair]);
// The newest Note of a Compaction with a Keep section: one of the user's or of another policy says nothing on reads.
const guide = (blocks: PolicyBlock[]) =>
  blocks.filter(b => b.origin === 'compaction' && keepOf(b.content)).sort((a, b) => b.id - a.id)[0];
// The Tool Call of a read Tool Pair, given either of its blocks.
const readOf = (b: PolicyBlock, blocks: PolicyBlock[]) => (b.kind === 'Tool Call' ? b : blocks.find(c => c.id === b.pair)!);

// The reads that are, of those older than the Note, the newest naming a path under its Keep: an older one shows the
// file before later edits.
function keptBy(note: PolicyBlock | undefined, blocks: PolicyBlock[]): Set<PolicyBlock | undefined> {
  if (!note) return new Set();
  const older = olderReads(note, blocks);
  const newestOf = (path: string) => older.filter(b => b.content.includes(path)).at(-1);
  return new Set(keepOf(note.content)!.map(newestOf));
}

// The Tool Calls of the reads made before the Note: by id, as a Compaction leaves them where they were.
const olderReads = (note: PolicyBlock, blocks: PolicyBlock[]) =>
  // Stryker disable next-line EqualityOperator: the Note itself is no read.
  blocks.filter(b => b.id < note.id && isRead(b, blocks));

// The paths under `## Keep`, list marks and backticks stripped; null without that section.
export function keepOf(note: string): string[] | null {
  const keep = sectionsOf(note).find(s => s.heading.startsWith('Keep'));
  if (!keep) return null;
  return keep.lines
    .map(line => line.replace(/^\s*(?:[-*+]|\d+\.)\s/, '').replace(/`/g, '').trim())
    .filter(path => path && !/^\(?none\)?\.?$/i.test(path));
}

// A Note's `## ` sections in order, with the lines below each heading.
const sectionsOf = (note: string) =>
  note
    .split(/^(?=## )/m)
    .filter(part => part.startsWith('## '))
    .map(part => {
      const [heading, ...lines] = part.split('\n');
      return { heading: heading!.slice(3).trim(), lines };
    });

// The built-in Context Policy summary-reset (ADR 0001): an intro at the front tells the model what is coming. Once the
// work since the last reset takes a third of the window, the results of the newest Tool Calls are replaced by an error
// asking the model for a summary between <summary> tags. Once the model wrote one, it alone stays, as a Note led by a handover: everything before it
// goes but the System, Tools Block, the intro and the project's Notes.
// A policy runs before a request, after the calls ran: the error says the call ran, its output is withheld.
import instruction from './summary-reset-instruction.md' with { type: 'text' };
import type { PolicyBlock, PolicyContext, PolicyOperation } from './policy';

const ERROR_FROM = 1 / 3;
// From the first opening tag to the last closing one: a summary may quote the tags (from this very file, say).
const SUMMARY = /<summary>([\s\S]*)<\/summary>/;

export const ERROR = instruction.trimEnd();
// Right after the System and Tools Block, from the first request on: the model knows the rules before it needs them.
export const INTRO =
  'How this session works: your context is limited. Once your work since the start (or since the last summary) takes a third of it, every tool call fails with an error saying the context is full; the command still runs, but its output is withheld. Then write a summary of the session between <summary> and </summary>, as the error describes. Only that summary is kept: everything else (the user\'s messages, your tool calls, their results, your answers) is deleted, and the session continues from the summary alone.';
// Before the summary in its Note: the model reads it as a user message, so it is told this is its own work.
export const HANDOVER =
  'Continuation of the session with the following summary of your own earlier work; everything before it was deleted. Continue from it, do not redo what is done. Trust it: what it quotes is verbatim, do not read it again.';

export const description = 'errors tool calls once the work takes ⅓, keeps only the summary the model writes';

export default function summaryReset(context: PolicyContext): PolicyOperation[] {
  const intro = introduced(context.blocks);
  if (intro.length) return intro;
  const reset = resetTo(context.blocks);
  return reset.length ? reset : errored(context);
}

// The intro after the System and Tools Block, once.
function introduced(blocks: PolicyBlock[]): PolicyOperation[] {
  if (blocks.some(isIntro)) return [];
  const front = blocks.findLast(b => b.kind === 'System' || b.kind === 'Tools');
  return front ? [{ op: 'note', after: front.id, content: INTRO }] : [];
}

// The newest summary of the model, without its tags (only markers for the policy), as the handover Note: the one
// there is overwritten, else a new one in its place. Every other block before it removed.
function resetTo(blocks: PolicyBlock[]): PolicyOperation[] {
  const answer = blocks.findLast(b => b.kind === 'Assistant' && SUMMARY.test(b.content));
  if (!answer) return [];
  const content = `${HANDOVER}\n\n${SUMMARY.exec(answer.content)![1]!.trim()}`;
  const handover = blocks.find(isHandover);
  // A Tool Pair goes with its Tool Call.
  const before = blocks.filter(b => b !== handover && blocks.indexOf(b) < blocks.indexOf(answer) && removable(b) && b.kind !== 'Tool Result');
  return [
    handover ? { op: 'edit', id: handover.id, content } : { op: 'note', after: answer.id, content },
    ...[...before, answer].map(b => ({ op: 'remove' as const, id: b.id })),
  ];
}

// Once the work since the last reset takes a third of the window, the results of the newest calls (since the last
// answer) become the error. The summary does not count: the work it leaves room for would shrink with every reset.
function errored({ window, used, blocks }: PolicyContext): PolicyOperation[] {
  const handover = blocks.findIndex(isHandover);
  const kept = blocks.slice(0, handover + 1).reduce((sum, b) => sum + b.tokens, 0);
  if (used - kept < window * ERROR_FROM) return [];
  const since = blocks.findLastIndex(b => b.kind !== 'Tool Call' && b.kind !== 'Tool Result');
  return blocks
    .slice(since + 1)
    // A Question's answers are the user's, not a tool's.
    .filter(b => b.kind === 'Tool Result' && b.origin !== 'user' && b.content !== ERROR)
    .map(b => ({ op: 'edit' as const, id: b.id, content: ERROR }));
}

const isIntro = (b: PolicyBlock) => b.origin === 'policy' && b.content === INTRO;
const isHandover = (b: PolicyBlock) => b.kind === 'Note' && b.origin === 'policy' && b.content.startsWith(HANDOVER);
// The System, Tools Block, the intro, the project's Notes and a Tool Call awaiting approval stay.
const removable = (b: PolicyBlock) =>
  b.kind !== 'System' && b.kind !== 'Tools' && !b.pending && b.origin !== 'environment' && b.origin !== 'file' && !isIntro(b);

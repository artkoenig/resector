// An answer of the model as Context Blocks: its text, then one Tool Call per bash call (architecture §3).
import type { ChatResult } from '../backend';
import type { SessionEvent } from '../log/events';
import { parseCall, type RawCall } from './bash';

type BlockAdded = Extract<SessionEvent, { type: 'BlockAdded' }>;
type Parsed = { raw: RawCall; parsed: ReturnType<typeof parseCall> };

const commandOf = ({ parsed }: Parsed) => ('command' in parsed ? [parsed.command] : []);
const errorOf = ({ parsed }: Parsed) => ('error' in parsed ? [parsed.error] : []);
const assistant = (id: number, content: string, cutOff: boolean): BlockAdded =>
  ({ type: 'BlockAdded', id, kind: 'Assistant', origin: 'model', content, ...(cutOff && { cutOff }) });

// Blocks from id `first` on. A cut-off answer runs no call (FR-19); calls that are no bash command stay
// in the text, not run – `notRun` says why.
export function answerBlocks(result: ChatResult, first: number): { events: BlockAdded[]; notRun: string | null } {
  const cutOff = result.finish === 'length' || result.finish === 'aborted';
  const calls = result.calls.map(raw => ({ raw, parsed: parseCall(raw) }));
  const runnable = cutOff ? [] : calls.flatMap(commandOf);
  const kept = calls.filter(c => cutOff || errorOf(c).length).map(c => `${c.raw.name} ${c.raw.arguments}`);
  const content = [result.content, ...kept].filter(Boolean).join('\n');
  const text = content || !runnable.length ? [assistant(first, content, cutOff)] : [];
  const toolCalls = runnable.map((command, i): BlockAdded => ({ type: 'BlockAdded', id: first + text.length + i, kind: 'Tool Call', origin: 'model', content: command }));
  return { events: [...text, ...toolCalls], notRun: cutOff ? null : (calls.flatMap(errorOf)[0] ?? null) };
}

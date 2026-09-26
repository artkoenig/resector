// An answer of the model as Context Blocks: its reasoning, its text, then one Tool Call per tool call (architecture §3).
import type { ChatResult } from '../backend';
import type { SessionEvent } from '../log/events';
import { parseCall, type RawCall } from './bash';

type BlockAdded = Extract<SessionEvent, { type: 'BlockAdded' }>;
type Parsed = { raw: RawCall; parsed: ReturnType<typeof parseCall> };

const callOf = ({ parsed }: Parsed) => ('tool' in parsed ? [parsed] : []);
const errorOf = ({ parsed }: Parsed) => ('error' in parsed ? [parsed.error] : []);
const block = (kind: 'Thinking' | 'Assistant', id: number, content: string, cutOff: boolean): BlockAdded =>
  ({ type: 'BlockAdded', id, kind, origin: 'model', content, ...(cutOff && { cutOff }) });

// The reasoning, then the text – none without text when calls follow or when cut off while thinking.
function textBlocks(thinking: string, content: string, cutOff: boolean, calls: boolean, first: number): BlockAdded[] {
  const whileThinking = cutOff && !content;
  const reasoning = thinking ? [block('Thinking', first, thinking, whileThinking)] : [];
  const answered = content || !(calls || (thinking && whileThinking));
  return [...reasoning, ...(answered ? [block('Assistant', first + reasoning.length, content, cutOff)] : [])];
}

// Blocks from id `first` on. A cut-off answer runs no call (FR-19); cut off while thinking, there is only
// the Thinking block. Calls that cannot run stay in the text, not run – `notRun` says why.
// `tools`: the names in the Tools Block.
export function answerBlocks(result: ChatResult, first: number, tools: string[]): { events: BlockAdded[]; notRun: string | null } {
  const cutOff = result.finish === 'length' || result.finish === 'aborted';
  const calls = result.calls.map(raw => ({ raw, parsed: parseCall(raw, tools) }));
  const runnable = cutOff ? [] : calls.flatMap(callOf);
  const kept = calls.filter(c => cutOff || errorOf(c).length).map(c => `${c.raw.name} ${c.raw.arguments}`);
  const content = [result.content, ...kept].filter(Boolean).join('\n');
  const text = textBlocks(result.thinking, content, cutOff, runnable.length > 0, first);
  const toolCalls = runnable.map(({ tool, content }, i): BlockAdded =>
    ({ type: 'BlockAdded', id: first + text.length + i, kind: 'Tool Call', origin: 'model', content, ...(tool !== 'bash' && { tool }) }));
  return { events: [...text, ...toolCalls], notRun: cutOff ? null : (calls.flatMap(errorOf)[0] ?? null) };
}

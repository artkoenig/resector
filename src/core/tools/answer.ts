// An answer of the model as Context Blocks: its reasoning, its text, then one Tool Call per tool call.
import type { SessionEvent, Usage } from '../log/events';
import { parseCall, type RawCall } from './call';

export type Finish = 'stop' | 'tool_calls' | 'length' | 'aborted';
// thinking: the model's reasoning; calls: tool calls of the answer, in order; cached: prompt tokens the server reports as reused;
// predicted: what the prediction expected (verification); speed: what the server measured, if it reports it.
export type ChatResult = { thinking: string; content: string; calls: RawCall[]; finish: Finish; usage: Usage | null; cached: number | null; predicted: number | null; speed?: Speed };
// firstToken: ms until the first token; prompt, generation: tokens/s of prompt processing and of generation.
export type Speed = { firstToken?: number; prompt?: number; generation?: number };

type BlockAdded = Extract<SessionEvent, { type: 'BlockAdded' }>;
type Parsed = { raw: RawCall; parsed: ReturnType<typeof parseCall> };

const callOf = ({ parsed }: Parsed) => ('tool' in parsed ? [parsed] : []);
const errorOf = ({ parsed }: Parsed) => ('error' in parsed ? [parsed.error] : []);
const block = (kind: 'Thinking' | 'Assistant', id: number, content: string, cutOff: boolean): BlockAdded =>
  ({ type: 'BlockAdded', id, kind, origin: 'model', content, ...(cutOff && { cutOff }) });

// The reasoning, then the text – none without text when calls follow or when cut off while thinking. Text of
// only whitespace (a line break some models write before a call) counts as none.
function textBlocks(thinking: string, content: string, cutOff: boolean, calls: boolean, first: number): BlockAdded[] {
  const whileThinking = cutOff && !content;
  const reasoning = thinking ? [block('Thinking', first, thinking, whileThinking)] : [];
  const answered = content.trim() || !(calls || (thinking && whileThinking));
  return [...reasoning, ...(answered ? [block('Assistant', first + reasoning.length, content, cutOff)] : [])];
}

// Blocks from id `first` on. A cut-off answer runs no call; cut off while thinking, there is only
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
  // A rejected Question is answered with the error right away (never shown to the user), after all calls.
  const rejections = runnable.flatMap(({ rejected }, i) => (rejected === undefined ? [] : [{ call: toolCalls[i]!.id, rejected }]));
  const results = rejections.map(({ call, rejected }, i): BlockAdded =>
    ({ type: 'BlockAdded', id: first + text.length + toolCalls.length + i, kind: 'Tool Result', origin: 'tool', content: `error: ${rejected}`, call }));
  return { events: [...text, ...toolCalls, ...results], notRun: cutOff ? null : (calls.flatMap(errorOf)[0] ?? null) };
}

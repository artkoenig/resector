// A Tool Call as the model sends it: parsed into tool and content, sent back with its arguments; its result as text.
import type { Stopped, Tool } from '../log/events';
import { TOOL_NAMES } from './catalog';
import { parseQuestions } from './question';

// The one argument of bash and search: a Tool Call's content. A question's content is all its arguments.
const ARGUMENT: Record<Exclude<Tool, 'question'>, string> = { bash: 'command', search: 'query' };

// A run's output; exit: null when the run was stopped.
export type RunResult = { output: string; exit: number | null; stopped: Stopped | null };

// A tool call as the model sent it: arguments are a JSON string.
export type RawCall = { name: string; arguments: string };

// `tools`: the names in the Tools Block; a tool switched off is not run. A Question that cannot be asked is
// `rejected`: its Tool Result tells the model why (it never reaches the user).
export type ParsedCall = { tool: Tool; content: string; rejected?: string } | { error: string };
export function parseCall(call: RawCall, tools: string[]): ParsedCall {
  if (!TOOL_NAMES.includes(call.name)) return { error: `unknown tool ${call.name}` };
  const tool = call.name as Tool;
  if (!tools.includes(tool)) return { error: `tool ${tool} is off (/tools)` };
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return { error: 'arguments are not valid JSON' };
  }
  if (tool === 'question') {
    const parsed = parseQuestions(args);
    return { tool, content: call.arguments, ...('error' in parsed && { rejected: parsed.error }) };
  }
  const content = (args as Record<string, unknown> | null)?.[ARGUMENT[tool]];
  return typeof content === 'string' ? { tool, content } : { error: `no ${ARGUMENT[tool]} string` };
}

// The arguments of a Tool Call as the model sent them.
export const callArguments = (tool: Tool, content: string): string => (tool === 'question' ? content : JSON.stringify({ [ARGUMENT[tool]]: content }));

// Tool Result content: the output as is, then a line saying how the run ended.
export function resultText({ output, exit, stopped }: RunResult, timeout: number): string {
  const end = stopped === 'killed' ? '[killed]' : stopped === 'timeout' ? `[timeout after ${timeout} s]` : `[exit ${exit}]`;
  const text = output.trimEnd();
  return text ? `${text}\n${end}` : end;
}

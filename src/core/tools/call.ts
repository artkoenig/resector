// A Tool Call as the model sends it: parsed into tool and content, sent back with its arguments; its result as text.
import type { Stopped, Tool } from '../log/events';
import { TOOL_NAMES } from './catalog';
import { parseQuestions } from './question';

// The one argument of the other tools: a Tool Call's content. A question's content is all its arguments.
const ARGUMENT: Record<Exclude<Tool, 'question'>, string> = { bash: 'command', websearch: 'query', skill: 'name', image: 'path', subagent: 'prompt' };

// A run's output; exit: null when the run was stopped or still runs in the background.
// `leftover`: the command left processes running, which were killed when it ended.
// `background`: it still runs as a Background Process: its process group and log file.
export type RunResult = { output: string; exit: number | null; stopped: Stopped | null; leftover?: true; background?: Started };
export type Started = { pid: number; log: string };
// Lines of a Background Process's output its Tool Result shows; the rest is in its log.
const BACKGROUND_LINES = 20;

// A tool call as the model sent it: arguments are a JSON string.
export type RawCall = { name: string; arguments: string };

// `tools`: the names in the Tools Block; a tool switched off is not run. A Question that cannot be asked is
// `rejected`: its Tool Result tells the model why (it never reaches the user).
// `background`: a bash call to run as a Background Process.
export type ParsedCall = { tool: Tool; content: string; rejected?: string; background?: true } | { error: string };
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
  if (typeof content !== 'string') return { error: `no ${ARGUMENT[tool]} string` };
  return { tool, content, ...(backgrounded(tool, args) && { background: true }) };
}

// Only bash runs in the background, and only with `background: true`.
const backgrounded = (tool: Tool, args: unknown) => tool === 'bash' && (args as Record<string, unknown>).background === true;

// The arguments of a Tool Call as the model sent them.
export const callArguments = (tool: Tool, content: string, background?: true): string =>
  tool === 'question' ? content : JSON.stringify({ [ARGUMENT[tool]]: content, ...(background && { background }) });

// Tool Result content: the output as is, then a line saying how the run ended. A Subagent's is the line only.
export function resultText({ output, exit, stopped, leftover, background }: RunResult, timeout: number, tool: Tool = 'bash'): string {
  if (background) {
    const { pid, log } = background;
    const where = `pid ${pid} · log ${log} · stop: kill -- -${pid}`;
    if (tool === 'subagent') return `[Subagent started: ${where}]`;
    const last = output.trimEnd().split('\n').slice(-BACKGROUND_LINES).join('\n');
    return [last, `[running in the background: ${where}]`].filter(Boolean).join('\n');
  }
  const end = stopped === 'killed' ? '[killed]' : stopped === 'timeout' ? `[timeout after ${timeout} s]` : `[exit ${exit}]`;
  const lines = [output.trimEnd(), leftover ? '[processes it left running were killed; start long-running ones with background: true]' : '', end];
  return lines.filter(Boolean).join('\n');
}

// resultText read back: the output's lines and how the run ended, null when the result does not say (denied, rejected).
export function resultEnd(content: string): { output: string[]; end: string | null } {
  const lines = content.split('\n');
  const end = lines.at(-1)!.match(/^\[(.+)\]$/)?.[1] ?? null;
  return { output: end === null ? lines : lines.slice(0, -1), end };
}

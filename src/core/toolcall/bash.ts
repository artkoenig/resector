// The tools (FR-21): bash, search and question. Their definitions in the Tools Block, calls as the model sends them, results.
import type { Stopped, Tool } from '../log/events';
import { parseQuestions, QUESTION_DEFINITION } from './question';

type ToolDefinition = { name: string; description: string; parameters: object };
// Every tool the harness runs; the Tools Block holds those switched on (/tools).
const CATALOG: ToolDefinition[] = [
  {
    name: 'bash',
    description: 'Run a shell command in the project root. Returns combined stdout/stderr and the exit code.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'search',
    description: 'Search the web (DuckDuckGo). Returns title, URL and abstract of the top results as JSON.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  QUESTION_DEFINITION,
];
// The one argument of bash and search: a Tool Call's content. A question's content is all its arguments.
const ARGUMENT: Record<Exclude<Tool, 'question'>, string> = { bash: 'command', search: 'query' };
export const TOOL_NAMES = CATALOG.map(t => t.name);

// Tools Block content, protocol-neutral: name, description, JSON schema of the arguments.
const toolsContent = (tools: ToolDefinition[]) => JSON.stringify(tools, null, 2);
// A new session's Tools Block: bash and question; search is switched on with /tools (it needs ddgr).
export const TOOLS = toolsContent(CATALOG.filter(t => t.name !== 'search'));

// The names of the tools in Tools Block content.
export const toolsIn = (tools: string): string[] => (JSON.parse(tools) as { name: string }[]).map(t => t.name);

// Title of the Tools Block: the tool names (FR-4).
export const toolNames = (tools: string): string => toolsIn(tools).join(', ') || 'no tools';

// /tools <name>: the Tools Block content with the tool switched on or off, in catalog order.
export function toggleTool(tools: string, name: string): { content: string } | { error: string } {
  if (!TOOL_NAMES.includes(name)) return { error: `unknown tool ${name} – ${TOOL_NAMES.join(' ')}` };
  const on = toolsIn(tools);
  return { content: toolsWith(on.includes(name) ? on.filter(n => n !== name) : [...on, name]) };
}
// Tools Block content with the named tools, in catalog order.
export const toolsWith = (names: string[]) => toolsContent(CATALOG.filter(t => names.includes(t.name)));

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

// exit: null when the run was stopped.
export type RunResult = { output: string; exit: number | null; stopped: Stopped | null };

// Tool Result content: the output as is, then a line saying how the run ended.
export function resultText({ output, exit, stopped }: RunResult, timeout: number): string {
  const end = stopped === 'killed' ? '[killed]' : stopped === 'timeout' ? `[timeout after ${timeout} s]` : `[exit ${exit}]`;
  const text = output.trimEnd();
  return text ? `${text}\n${end}` : end;
}

// Runner port (adapters/bash): runs a command, streaming its output; aborting the signal kills it.
// timeout: seconds after which a run is stopped (FR-21).
export type RunOptions = { signal: AbortSignal; onOutput: (text: string) => void };
export type Runner = { timeout: number; run(command: string, options: RunOptions): Promise<RunResult> };

// The only tool (FR-21): bash. Its definition in the Tools Block, calls as the model sends them, results.
import type { Stopped } from '../log/events';

type ToolDefinition = { name: string; description: string; parameters: object };
// Every tool the harness runs; the Tools Block holds those switched on (/tools).
const CATALOG: ToolDefinition[] = [
  {
    name: 'bash',
    description: 'Run a shell command in the project root. Returns combined stdout/stderr and the exit code.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
];
export const TOOL_NAMES = CATALOG.map(t => t.name);

// Tools Block content, protocol-neutral: name, description, JSON schema of the arguments.
const toolsContent = (tools: ToolDefinition[]) => JSON.stringify(tools, null, 2);
export const TOOLS = toolsContent(CATALOG);

// The names of the tools in Tools Block content.
export const toolsIn = (tools: string): string[] => (JSON.parse(tools) as { name: string }[]).map(t => t.name);

// Title of the Tools Block: the tool names (FR-4).
export const toolNames = (tools: string): string => toolsIn(tools).join(', ') || 'no tools';

// /tools <name>: the Tools Block content with the tool switched on or off, in catalog order.
export function toggleTool(tools: string, name: string): { content: string } | { error: string } {
  if (!TOOL_NAMES.includes(name)) return { error: `unknown tool ${name} – ${TOOL_NAMES.join(' ')}` };
  const on = toolsIn(tools);
  const next = on.includes(name) ? on.filter(n => n !== name) : [...on, name];
  return { content: toolsContent(CATALOG.filter(t => next.includes(t.name))) };
}

// A tool call as the model sent it: arguments are a JSON string.
export type RawCall = { name: string; arguments: string };

// `tools`: the names in the Tools Block; a tool switched off is not run.
export function parseCall(call: RawCall, tools: string[]): { command: string } | { error: string } {
  if (call.name !== 'bash') return { error: `unknown tool ${call.name}` };
  if (!tools.includes(call.name)) return { error: `tool ${call.name} is off (/tools)` };
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return { error: 'arguments are not valid JSON' };
  }
  const command = (args as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? { command } : { error: 'no command string' };
}

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

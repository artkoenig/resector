// The only tool (FR-21): bash. Its definition in the Tools Block, calls as the model sends them, results.
import type { Stopped } from '../log/events';

// Tools Block content, protocol-neutral: name, description, JSON schema of the arguments.
export const TOOLS = JSON.stringify(
  [
    {
      name: 'bash',
      description: 'Run a shell command in the project root. Returns combined stdout/stderr and the exit code.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  ],
  null,
  2,
);

// Title of the Tools Block: the tool names (FR-4).
export const toolNames = (tools: string): string => (JSON.parse(tools) as { name: string }[]).map(t => t.name).join(', ');

// A tool call as the model sent it: arguments are a JSON string.
export type RawCall = { name: string; arguments: string };

export function parseCall(call: RawCall): { command: string } | { error: string } {
  if (call.name !== 'bash') return { error: `unknown tool ${call.name}` };
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

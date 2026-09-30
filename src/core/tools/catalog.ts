// The tool catalog: bash, search and question, their definitions, and the Tools Block content offering them.
import { QUESTION_DEFINITION } from './question';

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
export const TOOL_NAMES = CATALOG.map(t => t.name);

// Tools Block content, protocol-neutral: name, description, JSON schema of the arguments.
const toolsContent = (tools: ToolDefinition[]) => JSON.stringify(tools, null, 2);
// A new session's Tools Block: bash and question; search is switched on with /tools (it needs ddgr).
export const TOOLS = toolsContent(CATALOG.filter(t => t.name !== 'search'));

// The names of the tools in Tools Block content.
export const toolsIn = (tools: string): string[] => (JSON.parse(tools) as { name: string }[]).map(t => t.name);

// Title of the Tools Block: the tool names.
export const toolNames = (tools: string): string => toolsIn(tools).join(', ') || 'no tools';

// /tools <name>: the Tools Block content with the tool switched on or off, in catalog order.
export function toggleTool(tools: string, name: string): { content: string } | { error: string } {
  if (!TOOL_NAMES.includes(name)) return { error: `unknown tool ${name} – ${TOOL_NAMES.join(' ')}` };
  const on = toolsIn(tools);
  return { content: toolsWith(on.includes(name) ? on.filter(n => n !== name) : [...on, name]) };
}
// Tools Block content with the named tools, in catalog order.
export const toolsWith = (names: string[]) => toolsContent(CATALOG.filter(t => names.includes(t.name)));

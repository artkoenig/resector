// The tool catalog: bash, websearch, question, skill and image, their definitions, and the Tools Block content offering them.
import { QUESTION_DEFINITION } from './question';

type ToolDefinition = { name: string; description: string; parameters: object };
// Every tool the harness runs; the Tools Block holds those switched on (/tools).
const CATALOG: ToolDefinition[] = [
  {
    name: 'bash',
    description:
      'Run a shell command in the project root. Returns combined stdout/stderr and the exit code. ' +
      'With background: true it keeps running (e.g. a server): returns its first output, pid and log file after a few seconds.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, background: { type: 'boolean', description: 'keep it running after the call; ends with the session' } },
      required: ['command'],
    },
  },
  {
    name: 'websearch',
    description: 'Search the web (DuckDuckGo). Returns title, URL and abstract of the top results as JSON.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  QUESTION_DEFINITION,
  {
    name: 'skill',
    description:
      'Load a skill into the context by its name. The available skills and what they do are listed in the Skills note; ' +
      "call this with a skill's name to read its full instructions before doing the task it covers. " +
      'Its dependencies load with it.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'the name of the skill to load' } }, required: ['name'] },
  },
  {
    name: 'image',
    description:
      'Look at an image file (png, jpg, jpeg, gif, webp), e.g. a screenshot you took. The image is attached after the ' +
      'results of your tool calls.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'the image file, relative to the project root' } }, required: ['path'] },
  },
];
export const TOOL_NAMES = CATALOG.map(t => t.name);

// Tools Block content, protocol-neutral: name, description, JSON schema of the arguments.
const toolsContent = (tools: ToolDefinition[]) => JSON.stringify(tools, null, 2);
// A new session's Tools Block: every tool; /tools switches one off (websearch needs ddgr, image a vision model).
export const TOOLS = toolsContent(CATALOG);

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

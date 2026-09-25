import type { Block, Context } from '../log/fold';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type ToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: unknown } };
// A chat request as the backend receives it: messages plus the tools field.
export type Request = { messages: Message[]; tools: ToolDefinition[] };

// What goes into the next request: removed blocks are only struck through at the Gate.
export const sentBlocks = (context: Context): Block[] => context.blocks.filter(b => !b.removed);

// Call ids number the calls of one assistant message, as a server numbers those of its answer: the
// answer and its rendering in the next request are the same tokens (prefix cache).
export const callId = (index: number) => `call_${index}`;
export const EMPTY_REQUEST: Request = { messages: [], tools: [] };

// A Tool Call joins the assistant message right before it: its text or earlier calls of the same answer.
function addCall({ messages }: Request, ids: Map<number, string>, b: Block) {
  const last = messages.at(-1);
  const joined = last?.role === 'assistant' ? last : null;
  const earlier = joined?.tool_calls ?? [];
  const call: ToolCall = { id: callId(earlier.length), type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: b.content }) } };
  ids.set(b.id, call.id);
  const message = { role: 'assistant' as const, content: joined?.content ?? '', tool_calls: [...earlier, call] };
  if (joined) messages[messages.length - 1] = message;
  else messages.push(message);
}

type Add = (request: Request, ids: Map<number, string>, b: Block) => void;
const ADD: Record<Block['kind'], Add> = {
  System: (r, _, b) => void r.messages.push({ role: 'system', content: b.content }),
  User: (r, _, b) => void r.messages.push({ role: 'user', content: b.content }),
  Assistant: (r, _, b) => void r.messages.push({ role: 'assistant', content: b.content }),
  Tools: (r, _, b) => void (r.tools = (JSON.parse(b.content) as ToolDefinition['function'][]).map(f => ({ type: 'function', function: f }))),
  'Tool Call': addCall,
  'Tool Result': (r, ids, b) => void r.messages.push({ role: 'tool', tool_call_id: ids.get(b.call!)!, content: b.content }),
};

// Adds one block to the request being rendered; `ids`: call id per Tool Call block so far.
function addBlock(request: Request, ids: Map<number, string>, b: Block) {
  if (b.pin === 'bottom') request.messages.push({ role: 'user', content: b.content });
  else ADD[b.kind](request, ids, b);
}

// Requests for the first 1, 2, … sent blocks: a block owns the tokens its step adds (per-block split).
// The last one is the whole request.
export function renderPrefixes(context: Context): Request[] {
  const request: Request = { messages: [], tools: [] };
  const ids = new Map<number, string>();
  return sentBlocks(context).map(b => {
    addBlock(request, ids, b);
    return { messages: [...request.messages], tools: request.tools };
  });
}

// native Tool Protocol (architecture §4 "Rendering"): Tools Block → tools field; Assistant text and its
// Tool Calls → one assistant message with tool_calls; each Tool Result → a tool message; a bottom pin is
// a user-role Note (FR-10).
export const renderNative = (context: Context): Request => renderPrefixes(context).at(-1) ?? EMPTY_REQUEST;

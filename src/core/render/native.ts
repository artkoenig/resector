import type { Block, Context } from '../log/fold';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type AssistantMessage = { role: 'assistant'; content: string; reasoning_content?: string; tool_calls?: ToolCall[] };
export type Message =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
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

// The message without its Thinking block: what it renders as when the chat template drops it.
export function withoutThinking({ reasoning_content: _, ...message }: AssistantMessage): AssistantMessage {
  return message;
}

// A Tool Call joins the assistant message right before it: its text or earlier calls of the same answer.
function addCall({ messages }: Request, ids: Map<number, string>, b: Block) {
  const last = messages.at(-1);
  const joined = last?.role === 'assistant' ? last : null;
  const earlier = joined?.tool_calls ?? [];
  const call: ToolCall = { id: callId(earlier.length), type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: b.content }) } };
  ids.set(b.id, call.id);
  const message = { ...joined, role: 'assistant' as const, content: joined?.content ?? '', tool_calls: [...earlier, call] };
  if (joined) messages[messages.length - 1] = message;
  else messages.push(message);
}

// Assistant text joins the message of the Thinking block right before it: one answer, one message.
function addText({ messages }: Request, _: Map<number, string>, b: Block) {
  const last = messages.at(-1);
  if (last && 'reasoning_content' in last && !last.content && !last.tool_calls) messages[messages.length - 1] = { ...last, content: b.content };
  else messages.push({ role: 'assistant', content: b.content });
}

type Add = (request: Request, ids: Map<number, string>, b: Block) => void;
const user: Add = (r, _, b) => void r.messages.push({ role: 'user', content: b.content });
const ADD: Record<Block['kind'], Add> = {
  System: (r, _, b) => void r.messages.push({ role: 'system', content: b.content }),
  User: user,
  Note: user,
  // Sent with every request; the chat template decides whether it reaches the model (FR-47, FR-48).
  Thinking: (r, _, b) => void r.messages.push({ role: 'assistant', content: '', reasoning_content: b.content }),
  Assistant: addText,
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

// native Tool Protocol (architecture §4 "Rendering"): Tools Block → tools field; Thinking, Assistant text
// and its Tool Calls → one assistant message with reasoning_content and tool_calls; each Tool Result → a tool message; a Note and a
// bottom pin are user-role messages (FR-9, FR-10).
export const renderNative = (context: Context): Request => renderPrefixes(context).at(-1) ?? EMPTY_REQUEST;

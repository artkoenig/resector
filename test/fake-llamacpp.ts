// Scriptable fake of the llama.cpp server endpoints Resector uses.
// Template: ChatML, tools, tool calls and thinking as Qwen3 renders them: reasoning only after the last
// user message, before it the template drops it. Tokenizer: every special marker, whitespace
// run and word is one token; BOS = 1 token.
import { commonPrefix } from '../src/core/cache/cache';

export type Reply = {
  // Reasoning streamed as reasoning_content before the chunks.
  thinking?: string[];
  // Also sends `reasoning: null` next to reasoning_content, as some servers do.
  reasoningNull?: boolean;
  chunks: string[];
  // Tool calls streamed after the chunks; finish then defaults to tool_calls.
  calls?: { name: string; arguments: string }[];
  finish?: 'stop' | 'length' | 'tool_calls';
  // Keep the stream open after the chunks until the client aborts.
  hang?: boolean;
  // Seconds to wait after the chunks and calls before finishing.
  delay?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
  cacheN?: number;
  // End the stream without finish_reason (dropped connection) or with a mid-stream error event.
  truncate?: boolean;
  error?: string;
};

// template: the Jinja source /props reports as chat_template.
export type FakeOptions = { jinja?: boolean; nCtx?: number; model?: string; slots?: number; template?: string };

export type ChatMessage = { role: string; content: string; reasoning_content?: string; tool_calls?: { function: { name: string; arguments: string } }[] };
export type ChatTool = { type?: string; function: { name: string; [key: string]: unknown } };

// kept: the reasoning is rendered (after the last user message).
const content = (m: ChatMessage, kept = false) =>
  (kept && m.reasoning_content !== undefined ? `<think>\n${m.reasoning_content}\n</think>\n\n` : '') +
  m.content +
  (m.tool_calls ?? []).map(c => `\n<tool_call>\n${JSON.stringify({ name: c.function.name, arguments: JSON.parse(c.function.arguments) })}\n</tool_call>`).join('');
// Tool definitions go at the end of the system message (one is added if there is none).
function withTools(messages: ChatMessage[], tools: ChatTool[] = []): ChatMessage[] {
  if (!tools.length) return messages;
  const list = `\n\n<tools>\n${tools.map(t => JSON.stringify(t)).join('\n')}\n</tools>`;
  const [first, ...rest] = messages;
  return first?.role === 'system' ? [{ ...first, content: first.content + list }, ...rest] : [{ role: 'system', content: list.trim() }, ...messages];
}

// The assistant message a reply renders as.
export const answer = (reply: Reply): ChatMessage => ({
  role: 'assistant',
  content: reply.chunks.join(''),
  ...(reply.thinking && { reasoning_content: reply.thinking.join('') }),
  ...(reply.calls && { tool_calls: reply.calls.map(c => ({ function: c })) }),
});

const lastUser = (messages: ChatMessage[]) => messages.findLastIndex(m => m.role === 'user');

export function chatml(messages: ChatMessage[], addGenerationPrompt: boolean, tools?: ChatTool[]): string {
  const all = withTools(messages, tools);
  const turns = all.map((m, i) => `<|im_start|>${m.role}\n${content(m, i > lastUser(all))}<|im_end|>\n`).join('');
  return turns + (addGenerationPrompt ? '<|im_start|>assistant\n' : '');
}

// Like llama.cpp: a trailing assistant message is a prefill – generation prompt plus its content, no end of turn.
function applyTemplate(messages: ChatMessage[], addGenerationPrompt: boolean, tools?: ChatTool[]): string {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return chatml(messages, addGenerationPrompt, tools);
  return chatml(messages.slice(0, -1), true, tools) + content(last, true);
}

// Same piece, same id: prompts can be compared token by token.
const vocab = new Map<string, number>();
const idOf = (piece: string) => vocab.get(piece) ?? vocab.set(piece, 100 + vocab.size).get(piece)!;

export function tokenize(text: string, addSpecial: boolean): number[] {
  const pieces = text.match(/<\|[a-z_]+\|>|\s+|[^\s<]+|</g) ?? [];
  return [...(addSpecial ? [1] : []), ...pieces.map(idOf)];
}

export function startFakeLlamaCpp({ jinja = true, nCtx = 4096, model = 'qwen3-8b-q4_k_m.gguf', slots = 1, template }: FakeOptions = {}) {
  const replies: Reply[] = [];
  const chatRequests: unknown[] = [];
  const templateRequests: Record<string, unknown>[] = [];
  const error = (message: string) => Response.json({ error: { code: 500, message, type: 'server_error' } }, { status: 500 });
  // One slot's prompt cache: the last prompt and its answer. Unless scripted, cache_n is the common
  // prefix with it, less the last prompt token, which llama.cpp always evaluates.
  let slot: number[] = [];
  const reuse = (prompt: number[]) => Math.min(commonPrefix(prompt, slot), prompt.length - 1);

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: model, object: 'model' }] });
      if (url.pathname === '/props') return Response.json({ default_generation_settings: { n_ctx: nCtx }, total_slots: slots, ...(template !== undefined && { chat_template: template }) });
      const body = (await req.json()) as Record<string, any>;
      if (url.pathname === '/apply-template') {
        templateRequests.push(body);
        if (body.tools && !jinja) return error('tools param requires --jinja flag');
        return Response.json({ prompt: applyTemplate(body.messages, body.add_generation_prompt !== false, body.tools) });
      }
      if (url.pathname === '/tokenize') return Response.json({ tokens: tokenize(body.content, body.add_special === true) });
      if (url.pathname === '/v1/chat/completions') {
        chatRequests.push(body);
        const reply = replies.shift();
        if (!reply) return error('no scripted reply');
        const prompt = tokenize(applyTemplate(body.messages, true, body.tools), true);
        const final = { choices: [], usage: reply.usage ?? null, timings: { cache_n: reply.cacheN ?? reuse(prompt) } };
        slot = [...prompt, ...tokenize(content(answer(reply), true), false)];
        return new Response(stream(reply, req.signal, final), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    reply: (r: Reply) => replies.push(r),
    chatRequests,
    templateRequests,
    stop: () => server.stop(true),
  };
}

// OpenAI-compatible chat stream; `final` is the usage chunk after the finish reason.
export function stream(reply: Reply, signal: AbortSignal, final: unknown): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const data = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
  return new ReadableStream({
    async start(ctrl) {
      for (const reasoning_content of reply.thinking ?? [])
        ctrl.enqueue(data({ choices: [{ index: 0, delta: { reasoning_content, ...(reply.reasoningNull && { reasoning: null }) } }] }));
      for (const content of reply.chunks) ctrl.enqueue(data({ choices: [{ index: 0, delta: { content } }] }));
      // Like llama.cpp: id and name first, then the arguments in two pieces.
      reply.calls?.forEach(({ name, arguments: args }, index) => {
        const half = Math.floor(args.length / 2);
        const delta = (fn: object, id?: string) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...(id && { id, type: 'function' }), function: fn }] } }] });
        ctrl.enqueue(data(delta({ name, arguments: '' }, `srv_${index}`)));
        ctrl.enqueue(data(delta({ arguments: args.slice(0, half) })));
        ctrl.enqueue(data(delta({ arguments: args.slice(half) })));
      });
      if (reply.error) ctrl.enqueue(data({ error: { code: 500, message: reply.error, type: 'server_error' } }));
      if (reply.truncate || reply.error) return ctrl.close();
      if (reply.hang) {
        await new Promise(resolve => signal.addEventListener('abort', resolve));
        return;
      }
      if (reply.delay) await Bun.sleep(reply.delay * 1000);
      ctrl.enqueue(data({ choices: [{ index: 0, delta: {}, finish_reason: reply.finish ?? (reply.calls ? 'tool_calls' : 'stop') }] }));
      ctrl.enqueue(data(final));
      ctrl.enqueue(enc.encode('data: [DONE]'));
      ctrl.close();
    },
  });
}

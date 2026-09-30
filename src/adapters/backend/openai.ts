// HTTP and OpenAI-compatible chat streaming shared by the backends that speak /v1/chat/completions.
import type { ChatOptions, ChatResult } from '../../core/backend';
import type { Thinking } from '../../core/log/events';
import { callId, type Message, type Request } from '../../core/render/native';
import { splitThinking } from '../../core/toolcall/thinking';

// A tool call streams in pieces: name first, arguments appended, both under the call's index.
type CallDelta = { index: number; function?: { name?: string; arguments?: string } };
// Reasoning: reasoning_content (llama.cpp, DeepSeek style) or reasoning (Ollama, LM Studio style).
type Delta = { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: CallDelta[] };
type StreamEvent = {
  choices?: { delta: Delta; finish_reason?: 'stop' | 'length' | 'tool_calls' | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  // llama.cpp reports reused cache in timings, oMLX in usage.prompt_tokens_details.
  timings?: { cache_n: number };
  error?: { message: string };
};

// Attempts of a request the server answers 503.
const RETRIES = 10;

// Requests against one server; failures name the backend (`name`) so the user knows which one broke.
export function httpClient(name: string, endpoint: string) {
  const base = endpoint.replace(/\/$/, '');
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(base + path, init).catch(e => {
        throw init?.signal?.aborted ? e : new Error(`cannot reach ${name} at ${base}`);
      });
      if (res.ok) return res;
      // 503: the server is busy (e.g. its request slots are full) and took nothing on: again after Retry-After.
      if (res.status === 503 && attempt < RETRIES && !init?.signal?.aborted) {
        await res.body?.cancel();
        await Bun.sleep(1000 * Number(res.headers.get('retry-after') ?? 1));
        continue;
      }
      throw new Error(`${name} ${res.status}: ${reason(await res.text())}`);
    }
  };
  const post = async <T>(path: string, body: unknown): Promise<T> =>
    (await request(path, jsonPost(body))).json() as Promise<T>;
  return { request, post };
}

// Servers wrap the reason in JSON ({error: {message}} or FastAPI's {detail}); the user needs only the reason.
function reason(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; detail?: unknown };
    const message = typeof json.error === 'string' ? json.error : (json.error?.message ?? json.detail);
    if (typeof message === 'string') return message;
  } catch {}
  return body.trim();
}

// Without the content type fetch sends text/plain, which FastAPI servers (oMLX) reject.
const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Request fields for the thinking: on/off through the chat template; an effort also as reasoning_effort,
// as a field and for the chat template, since servers pass either one on.
export function thinkingParams(thinking: Thinking | undefined): Record<string, unknown> {
  if (thinking === undefined) return {};
  if (thinking === 'off' || thinking === 'on') return { chat_template_kwargs: { enable_thinking: thinking === 'on' } };
  return { chat_template_kwargs: { enable_thinking: true, reasoning_effort: thinking }, reasoning_effort: thinking };
}

// Request body fields of a Request: the tools field only when there are tools; the answer's start as the last,
// partial assistant message, which the server continues (oMLX reads partial, llama.cpp continues a final assistant message).
export const chatFields = ({ messages, tools, answerStart }: Request) => ({
  messages: answerStart === undefined ? messages : [...messages, { role: 'assistant', content: answerStart, partial: true }],
  ...(tools.length && { tools }),
});

// The answer as an assistant message, as the next request renders it (call ids by position), for the
// cache prediction.
export const answerMessage = ({ thinking, content, calls }: ChatResult): Message => ({
  role: 'assistant',
  content,
  ...(thinking && { reasoning_content: thinking }),
  ...(calls.length && { tool_calls: calls.map((c, i) => ({ id: callId(i), type: 'function' as const, function: c })) }),
});

// `params` (model, sampling) go into every request body next to the messages.
export async function streamChat(
  { name, request }: { name: string; request: ReturnType<typeof httpClient>['request'] },
  params: Record<string, unknown>,
  chat: Request,
  { signal, onDelta, onThinking = () => {}, maxTokens }: ChatOptions,
): Promise<ChatResult> {
  const answer: Answer = { result: { thinking: '', content: '', calls: [], finish: 'aborted', usage: null, cached: null, predicted: null }, fromField: '', text: '', inline: '' };
  const emit = { onDelta, onThinking };
  try {
    const body = { ...params, ...chatFields(chat), ...(maxTokens !== undefined && { max_tokens: maxTokens }), stream: true, stream_options: { include_usage: true } };
    const res = await request('/v1/chat/completions', { ...jsonPost(body), signal });
    let finished = false;
    for await (const event of serverSentEvents(res.body!)) finished = accumulate(name, answer, event, emit) || finished;
    if (!finished) throw new Error(`${name} stream ended without finish_reason`);
  } catch (e) {
    if (!signal.aborted) throw e;
    answer.result.finish = 'aborted';
  }
  return settle(answer);
}

// The answer so far. Reasoning comes as its own delta field (fromField) or inline as <think>…</think> at the
// start of the content (inline); `text`: all content streamed.
type Answer = { result: ChatResult; fromField: string; text: string; inline: string };
type Emit = Pick<ChatOptions, 'onDelta'> & { onThinking: (text: string) => void };

// Streams what is new of the reasoning and the answer text since the last event.
function streamText(answer: Answer, { onDelta, onThinking }: Emit, done = false) {
  const { thinking, content } = splitThinking(answer.text, done);
  const newThinking = thinking.slice(answer.inline.length);
  const newText = content.slice(answer.result.content.length);
  answer.inline = thinking;
  answer.result.content = content;
  if (newThinking) onThinking(newThinking);
  if (newText) onDelta(newText);
}

// The complete answer: text held back as a possible <think> is text after all.
function settle(answer: Answer): ChatResult {
  streamText(answer, { onDelta: () => {}, onThinking: () => {} }, true);
  answer.result.thinking = answer.fromField || answer.inline;
  return answer.result;
}

function addDelta(answer: Answer, { reasoning_content, reasoning: named, content }: Delta, emit: Emit) {
  const reasoning = reasoning_content || named;
  if (reasoning) {
    answer.fromField += reasoning;
    emit.onThinking(reasoning);
  }
  if (content) {
    answer.text += content;
    streamText(answer, emit);
  }
}

// Folds one stream event into the answer; true once it has a finish reason.
function accumulate(name: string, answer: Answer, event: StreamEvent, emit: Emit): boolean {
  if (event.error) throw new Error(`${name} stream: ${event.error.message}`);
  const { result } = answer;
  const choice = event.choices?.[0];
  if (choice) addDelta(answer, choice.delta, emit);
  addCalls(result, choice?.delta.tool_calls ?? []);
  const { usage, timings } = event;
  if (usage) result.usage = { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens };
  const cached = timings?.cache_n ?? usage?.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) result.cached = cached;
  if (!choice?.finish_reason) return false;
  result.finish = choice.finish_reason;
  return true;
}

function addCalls(result: ChatResult, deltas: CallDelta[]) {
  for (const { index, function: fn } of deltas) {
    const call = (result.calls[index] ??= { name: '', arguments: '' });
    call.name += fn?.name ?? '';
    call.arguments += fn?.arguments ?? '';
  }
}

async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body) {
    const lines = (buffer + decoder.decode(bytes, { stream: true })).split('\n');
    buffer = lines.pop()!;
    yield* parse(lines);
  }
  yield* parse([buffer + decoder.decode()]);
}

function* parse(lines: string[]): Generator<StreamEvent> {
  for (const line of lines) {
    const data = line.startsWith('data: ') ? line.slice(6) : null;
    if (data && data !== '[DONE]') yield JSON.parse(data);
  }
}

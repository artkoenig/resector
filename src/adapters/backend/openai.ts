// HTTP and OpenAI-compatible chat streaming shared by the backends that speak /v1/chat/completions.
import type { ChatOptions, ChatResult } from '../../core/backend';
import { callId, type Message, type Request } from '../../core/render/native';

// A tool call streams in pieces: name first, arguments appended, both under the call's index.
type CallDelta = { index: number; function?: { name?: string; arguments?: string } };
type StreamEvent = {
  choices?: { delta: { content?: string | null; tool_calls?: CallDelta[] }; finish_reason?: 'stop' | 'length' | 'tool_calls' | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  // llama.cpp reports reused cache in timings, oMLX in usage.prompt_tokens_details.
  timings?: { cache_n: number };
  error?: { message: string };
};

// Requests against one server; failures name the backend (`name`) so the user knows which one broke.
export function httpClient(name: string, endpoint: string) {
  const base = endpoint.replace(/\/$/, '');
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const res = await fetch(base + path, init).catch(e => {
      throw init?.signal?.aborted ? e : new Error(`cannot reach ${name} at ${base}`);
    });
    if (!res.ok) throw new Error(`${name} ${path}: ${res.status} ${await res.text()}`);
    return res;
  };
  const post = async <T>(path: string, body: unknown): Promise<T> =>
    (await request(path, jsonPost(body))).json() as Promise<T>;
  return { request, post };
}

// Without the content type fetch sends text/plain, which FastAPI servers (oMLX) reject.
const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Request body fields of a Request: the tools field only when there are tools.
export const chatFields = ({ messages, tools }: Request) => ({ messages, ...(tools.length && { tools }) });

// The answer as an assistant message, as the next request renders it (call ids by position), for the
// cache prediction.
export const answerMessage = ({ content, calls }: ChatResult): Message => ({
  role: 'assistant',
  content,
  ...(calls.length && { tool_calls: calls.map((c, i) => ({ id: callId(i), type: 'function' as const, function: c })) }),
});

// `params` (model, sampling) go into every request body next to the messages.
export async function streamChat(
  { name, request }: { name: string; request: ReturnType<typeof httpClient>['request'] },
  params: Record<string, unknown>,
  chat: Request,
  { signal, onDelta }: ChatOptions,
): Promise<ChatResult> {
  const result: ChatResult = { content: '', calls: [], finish: 'aborted', usage: null, cached: null, predicted: null };
  try {
    const body = { ...params, ...chatFields(chat), stream: true, stream_options: { include_usage: true } };
    const res = await request('/v1/chat/completions', { ...jsonPost(body), signal });
    let finished = false;
    for await (const event of serverSentEvents(res.body!)) finished = accumulate(name, result, event, onDelta) || finished;
    if (!finished) throw new Error(`${name} stream ended without finish_reason`);
  } catch (e) {
    if (!signal.aborted) throw e;
    result.finish = 'aborted';
  }
  return result;
}

// Folds one stream event into the result; true once the answer has a finish reason.
function accumulate(name: string, result: ChatResult, event: StreamEvent, onDelta: (text: string) => void): boolean {
  if (event.error) throw new Error(`${name} stream: ${event.error.message}`);
  const choice = event.choices?.[0];
  const text = choice?.delta.content;
  if (text) {
    result.content += text;
    onDelta(text);
  }
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

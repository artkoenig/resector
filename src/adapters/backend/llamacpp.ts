// llama.cpp server backend: exact token counts via /apply-template + /tokenize (requires --jinja).
import type { Backend, ChatResult } from '../../core/backend';
import type { Usage } from '../../core/log/events';
import type { Message } from '../../core/render/native';
import { splitTokens } from '../../core/tokens/split';

type StreamEvent = {
  choices?: { delta: { content?: string }; finish_reason?: 'stop' | 'length' | null }[];
  usage?: Usage | null;
  timings?: { cache_n: number };
  error?: { message: string };
};

// Tools force the Jinja template path; without --jinja llama.cpp rejects them.
const PROBE_TOOLS = [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }];
// Appended to every counted prefix so it never ends with an Assistant message, which llama.cpp would
// render as a prefill (no end of turn). Its constant tokens cancel out in the prefix differences.
const TRAILER: Message = { role: 'user', content: '' };

// Model Profile values that shape requests; the window defaults to the server's per-slot context.
export type LlamaCppOptions = { window?: number; model?: string; sampling?: Record<string, number> };

export async function connectLlamaCpp(endpoint: string, { window, model, sampling }: LlamaCppOptions = {}): Promise<Backend> {
  const base = endpoint.replace(/\/$/, '');
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const res = await fetch(base + path, init).catch(e => {
      throw init?.signal?.aborted ? e : new Error(`cannot reach llama.cpp at ${base}`);
    });
    if (!res.ok) throw new Error(`llama.cpp ${path}: ${res.status} ${await res.text()}`);
    return res;
  };
  const post = async <T>(path: string, body: unknown): Promise<T> =>
    (await request(path, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<T>;

  const props = (await (await request('/props')).json()) as { default_generation_settings: { n_ctx: number } };
  await post('/apply-template', { messages: [{ role: 'user', content: 'probe' }], tools: PROBE_TOOLS }).catch(e => {
    throw String(e).includes('--jinja') ? new Error('llama.cpp runs without --jinja: restart llama-server with --jinja') : e;
  });

  // Tokens as the server counts a request prompt: special tokens (BOS) added.
  const tokens = async (content: string): Promise<number> =>
    (await post<{ tokens: unknown[] }>('/tokenize', { content, add_special: true })).tokens.length;
  const template = async (messages: Message[], add_generation_prompt: boolean): Promise<string> =>
    (await post<{ prompt: string }>('/apply-template', { messages, add_generation_prompt })).prompt;
  const prefix = async (messages: Message[]) => tokens(await template([...messages, TRAILER], false));
  // A Context ending in an Assistant block is not sendable; its Template row is BOS + generation prompt.
  const requestSize = async (messages: Message[], blocks: number) => {
    if (messages.at(-1)?.role !== 'assistant') return tokens(await template(messages, true));
    const generationPrompt = (await tokens(await template([TRAILER], true))) - (await tokens(await template([TRAILER], false)));
    return blocks + (await tokens('')) + generationPrompt;
  };

  return {
    window: window ?? props.default_generation_settings.n_ctx,

    async count(messages) {
      const prefixes = await Promise.all(messages.map((_, i) => prefix(messages.slice(0, i + 1))));
      const empty = await prefix([]);
      const total = await requestSize(messages, (prefixes.at(-1) ?? empty) - empty);
      return splitTokens({ empty, prefixes, total });
    },

    async chat(messages, { signal, onDelta }) {
      const result: ChatResult = { content: '', finish: 'aborted', usage: null, cached: null };
      try {
        const body = JSON.stringify({ model, ...sampling, messages, stream: true, stream_options: { include_usage: true } });
        const res = await request('/v1/chat/completions', { method: 'POST', body, signal });
        let finished = false;
        for await (const event of serverSentEvents(res.body!)) finished = accumulate(result, event, onDelta) || finished;
        if (!finished) throw new Error('llama.cpp stream ended without finish_reason');
      } catch (e) {
        if (!signal.aborted) throw e;
        result.finish = 'aborted';
      }
      return result;
    },
  };
}

// Folds one stream event into the result; true once the answer has a finish reason.
function accumulate(result: ChatResult, event: StreamEvent, onDelta: (text: string) => void): boolean {
  if (event.error) throw new Error(`llama.cpp stream: ${event.error.message}`);
  const choice = event.choices?.[0];
  const text = choice?.delta.content;
  if (text) {
    result.content += text;
    onDelta(text);
  }
  if (event.usage) result.usage = event.usage;
  if (event.timings) result.cached = event.timings.cache_n;
  if (!choice?.finish_reason) return false;
  result.finish = choice.finish_reason;
  return true;
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

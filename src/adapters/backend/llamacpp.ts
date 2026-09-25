// llama.cpp server backend: exact token counts via /apply-template + /tokenize (requires --jinja).
import type { Backend } from '../../core/backend';
import type { Message } from '../../core/render/native';
import { splitTokens } from '../../core/tokens/split';
import { httpClient, streamChat } from './openai';

// Tools force the Jinja template path; without --jinja llama.cpp rejects them.
const PROBE_TOOLS = [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }];
// Appended to every counted prefix so it never ends with an Assistant message, which llama.cpp would
// render as a prefill (no end of turn). Its constant tokens cancel out in the prefix differences.
const TRAILER: Message = { role: 'user', content: '' };

// Model Profile values that shape requests; the window defaults to the server's per-slot context.
export type LlamaCppOptions = { window?: number; model?: string; sampling?: Record<string, number> };

export async function connectLlamaCpp(endpoint: string, { window, model, sampling }: LlamaCppOptions = {}): Promise<Backend> {
  const { request, post } = httpClient('llama.cpp', endpoint);

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

    chat: (messages, options) => streamChat({ name: 'llama.cpp', request }, { model, ...sampling }, messages, options),
  };
}

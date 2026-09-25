// llama.cpp server backend: exact token counts via /apply-template + /tokenize (requires --jinja).
import type { Backend } from '../../core/backend';
import { commonPrefix } from '../../core/cache/cache';
import type { Message } from '../../core/render/native';
import { splitTokens } from '../../core/tokens/split';
import { httpClient, streamChat } from './openai';

// Tools force the Jinja template path; without --jinja llama.cpp rejects them.
const PROBE_TOOLS = [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }];
// Appended to every counted prefix so it never ends with an Assistant message, which llama.cpp would
// render as a prefill (no end of turn). Its constant tokens cancel out in the prefix differences.
const TRAILER: Message = { role: 'user', content: '' };

// Model Profile values that shape requests; the window defaults to the server's per-slot context.
// session: pins one slot per session, so its prefix cache is not evicted by other sessions.
export type LlamaCppOptions = { window?: number; model?: string; sampling?: Record<string, number>; session?: string };

type Props = { default_generation_settings: { n_ctx: number }; total_slots: number };

export async function connectLlamaCpp(endpoint: string, { window, model, sampling, session }: LlamaCppOptions = {}): Promise<Backend> {
  const { request, post } = httpClient('llama.cpp', endpoint);

  const props = (await (await request('/props')).json()) as Props;
  await post('/apply-template', { messages: [{ role: 'user', content: 'probe' }], tools: PROBE_TOOLS }).catch(e => {
    throw String(e).includes('--jinja') ? new Error('llama.cpp runs without --jinja: restart llama-server with --jinja') : e;
  });

  // Token ids as the server sees a request prompt: special tokens (BOS) added.
  const ids = async (content: string, add_special = true): Promise<number[]> =>
    (await post<{ tokens: number[] }>('/tokenize', { content, add_special })).tokens;
  const tokens = async (content: string): Promise<number> => (await ids(content)).length;
  const template = async (messages: Message[], add_generation_prompt: boolean): Promise<string> =>
    (await post<{ prompt: string }>('/apply-template', { messages, add_generation_prompt })).prompt;
  const prefix = async (messages: Message[]) => tokens(await template([...messages, TRAILER], false));
  // A Context ending in an Assistant block is not sendable; its Template row is BOS + generation prompt.
  const requestSize = async (messages: Message[], blocks: number) => {
    if (messages.at(-1)?.role !== 'assistant') return tokens(await template(messages, true));
    const generationPrompt = (await tokens(await template([TRAILER], true))) - (await tokens(await template([TRAILER], false)));
    return blocks + (await tokens('')) + generationPrompt;
  };
  // Token ids of the messages up to the end of the last one's turn: the counted prefix without its
  // trailer (empty prefix − BOS). This is how the next request renders them.
  const closed = async (messages: Message[]) => {
    const [all, empty, bos] = await Promise.all([template([...messages, TRAILER], false).then(t => ids(t)), prefix([]), tokens('')]);
    return all.slice(0, all.length - (empty - bos));
  };

  // The session slot's prefix cache (architecture §4), empty (cold) per connection: `slotTokens` as the
  // server holds them (prompt + generated answer); `shownTokens` adds the answer's end of turn, so the
  // Assistant row counts as cached.
  let slotTokens: number[] = [];
  let shownTokens: number[] = [];
  const slot = session === undefined ? {} : { id_slot: Number(BigInt(Bun.hash(session)) % BigInt(props.total_slots)) };

  return {
    window: window ?? props.default_generation_settings.n_ctx,

    async count(messages) {
      const prefixes = await Promise.all(messages.map((_, i) => prefix(messages.slice(0, i + 1))));
      const [empty, bos, rendered] = await Promise.all([prefix([]), tokens(''), closed(messages)]);
      const total = await requestSize(messages, (prefixes.at(-1) ?? empty) - empty);
      // Cached tokens of the rows: BOS precedes the first row.
      const cached = Math.max(0, commonPrefix(shownTokens, rendered) - bos);
      return { ...splitTokens({ empty, prefixes, total }), cached: { tokens: cached, exact: true } };
    },

    // llama.cpp always evaluates at least the last prompt token; --cache-reuse is off per request.
    async chat(messages, options) {
      const sent = await ids(await template(messages, true));
      const predicted = Math.min(commonPrefix(slotTokens, sent), sent.length - 1);
      const result = await streamChat({ name: 'llama.cpp', request }, { model, ...slot, ...sampling, n_cache_reuse: 0 }, messages, options);
      slotTokens = [...sent, ...(await ids(result.content, false))];
      shownTokens = await closed([...messages, { role: 'assistant', content: result.content }]);
      return { ...result, predicted };
    },
  };
}

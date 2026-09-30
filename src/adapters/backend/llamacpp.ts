// llama.cpp server backend: exact token counts via /apply-template + /tokenize (requires --jinja).
import type { Backend } from '../../core/backend';
import { commonPrefix } from '../../core/cache/cache';
import type { Thinking } from '../../core/log/events';
import { EMPTY_REQUEST as EMPTY, withoutThinking, type AssistantMessage, type Message, type Request } from '../../core/render/native';
import { thinkingModes } from '../../core/render/template';
import { thinkingShares } from '../../core/tokens/thinking';
import { splitTokens } from '../../core/tokens/split';
import { answerMessage, chatFields, httpClient, streamChat, thinkingParams } from './openai';

// Tools force the Jinja template path; without --jinja llama.cpp rejects them.
const PROBE_TOOLS = [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }];
// Appended to every counted prefix so it never ends with an Assistant message, which llama.cpp would
// render as a prefill (no end of turn). Its constant tokens cancel out in the prefix differences.
const TRAILER: Message = { role: 'user', content: '' };

// Model Profile values that shape requests; the window defaults to the server's per-slot context.
// session: pins one slot per session, so its prefix cache is not evicted by other sessions; thinking:
// unless a request sets its own.
export type LlamaCppOptions = { window?: number; model?: string; sampling?: Record<string, number>; thinking?: Thinking; session?: string };

type Props = { default_generation_settings: { n_ctx: number }; total_slots: number; chat_template?: string };

export async function connectLlamaCpp(endpoint: string, { window, model, sampling, thinking, session }: LlamaCppOptions = {}): Promise<Backend> {
  const { request, post } = httpClient('llama.cpp', endpoint);
  // The chat template renders with the thinking the request is sent with.
  const thinkingFields = (request: Request) => thinkingParams(request.thinking ?? thinking);
  // The empty request rendered with the thinking of `request`.
  const emptyOf = (request: Request): Request => ({ ...EMPTY, ...(request.thinking && { thinking: request.thinking }) });

  const props = (await (await request('/props')).json()) as Props;
  await post('/apply-template', { messages: [{ role: 'user', content: 'probe' }], tools: PROBE_TOOLS }).catch(e => {
    throw String(e).includes('--jinja') ? new Error('llama.cpp runs without --jinja: restart llama-server with --jinja') : e;
  });

  // Token ids as the server sees a request prompt: special tokens (BOS) added.
  const ids = async (content: string, add_special = true): Promise<number[]> =>
    (await post<{ tokens: number[] }>('/tokenize', { content, add_special })).tokens;
  const tokens = async (content: string): Promise<number> => (await ids(content)).length;
  const template = async (request: Request, add_generation_prompt: boolean): Promise<string> =>
    (await post<{ prompt: string }>('/apply-template', { ...chatFields(request), ...thinkingFields(request), add_generation_prompt })).prompt;
  const trailed = (request: Request): Request => ({ ...request, messages: [...request.messages, TRAILER] });
  const prefix = async (request: Request) => tokens(await template(trailed(request), false));
  // A Context ending in an Assistant block is not sendable; its Template row is BOS + generation prompt.
  const requestSize = async (request: Request, blocks: number) => {
    if (request.messages.at(-1)?.role !== 'assistant') return tokens(await template(request, true));
    const empty = trailed(emptyOf(request));
    const generationPrompt = (await tokens(await template(empty, true))) - (await tokens(await template(empty, false)));
    return blocks + (await tokens('')) + generationPrompt;
  };
  // Token ids of the messages up to the end of the last one's turn: the counted prefix without its
  // trailer (empty prefix − BOS). This is how the next request renders them.
  const closed = async (request: Request) => {
    const [all, empty, bos] = await Promise.all([template(trailed(request), false).then(t => ids(t)), prefix(emptyOf(request)), tokens('')]);
    return all.slice(0, all.length - (empty - bos));
  };
  // Token ids of a request as sent; one ending in an answer is not sendable, as the next request renders it.
  const rendered = async (request: Request) =>
    request.messages.at(-1)?.role === 'assistant' ? closed(request) : ids(await template(request, true));
  // A trailing answer renders as prefill: generation prompt and the answer, reasoning included.
  const prefill = async (request: Request) => ids(await template(request, false));
  // What the slot holds after an answer (`exchange` ends with it), as a following tool loop renders it:
  // reasoning included, which the counted prefix may drop; plus its end of turn where it can be told apart.
  const held = async (exchange: Request): Promise<number[]> => {
    const answer = exchange.messages.at(-1) as AssistantMessage;
    if (answer.reasoning_content === undefined) return closed(exchange);
    const plain = { ...exchange, messages: [...exchange.messages.slice(0, -1), withoutThinking(answer)] };
    const [closedTurn, withThinking, withoutIt] = await Promise.all([closed(exchange), prefill(exchange), prefill(plain)]);
    const endOfTurn = commonPrefix(withoutIt, closedTurn) === withoutIt.length ? closedTurn.slice(withoutIt.length) : [];
    return [...withThinking, ...endOfTurn];
  };

  // The session slot's prefix cache, empty (cold) per connection: `slotTokens` as the
  // server holds them (prompt + generated answer); `shownTokens` adds the answer's end of turn, so the
  // Assistant row counts as cached.
  let slotTokens: number[] = [];
  let shownTokens: number[] = [];
  const slot = session === undefined ? {} : { id_slot: Number(BigInt(Bun.hash(session)) % BigInt(props.total_slots)) };

  return {
    window: window ?? props.default_generation_settings.n_ctx,
    thinking,
    thinkingModes: props.chat_template ? thinkingModes(props.chat_template) : null,
    exact: true,

    async count(requests) {
      const request = requests.at(-1) ?? EMPTY;
      const prefixes = await Promise.all(requests.map(prefix));
      const [empty, bos, sent] = await Promise.all([prefix(emptyOf(request)), tokens(''), rendered(request)]);
      const total = await requestSize(request, (prefixes.at(-1) ?? empty) - empty);
      const sendable = request.messages.at(-1)?.role !== 'assistant';
      const shares = await thinkingShares(requests, prefixes, total, { prefix, request: sendable ? r => requestSize(r, 0) : null });
      // Cached tokens of the rows: BOS precedes the first row.
      const cached = Math.max(0, commonPrefix(shownTokens, sent) - bos);
      return { ...splitTokens({ empty, prefixes, total, thinking: shares }), cached: { tokens: cached, exact: true } };
    },

    // llama.cpp always evaluates at least the last prompt token; --cache-reuse is off per request.
    async chat(chat, options) {
      const sent = await ids(await template(chat, true));
      const predicted = Math.min(commonPrefix(slotTokens, sent), sent.length - 1);
      const result = await streamChat({ name: 'llama.cpp', request }, { model, ...slot, ...sampling, ...thinkingFields(chat), n_cache_reuse: 0 }, chat, options);
      const exchange = { ...chat, messages: [...chat.messages, answerMessage(result)] };
      // Generated tool call syntax is template-specific and not in the slot prediction: it only errs low.
      slotTokens = result.thinking ? await prefill(exchange) : [...sent, ...(await ids(result.content, false))];
      shownTokens = await held(exchange);
      return { ...result, predicted };
    },
  };
}

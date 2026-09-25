// oMLX server backend (MLX on Apple Silicon): exact token counts via the Anthropic-format
// /v1/messages/count_tokens, which applies the model's chat template with the generation prompt.
import type { Backend, CacheHit } from '../../core/backend';
import { commonPrefix } from '../../core/cache/cache';
import type { Message } from '../../core/render/native';
import { splitTokens } from '../../core/tokens/split';
import { httpClient, streamChat } from './openai';

const TRAILER: Message = { role: 'user', content: '' };

type ModelList = { data: { id: string; max_model_len?: number | null }[] };

// Model Profile values that shape requests; the window defaults to the model's max_model_len.
export type OmlxOptions = { window?: number; model?: string; sampling?: Record<string, number> };

export async function connectOmlx(endpoint: string, { window, model, sampling }: OmlxOptions): Promise<Backend> {
  if (model === undefined) throw new Error('oMLX Model Profile needs a model');
  const { request, post } = httpClient('oMLX', endpoint);

  const { data } = (await (await request('/v1/models')).json()) as ModelList;
  const served = data.find(m => m.id === model);
  if (!served) throw new Error(`oMLX does not serve model "${model}" (models: ${data.map(m => m.id).join(', ')})`);
  const size = window ?? served.max_model_len;
  if (!size) throw new Error(`oMLX reports no max_model_len for ${model}: set window in the Model Profile`);

  // Every count includes the generation prompt. Counted prefixes end in an empty user turn, since
  // some templates (Qwen3-2507) cannot render a prompt without user message and oMLX then silently
  // counts a plain concatenation; both cancel out in the prefix differences and land in the Template
  // row. Tool definitions are not sent yet, so their overhead is not counted.
  const tokens = async (messages: Message[]): Promise<number> => {
    const [first, ...rest] = messages;
    const body = first?.role === 'system' ? { model, system: first.content, messages: rest } : { model, messages };
    return (await post<{ input_tokens: number }>('/v1/messages/count_tokens', body)).input_tokens;
  };

  // Prefix cache (architecture §4): oMLX predicts its hits itself with the admin cache probe, in whole
  // cache blocks. The probe sees a request's blocks only a moment after its answer, so the unchanged
  // messages of the last request count too, rounded down to whole blocks. Where the probe is not
  // available (e.g. admin API key), messages equal to the last request and its answer count as
  // cached – approximate, as oMLX caches whole blocks only.
  let probing = true;
  const probe = async (messages: Message[]) => {
    if (!probing) return null;
    return post<{ ssd_hit_tokens: number; block_size: number }>('/admin/api/cache/probe', { model_id: model, messages }).catch(e => {
      // Missing or locked (admin API key): not available for this connection; anything else: this count only.
      probing = !/: 40[134] /.test(String(e));
      return null;
    });
  };
  let lastRequest: Message[] = [];
  let lastExchange: Message[] = [];
  // Tokens of the leading messages equal to `history`.
  const unchanged = (history: Message[], messages: Message[], blocks: number[]) =>
    blocks.slice(0, commonPrefix(history, messages, (a, b) => a.role === b.role && a.content === b.content)).reduce((sum, n) => sum + n, 0);
  const predict = async (messages: Message[], blocks: number[]): Promise<CacheHit> => {
    const hit = await probe(messages);
    if (!hit) return { tokens: unchanged(lastExchange, messages, blocks), exact: false };
    const recent = unchanged(lastRequest, messages, blocks);
    return { tokens: Math.max(hit.ssd_hit_tokens, recent - (recent % hit.block_size)), exact: true };
  };
  // The prediction of the last count: the Gate counts a request right before sending it.
  let last: { key: string; cached: CacheHit } | null = null;

  return {
    window: size,

    async count(messages) {
      const prefix = (n: number) => tokens([...messages.slice(0, n), TRAILER]);
      const [empty, ...prefixes] = await Promise.all(Array.from({ length: messages.length + 1 }, (_, n) => prefix(n)));
      // Without user message the smallest renderable request is the one with the empty user turn.
      const total = messages.some(m => m.role === 'user') ? await tokens(messages) : (prefixes.at(-1) ?? empty!);
      const split = splitTokens({ empty: empty!, prefixes, total });
      last = { key: JSON.stringify(messages), cached: await predict(messages, split.blocks) };
      return { ...split, cached: last.cached };
    },

    async chat(messages, options) {
      const predicted = last?.key === JSON.stringify(messages) && last.cached.exact ? last.cached.tokens : null;
      const result = await streamChat({ name: 'oMLX', request }, { model, ...sampling }, messages, options);
      lastRequest = messages;
      lastExchange = [...messages, { role: 'assistant', content: result.content }];
      return { ...result, predicted };
    },
  };
}

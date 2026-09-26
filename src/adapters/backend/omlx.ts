// oMLX server backend (MLX on Apple Silicon): exact token counts via the Anthropic-format
// /v1/messages/count_tokens, which applies the model's chat template with the generation prompt.
import { join } from 'node:path';
import type { Backend, CacheHit } from '../../core/backend';
import { commonPrefix } from '../../core/cache/cache';
import type { Thinking } from '../../core/log/events';
import { EMPTY_REQUEST as EMPTY, type AssistantMessage, type Message, type Request } from '../../core/render/native';
import { thinkingModes } from '../../core/render/template';
import { thinkingShares } from '../../core/tokens/thinking';
import { splitTokens } from '../../core/tokens/split';
import { answerMessage, httpClient, streamChat, thinkingParams } from './openai';

const TRAILER: Message = { role: 'user', content: '' };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// An assistant message that `whole` continues with its text or further tool calls of the same answer.
const begins = (part: Message, whole: Message | undefined) =>
  part.role === 'assistant' && whole?.role === 'assistant' && part.reasoning_content === whole.reasoning_content &&
  (part.content === whole.content || (!part.content && !part.tool_calls)) &&
  (part.tool_calls ?? []).every((c, i) => same(c, whole.tool_calls?.[i]));
// Whether `history` renders like `prefix` up to its end: same messages (the last one may go on), same
// tools once it has any.
const within = (history: Request, prefix: Request) =>
  (!prefix.tools.length || same(prefix.tools, history.tools)) &&
  prefix.messages.every((m, i) => same(m, history.messages[i]) || (i === prefix.messages.length - 1 && begins(m, history.messages[i])));

// count_tokens takes the Anthropic Messages format: System → `system`, tool calls → tool_use blocks,
// tool messages → tool_result blocks of one user message, tools with `input_schema`. Reasoning goes
// inline as <think>, which chat templates take apart like reasoning_content.
type AnthropicMessage = { role: string; content: unknown };

// Appends one chat message in the Anthropic format; consecutive tool results share one user message.
function addAnthropic(converted: AnthropicMessage[], m: Message) {
  if (m.role === 'tool') {
    const result = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
    const previous = converted.at(-1);
    if (previous?.role === 'user' && Array.isArray(previous.content)) previous.content.push(result);
    else converted.push({ role: 'user', content: [result] });
  } else converted.push(m.role === 'assistant' ? assistantAnthropic(m) : { role: m.role, content: m.content });
}

function assistantAnthropic(m: AssistantMessage): AnthropicMessage {
  const text = (m.reasoning_content === undefined ? '' : `<think>\n${m.reasoning_content}\n</think>\n\n`) + m.content;
  if (!m.tool_calls) return { role: 'assistant', content: text };
  const uses = m.tool_calls.map(c => ({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) }));
  return { role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), ...uses] };
}

function anthropic({ messages, tools }: Request) {
  const [first, ...rest] = messages;
  const system = first?.role === 'system';
  const converted: AnthropicMessage[] = [];
  for (const m of system ? rest : messages) addAnthropic(converted, m);
  return {
    ...(system && { system: first.content }),
    messages: converted,
    ...(tools.length && { tools: tools.map(({ function: f }) => ({ name: f.name, description: f.description, input_schema: f.parameters })) }),
  };
}

type ModelList = { data: { id: string; max_model_len?: number | null }[] };
type AdminModels = { models: { id: string; model_path?: string }[] };

// The model's chat template from its directory, which the admin API names: chat_template.jinja, else the
// tokenizer config's (a string, or named templates). null where the admin API is locked or the files are elsewhere.
async function chatTemplate(request: (path: string) => Promise<Response>, model: string): Promise<string | null> {
  try {
    const { models } = (await (await request('/admin/api/models')).json()) as AdminModels;
    const dir = models.find(m => m.id === model)?.model_path;
    if (!dir) return null;
    const jinja = Bun.file(join(dir, 'chat_template.jinja'));
    if (await jinja.exists()) return await jinja.text();
    const { chat_template } = (await Bun.file(join(dir, 'tokenizer_config.json')).json()) as { chat_template?: string | { name: string; template: string }[] };
    return typeof chat_template === 'string' ? chat_template : (chat_template?.find(t => t.name === 'default')?.template ?? null);
  } catch {
    return null;
  }
}

// Model Profile values that shape requests; the window defaults to the model's max_model_len; thinking:
// unless a request sets its own.
export type OmlxOptions = { window?: number; model?: string; sampling?: Record<string, number>; thinking?: Thinking };

export async function connectOmlx(endpoint: string, { window, model, sampling, thinking }: OmlxOptions): Promise<Backend> {
  if (model === undefined) throw new Error('oMLX Model Profile needs a model');
  const { request, post } = httpClient('oMLX', endpoint);

  const { data } = (await (await request('/v1/models')).json()) as ModelList;
  const served = data.find(m => m.id === model);
  if (!served) throw new Error(`oMLX does not serve model "${model}" (models: ${data.map(m => m.id).join(', ')})`);
  const size = window ?? served.max_model_len;
  if (!size) throw new Error(`oMLX reports no max_model_len for ${model}: set window in the Model Profile`);
  const template = await chatTemplate(request, model);

  // Every count includes the generation prompt. Counted prefixes end in an empty user turn, since
  // some templates (Qwen3-2507) cannot render a prompt without user message and oMLX then silently
  // counts a plain concatenation; both cancel out in the prefix differences and land in the Template
  // row.
  const tokens = async (request: Request): Promise<number> =>
    (await post<{ input_tokens: number }>('/v1/messages/count_tokens', { model, ...anthropic(request) })).input_tokens;

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
  let lastRequest: Request = EMPTY;
  let lastExchange: Request = EMPTY;
  // Tokens of the leading blocks whose rendering `history` already starts with.
  const unchanged = (history: Request, prefixes: Request[], blocks: number[]) => {
    const changed = prefixes.findIndex(p => !within(history, p));
    return blocks.slice(0, changed < 0 ? blocks.length : changed).reduce((sum, n) => sum + n, 0);
  };
  const predict = async (prefixes: Request[], blocks: number[]): Promise<CacheHit> => {
    const hit = await probe((prefixes.at(-1) ?? EMPTY).messages);
    if (!hit) return { tokens: unchanged(lastExchange, prefixes, blocks), exact: false };
    const recent = unchanged(lastRequest, prefixes, blocks);
    return { tokens: Math.max(hit.ssd_hit_tokens, recent - (recent % hit.block_size)), exact: true };
  };
  // The prediction of the last count: the Gate counts a request right before sending it.
  let last: { key: string; cached: CacheHit } | null = null;

  return {
    window: size,
    thinking,
    thinkingModes: template === null ? null : thinkingModes(template),
    exact: true,

    async count(requests) {
      const whole = requests.at(-1) ?? EMPTY;
      const prefix = (r: Request) => tokens({ ...r, messages: [...r.messages, TRAILER] });
      const [empty, ...prefixes] = await Promise.all([EMPTY, ...requests].map(prefix));
      // Without user message the smallest renderable request is the one with the empty user turn.
      const sendable = whole.messages.some(m => m.role === 'user') && whole.messages.at(-1)?.role !== 'assistant';
      const total = whole.messages.some(m => m.role === 'user') ? await tokens(whole) : (prefixes.at(-1) ?? empty!);
      const shares = await thinkingShares(requests, prefixes, total, { prefix, request: sendable ? tokens : null });
      const split = splitTokens({ empty: empty!, prefixes, total, thinking: shares });
      last = { key: JSON.stringify(whole), cached: await predict(requests, split.blocks) };
      return { ...split, cached: last.cached };
    },

    async chat(chat, options) {
      const predicted = last?.key === JSON.stringify(chat) && last.cached.exact ? last.cached.tokens : null;
      const result = await streamChat({ name: 'oMLX', request }, { model, ...sampling, ...thinkingParams(chat.thinking ?? thinking) }, chat, options);
      lastRequest = chat;
      lastExchange = { ...chat, messages: [...chat.messages, answerMessage(result)] };
      return { ...result, predicted };
    },
  };
}

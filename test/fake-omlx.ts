// Scriptable fake of the oMLX server endpoints Resector uses (issue #20). Same ChatML template and
// tokenizer as the llama.cpp fake; count_tokens always adds the generation prompt, as oMLX does.
// Like FastAPI, bodies without a JSON content type are rejected. Like Qwen3-2507 templates, a prompt
// without user message fails to render, and oMLX then silently counts a plain concatenation.
import { commonPrefix } from '../src/core/cache/cache';
import { chatml, stream, tokenize, type Reply } from './fake-llamacpp';

export type FakeModel = { id: string; maxModelLen?: number };
// probe: whether the admin cache probe answers; lagging: it does not see the last request yet (blocks
// are written to the SSD cache after the answer); blockSize: cache block size in fake tokens.
export type FakeOmlxOptions = { models?: FakeModel[]; probe?: boolean; lagging?: boolean; blockSize?: number };

type AnthropicCount = { model: string; system?: string; messages: { role: string; content: string }[] };

export function startFakeOmlx({ models = [{ id: 'Qwen3-8B-4bit', maxModelLen: 57344 }], probe = true, lagging = false, blockSize = 4 }: FakeOmlxOptions = {}) {
  const replies: Reply[] = [];
  // Paged prefix cache: the last chat prompt and its answer, hit in whole blocks.
  let cache: number[] = [];
  let written: number[] = [];
  const hit = (messages: { role: string; content: string }[]) => {
    const prompt = tokenize(chatml(messages, true), true);
    const same = commonPrefix(prompt, lagging ? written : cache);
    return same - (same % blockSize);
  };
  const chatRequests: unknown[] = [];
  const countRequests: AnthropicCount[] = [];
  const error = (status: number, message: string) => Response.json({ error: { message, type: 'server_error' } }, { status });
  const known = (model: string) => models.some(m => m.id === model);

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models')
        return Response.json({
          object: 'list',
          data: models.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: 'omlx', max_model_len: m.maxModelLen ?? null })),
        });
      if (req.method !== 'POST') return new Response('not found', { status: 404 });
      if (req.headers.get('content-type') !== 'application/json') return error(422, 'body is not JSON');
      const body = (await req.json()) as Record<string, any>;
      if (url.pathname === '/admin/api/cache/probe') {
        if (!probe) return error(401, 'API key required');
        return Response.json({ model_id: body.model_id, block_size: blockSize, ssd_hit_tokens: hit(body.messages) });
      }
      if (!known(body.model)) return error(404, `Model '${body.model}' not found`);
      if (url.pathname === '/v1/messages/count_tokens') {
        countRequests.push(body as AnthropicCount);
        const { system, messages } = body as AnthropicCount;
        const all = [...(system === undefined ? [] : [{ role: 'system', content: system }]), ...messages];
        const rendered = all.some(m => m.role === 'user') ? chatml(all, true) : all.map(m => `${m.role}: ${m.content}`).join('\n');
        return Response.json({ input_tokens: tokenize(rendered, true).length });
      }
      if (url.pathname === '/v1/chat/completions') {
        chatRequests.push(body);
        const reply = replies.shift();
        if (!reply) return error(500, 'no scripted reply');
        written = cache;
        cache = [...tokenize(chatml(body.messages, true), true), ...tokenize(reply.chunks.join(''), false)];
        const usage = reply.usage && { ...reply.usage, total_tokens: 0, prompt_tokens_details: { cached_tokens: reply.cacheN ?? 0 }, total_time: 0.5 };
        const final = { object: 'chat.completion.chunk', choices: [], usage: usage ?? null };
        return new Response(stream(reply, req.signal, final), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    reply: (r: Reply) => replies.push(r),
    chatRequests,
    countRequests,
    stop: () => server.stop(true),
  };
}

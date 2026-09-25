// Scriptable fake of the llama.cpp server endpoints Resector uses (architecture §7 "Fake backend").
// Template: ChatML. Tokenizer: every special marker, whitespace run and word is one token; BOS = 1 token.

export type Reply = {
  chunks: string[];
  finish?: 'stop' | 'length';
  // Keep the stream open after the chunks until the client aborts.
  hang?: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number };
  cacheN?: number;
  // End the stream without finish_reason (dropped connection) or with a mid-stream error event.
  truncate?: boolean;
  error?: string;
};

export type FakeOptions = { jinja?: boolean; nCtx?: number; model?: string };

type ChatMessage = { role: string; content: string };

export function chatml(messages: ChatMessage[], addGenerationPrompt: boolean): string {
  const turns = messages.map(m => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('');
  return turns + (addGenerationPrompt ? '<|im_start|>assistant\n' : '');
}

// Like llama.cpp: a trailing assistant message is a prefill – generation prompt plus its content, no end of turn.
function applyTemplate(messages: ChatMessage[], addGenerationPrompt: boolean): string {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return chatml(messages, addGenerationPrompt);
  return chatml(messages.slice(0, -1), true) + last.content;
}

export function tokenize(text: string, addSpecial: boolean): number[] {
  const pieces = text.match(/<\|[a-z_]+\|>|\s+|[^\s<]+|</g) ?? [];
  return [...(addSpecial ? [1] : []), ...pieces.map((_, i) => 100 + i)];
}

export function startFakeLlamaCpp({ jinja = true, nCtx = 4096, model = 'qwen3-8b-q4_k_m.gguf' }: FakeOptions = {}) {
  const replies: Reply[] = [];
  const chatRequests: unknown[] = [];
  const error = (message: string) => Response.json({ error: { code: 500, message, type: 'server_error' } }, { status: 500 });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: model, object: 'model' }] });
      if (url.pathname === '/props') return Response.json({ default_generation_settings: { n_ctx: nCtx }, total_slots: 1 });
      const body = (await req.json()) as Record<string, any>;
      if (url.pathname === '/apply-template') {
        if (body.tools && !jinja) return error('tools param requires --jinja flag');
        return Response.json({ prompt: applyTemplate(body.messages, body.add_generation_prompt !== false) });
      }
      if (url.pathname === '/tokenize') return Response.json({ tokens: tokenize(body.content, body.add_special === true) });
      if (url.pathname === '/v1/chat/completions') {
        chatRequests.push(body);
        const reply = replies.shift();
        if (!reply) return error('no scripted reply');
        return new Response(stream(reply, req.signal), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    reply: (r: Reply) => replies.push(r),
    chatRequests,
    stop: () => server.stop(true),
  };
}

function stream(reply: Reply, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const data = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
  return new ReadableStream({
    async start(ctrl) {
      for (const content of reply.chunks) ctrl.enqueue(data({ choices: [{ index: 0, delta: { content } }] }));
      if (reply.error) ctrl.enqueue(data({ error: { code: 500, message: reply.error, type: 'server_error' } }));
      if (reply.truncate || reply.error) return ctrl.close();
      if (reply.hang) {
        await new Promise(resolve => signal.addEventListener('abort', resolve));
        return;
      }
      ctrl.enqueue(data({ choices: [{ index: 0, delta: {}, finish_reason: reply.finish ?? 'stop' }] }));
      ctrl.enqueue(data({ choices: [], usage: reply.usage ?? null, timings: { cache_n: reply.cacheN ?? 0 } }));
      ctrl.enqueue(enc.encode('data: [DONE]'));
      ctrl.close();
    },
  });
}

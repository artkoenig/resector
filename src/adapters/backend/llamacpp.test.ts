import { afterEach, expect, test } from 'bun:test';
import { chatml, startFakeLlamaCpp, tokenize } from '../../../test/fake-llamacpp';
import type { Message } from '../../core/render/native';
import { prefixes, request, toolLoop } from '../../../test/requests';
import { connectLlamaCpp } from './llamacpp';

let fake: ReturnType<typeof startFakeLlamaCpp>;
afterEach(() => fake.stop());

test('startup fails with a hint when llama.cpp runs without --jinja', async () => {
  fake = startFakeLlamaCpp({ jinja: false });
  await expect(connectLlamaCpp(fake.url)).rejects.toThrow('llama.cpp runs without --jinja: restart llama-server with --jinja');
});

test('the window is the per-slot context size from /props', async () => {
  fake = startFakeLlamaCpp({ nCtx: 8192 });
  expect((await connectLlamaCpp(fake.url)).window).toBe(8192);
});

test('startup fails with a hint when llama.cpp is not reachable', async () => {
  fake = startFakeLlamaCpp();
  fake.stop();
  await expect(connectLlamaCpp(fake.url)).rejects.toThrow(`cannot reach llama.cpp at ${fake.url}`);
});

test('per-block tokens sum to the exact size of the rendered request', async () => {
  fake = startFakeLlamaCpp();
  const messages = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'hi there' },
  ] as const;
  const split = await (await connectLlamaCpp(fake.url)).count(prefixes([...messages]));
  // fake tokenizer: each marker, word and whitespace run is a token
  expect(split.blocks).toEqual([12, 8]);
  // BOS + <|im_start|> assistant \n
  expect(split.template).toBe(4);
  expect(split.total).toBe(tokenize(chatml([...messages], true), true).length);
});

test('an answer streams in deltas and ends with finish reason, usage and cached tokens', async () => {
  fake = startFakeLlamaCpp();
  fake.reply({ chunks: ['Hel', 'lo'], usage: { prompt_tokens: 20, completion_tokens: 2 }, cacheN: 7 });
  const deltas: string[] = [];
  const messages = [{ role: 'user', content: 'hi' }] as const;
  const result = await (await connectLlamaCpp(fake.url)).chat(request([...messages]), {
    signal: new AbortController().signal,
    onDelta: d => deltas.push(d),
  });
  expect(deltas).toEqual(['Hel', 'lo']);
  expect(result).toEqual({
    content: 'Hello',
    calls: [],
    finish: 'stop',
    usage: { prompt_tokens: 20, completion_tokens: 2 },
    cached: 7,
    predicted: 0,
  });
  expect(fake.chatRequests).toEqual([{ n_cache_reuse: 0, messages, stream: true, stream_options: { include_usage: true } }]);
});

test('aborting keeps the partial answer', async () => {
  fake = startFakeLlamaCpp();
  fake.reply({ chunks: ['Hal'], hang: true });
  const abort = new AbortController();
  const result = await (await connectLlamaCpp(fake.url)).chat(request([{ role: 'user', content: 'hi' }]), {
    signal: abort.signal,
    onDelta: () => abort.abort(),
  });
  expect(result).toEqual({ content: 'Hal', calls: [], finish: 'aborted', usage: null, cached: null, predicted: 0 });
});

test('a backend error surfaces with its message', async () => {
  fake = startFakeLlamaCpp();
  const chat = (await connectLlamaCpp(fake.url)).chat(request([{ role: 'user', content: 'hi' }]), {
    signal: new AbortController().signal,
    onDelta: () => {},
  });
  await expect(chat).rejects.toThrow('no scripted reply');
});

test('an Assistant block owns its end of turn, not the following block', async () => {
  fake = startFakeLlamaCpp();
  const split = await (await connectLlamaCpp(fake.url)).count(prefixes([
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'hi there' },
    { role: 'assistant', content: 'hello' },
  ]));
  expect(split.blocks).toEqual([12, 8, 6]);
  expect(split.template).toBe(4);
});

const chatOnce = async (signal = new AbortController().signal) =>
  (await connectLlamaCpp(fake.url)).chat(request([{ role: 'user', content: 'hi' }]), { signal, onDelta: () => {} });

test('a stream that ends without finish reason is an error, not a complete answer', async () => {
  fake = startFakeLlamaCpp();
  fake.reply({ chunks: ['Hel'], truncate: true });
  await expect(chatOnce()).rejects.toThrow('stream ended without finish_reason');
});

test('an error event inside the stream surfaces with its message', async () => {
  fake = startFakeLlamaCpp();
  fake.reply({ chunks: ['Hel'], error: 'slot unavailable' });
  await expect(chatOnce()).rejects.toThrow('slot unavailable');
});

test('aborting before the answer starts yields an empty aborted answer', async () => {
  fake = startFakeLlamaCpp();
  const abort = new AbortController();
  abort.abort();
  expect(await chatOnce(abort.signal)).toEqual({ content: '', calls: [], finish: 'aborted', usage: null, cached: null, predicted: 0 });
});

test('a server that disappears before chatting is reported as unreachable', async () => {
  fake = startFakeLlamaCpp();
  const backend = await connectLlamaCpp(fake.url);
  fake.stop();
  const chat = backend.chat(request([{ role: 'user', content: 'hi' }]), { signal: new AbortController().signal, onDelta: () => {} });
  await expect(chat).rejects.toThrow(`cannot reach llama.cpp at ${fake.url}`);
});

test('the Model Profile overrides the window and adds model and sampling to every request', async () => {
  fake = startFakeLlamaCpp({ nCtx: 8192 });
  const backend = await connectLlamaCpp(fake.url, { window: 4096, model: 'qwen3', sampling: { temperature: 0.2, top_k: 20 } });
  expect(backend.window).toBe(4096);
  fake.reply({ chunks: ['ok'] });
  await backend.chat(request([{ role: 'user', content: 'hi' }]), { signal: new AbortController().signal, onDelta: () => {} });
  expect(fake.chatRequests[0]).toMatchObject({ model: 'qwen3', temperature: 0.2, top_k: 20, stream: true });
});

const SYSTEM = { role: 'system', content: 'You are an agent.' } as const;
const USER = { role: 'user', content: 'hi there' } as const;
const send = (backend: Awaited<ReturnType<typeof connectLlamaCpp>>, messages: Message[]) =>
  backend.chat(request(messages), { signal: new AbortController().signal, onDelta: () => {} });

test('before the first request of a session nothing is predicted as cached', async () => {
  fake = startFakeLlamaCpp();
  const counted = await (await connectLlamaCpp(fake.url)).count(prefixes([SYSTEM, USER]));
  expect(counted.cached).toEqual({ tokens: 0, exact: true });
});

test('after an answer, the prompt and the answer are cached up to the first differing token', async () => {
  fake = startFakeLlamaCpp();
  const backend = await connectLlamaCpp(fake.url);
  fake.reply({ chunks: ['hello'] });
  await send(backend, [SYSTEM, USER]);
  // System 12 + User 8 + Assistant 6 are unchanged (BOS before them is not a row); the new User block starts cold.
  const next = await backend.count(prefixes([SYSTEM, USER, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }]));
  expect(next.cached).toEqual({ tokens: 26, exact: true });
  // An edited User block invalidates everything from its first changed token on.
  const edited = await backend.count(prefixes([SYSTEM, { role: 'user', content: 'hi you' }]));
  expect(edited.cached.tokens).toBe(12 + 5);
});

// The Assistant row counts as cached with its end of turn, which the server has not processed yet
// (generation stopped there); the reuse predicted for a request is what the server actually keeps.
test('each answer reports the reuse predicted for its request; an unchanged prompt re-evaluates its last token', async () => {
  fake = startFakeLlamaCpp();
  const backend = await connectLlamaCpp(fake.url);
  fake.reply({ chunks: ['hello'] });
  fake.reply({ chunks: ['hello'] });
  expect((await send(backend, [SYSTEM, USER])).predicted).toBe(0);
  // BOS + System 12 + User 8 + generation prompt 3 = 24 tokens, all in the cache.
  expect((await send(backend, [SYSTEM, USER])).predicted).toBe(23);
});

test('a session pins its llama.cpp slot and turns cache reuse off', async () => {
  fake = startFakeLlamaCpp({ slots: 4 });
  const backend = await connectLlamaCpp(fake.url, { session: 'ses_a', sampling: { n_cache_reuse: 256 } });
  fake.reply({ chunks: ['ok'] });
  fake.reply({ chunks: ['ok'] });
  await send(backend, [USER]);
  await send(await connectLlamaCpp(fake.url, { session: 'ses_a' }), [USER]);
  const [first, second] = fake.chatRequests as { id_slot: number; n_cache_reuse: number }[];
  expect([0, 1, 2, 3]).toContain(first!.id_slot);
  expect(second!.id_slot).toBe(first!.id_slot);
  expect(first!.n_cache_reuse).toBe(0);
});

test('tools and tool calls: every block owns its tokens and the rows sum to the rendered request', async () => {
  fake = startFakeLlamaCpp();
  const requests = toolLoop();
  const split = await (await connectLlamaCpp(fake.url)).count(requests);
  const whole = requests.at(-1)!;
  expect(split.total).toBe(tokenize(chatml(whole.messages, true, whole.tools), true).length);
  expect(split.blocks.reduce((a, b) => a + b, 0) + split.template).toBe(split.total);
  // Tools Block: the <tools> list in the system turn; each Tool Call: its <tool_call> element.
  expect(split.blocks[1]).toBe(tokenize(`\n\n<tools>\n${JSON.stringify(whole.tools[0])}\n</tools>`, false).length);
  expect(split.blocks[4]).toBe(split.blocks[5]);
  expect(split.blocks.every(n => n > 0)).toBe(true);
});

test('the request sends the tools; tool calls stream in and end with finish reason tool_calls', async () => {
  fake = startFakeLlamaCpp();
  fake.reply({ chunks: ['Let me see.'], calls: [{ name: 'bash', arguments: '{"command":"ls -la"}' }, { name: 'bash', arguments: '{"command":"pwd"}' }] });
  const chat = toolLoop()[1]!;
  const result = await (await connectLlamaCpp(fake.url)).chat(chat, { signal: new AbortController().signal, onDelta: () => {} });
  expect(result).toMatchObject({
    content: 'Let me see.',
    calls: [{ name: 'bash', arguments: '{"command":"ls -la"}' }, { name: 'bash', arguments: '{"command":"pwd"}' }],
    finish: 'tool_calls',
  });
  expect(fake.chatRequests[0]).toMatchObject({ tools: chat.tools, messages: chat.messages });
  expect(chat.tools).toHaveLength(1);
});

test('a request without tools has no tools field', async () => {
  fake = startFakeLlamaCpp();
  fake.reply({ chunks: ['ok'] });
  await (await connectLlamaCpp(fake.url)).chat(request([{ role: 'user', content: 'hi' }]), { signal: new AbortController().signal, onDelta: () => {} });
  expect(fake.chatRequests[0]).not.toHaveProperty('tools');
});

test('an answer with tool calls counts as cached with its calls', async () => {
  fake = startFakeLlamaCpp();
  const backend = await connectLlamaCpp(fake.url);
  const [, , , , , , loop] = toolLoop();
  const asked = { ...loop!, messages: loop!.messages.slice(0, 2) };
  fake.reply({ chunks: ['Checking.'], calls: [{ name: 'bash', arguments: '{"command":"ls"}' }, { name: 'bash', arguments: '{"command":"pwd"}' }] });
  await backend.chat(asked, { signal: new AbortController().signal, onDelta: () => {} });
  const counted = await backend.count(toolLoop());
  // System, Tools, User, Assistant and both Tool Calls are warm; the Tool Results are new.
  expect(counted.cached.tokens).toBe(counted.blocks.slice(0, 6).reduce((a, b) => a + b, 0));
});

import { afterEach, expect, test } from 'bun:test';
import { chatml, startFakeLlamaCpp, tokenize } from '../../../test/fake-llamacpp';
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
  const split = await (await connectLlamaCpp(fake.url)).count([...messages]);
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
  const result = await (await connectLlamaCpp(fake.url)).chat([...messages], {
    signal: new AbortController().signal,
    onDelta: d => deltas.push(d),
  });
  expect(deltas).toEqual(['Hel', 'lo']);
  expect(result).toEqual({
    content: 'Hello',
    finish: 'stop',
    usage: { prompt_tokens: 20, completion_tokens: 2 },
    cached: 7,
  });
  expect(fake.chatRequests).toEqual([{ messages, stream: true, stream_options: { include_usage: true } }]);
});

test('aborting keeps the partial answer', async () => {
  fake = startFakeLlamaCpp();
  fake.reply({ chunks: ['Hal'], hang: true });
  const abort = new AbortController();
  const result = await (await connectLlamaCpp(fake.url)).chat([{ role: 'user', content: 'hi' }], {
    signal: abort.signal,
    onDelta: () => abort.abort(),
  });
  expect(result).toEqual({ content: 'Hal', finish: 'aborted', usage: null, cached: null });
});

test('a backend error surfaces with its message', async () => {
  fake = startFakeLlamaCpp();
  const chat = (await connectLlamaCpp(fake.url)).chat([{ role: 'user', content: 'hi' }], {
    signal: new AbortController().signal,
    onDelta: () => {},
  });
  await expect(chat).rejects.toThrow('no scripted reply');
});

test('an Assistant block owns its end of turn, not the following block', async () => {
  fake = startFakeLlamaCpp();
  const split = await (await connectLlamaCpp(fake.url)).count([
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'hi there' },
    { role: 'assistant', content: 'hello' },
  ]);
  expect(split.blocks).toEqual([12, 8, 6]);
  expect(split.template).toBe(4);
});

const chatOnce = async (signal = new AbortController().signal) =>
  (await connectLlamaCpp(fake.url)).chat([{ role: 'user', content: 'hi' }], { signal, onDelta: () => {} });

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
  expect(await chatOnce(abort.signal)).toEqual({ content: '', finish: 'aborted', usage: null, cached: null });
});

test('a server that disappears before chatting is reported as unreachable', async () => {
  fake = startFakeLlamaCpp();
  const backend = await connectLlamaCpp(fake.url);
  fake.stop();
  const chat = backend.chat([{ role: 'user', content: 'hi' }], { signal: new AbortController().signal, onDelta: () => {} });
  await expect(chat).rejects.toThrow(`cannot reach llama.cpp at ${fake.url}`);
});

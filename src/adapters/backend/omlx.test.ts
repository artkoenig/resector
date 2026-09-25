import { afterEach, expect, test } from 'bun:test';
import { chatml, tokenize } from '../../../test/fake-llamacpp';
import { startFakeOmlx, type FakeOmlxOptions } from '../../../test/fake-omlx';
import type { Message } from '../../core/render/native';
import { connectOmlx, type OmlxOptions } from './omlx';

let fake: ReturnType<typeof startFakeOmlx>;
afterEach(() => fake.stop());

const MODEL = 'Qwen3-8B-4bit';
const open = (options: Partial<OmlxOptions> = {}, fakeOptions?: FakeOmlxOptions) => {
  fake = startFakeOmlx(fakeOptions);
  return connectOmlx(fake.url, { model: MODEL, ...options });
};
const chatOnce = async (backend: Awaited<ReturnType<typeof connectOmlx>>, signal = new AbortController().signal) =>
  backend.chat([{ role: 'user', content: 'hi' }], { signal, onDelta: () => {} });

test("the window is max_model_len of the profile's model", async () => {
  const models = [
    { id: 'gemma-3-4b', maxModelLen: 8192 },
    { id: MODEL, maxModelLen: 57344 },
  ];
  expect((await open({}, { models })).window).toBe(57344);
});

test('the Model Profile window overrides max_model_len', async () => {
  expect((await open({ window: 4096 })).window).toBe(4096);
});

test('a model the server does not report max_model_len for needs a window in the Model Profile', async () => {
  await expect(open({}, { models: [{ id: MODEL }] })).rejects.toThrow(`oMLX reports no max_model_len for ${MODEL}: set window in the Model Profile`);
  fake.stop();
  expect((await open({ window: 2048 }, { models: [{ id: MODEL }] })).window).toBe(2048);
});

test('a model oMLX does not serve is an error naming the served ones', async () => {
  await expect(open({ model: 'llama-3' }, { models: [{ id: 'a' }, { id: 'b' }] })).rejects.toThrow('oMLX does not serve model "llama-3" (models: a, b)');
});

test('a Model Profile without model is an error', async () => {
  await expect(open({ model: undefined })).rejects.toThrow('oMLX Model Profile needs a model');
});

test('startup fails with a hint when oMLX is not reachable', async () => {
  fake = startFakeOmlx();
  fake.stop();
  await expect(connectOmlx(fake.url, { model: MODEL })).rejects.toThrow(`cannot reach oMLX at ${fake.url}`);
});

test('per-block tokens sum to the exact size of the rendered request', async () => {
  const messages = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'hi there' },
    { role: 'assistant', content: 'hello' },
  ] as const;
  const split = await (await open()).count([...messages]);
  // fake tokenizer: each marker, word and whitespace run is a token
  expect(split.blocks).toEqual([12, 8, 6]);
  // BOS + <|im_start|> assistant \n
  expect(split.template).toBe(4);
  expect(split.total).toBe(tokenize(chatml([...messages], true), true).length);
});

test('counting sends the System block as system and the rest as Anthropic messages', async () => {
  await (await open()).count([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
  ]);
  expect(fake.countRequests).toContainEqual({ model: MODEL, system: 'S', messages: [{ role: 'user', content: 'U' }] });
});

// Templates like Qwen3-2507 cannot render a prompt without user message; oMLX would silently fall back.
test('a Context without user message is counted with an empty user turn in the Template row', async () => {
  const split = await (await open()).count([{ role: 'system', content: 'You are an agent.' }]);
  expect(split.blocks).toEqual([12]);
  // BOS + <|im_start|> user \n <|im_end|> \n + <|im_start|> assistant \n
  expect(split.template).toBe(9);
  expect(split.total).toBe(21);
});

test('an answer streams in deltas and ends with finish reason, usage and cached tokens', async () => {
  const backend = await open({ sampling: { temperature: 0.2, top_k: 20 } });
  fake.reply({ chunks: ['Hel', 'lo'], usage: { prompt_tokens: 20, completion_tokens: 2 }, cacheN: 7 });
  const deltas: string[] = [];
  const messages = [{ role: 'user', content: 'hi' }] as const;
  const result = await backend.chat([...messages], { signal: new AbortController().signal, onDelta: d => deltas.push(d) });
  expect(deltas).toEqual(['Hel', 'lo']);
  expect(result).toEqual({ content: 'Hello', finish: 'stop', usage: { prompt_tokens: 20, completion_tokens: 2 }, cached: 7, predicted: null });
  expect(fake.chatRequests).toEqual([
    { model: MODEL, temperature: 0.2, top_k: 20, messages, stream: true, stream_options: { include_usage: true } },
  ]);
});

test('a length cut-off is reported as such', async () => {
  const backend = await open();
  fake.reply({ chunks: ['Hel'], finish: 'length' });
  expect(await chatOnce(backend)).toMatchObject({ content: 'Hel', finish: 'length', usage: null, cached: null });
});

test('aborting keeps the partial answer', async () => {
  const backend = await open();
  fake.reply({ chunks: ['Hal'], hang: true });
  const abort = new AbortController();
  const result = await backend.chat([{ role: 'user', content: 'hi' }], { signal: abort.signal, onDelta: () => abort.abort() });
  expect(result).toEqual({ content: 'Hal', finish: 'aborted', usage: null, cached: null, predicted: null });
});

test('stream errors surface: missing reply, error event, dropped connection', async () => {
  const backend = await open();
  await expect(chatOnce(backend)).rejects.toThrow('oMLX /v1/chat/completions: 500');
  fake.reply({ chunks: ['Hel'], error: 'model unloaded' });
  await expect(chatOnce(backend)).rejects.toThrow('oMLX stream: model unloaded');
  fake.reply({ chunks: ['Hel'], truncate: true });
  await expect(chatOnce(backend)).rejects.toThrow('oMLX stream ended without finish_reason');
});

const SYSTEM = { role: 'system', content: 'You are an agent.' } as const;
const USER = { role: 'user', content: 'hi there' } as const;

test("oMLX predicts the cache hit itself, in whole cache blocks, exactly", async () => {
  const backend = await open();
  expect((await backend.count([SYSTEM, USER])).cached).toEqual({ tokens: 0, exact: true });
  fake.reply({ chunks: ['hello'] });
  await chatOnce(backend);
  fake.reply({ chunks: ['hello'] });
  await backend.chat([SYSTEM, USER], { signal: new AbortController().signal, onDelta: () => {} });
  // BOS + System 12 + User 8 + <|im_start|> assistant \n hello = 25 cached tokens → 6 blocks of 4.
  const next: Message[] = [SYSTEM, USER, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }];
  expect((await backend.count(next)).cached).toEqual({ tokens: 24, exact: true });
  fake.reply({ chunks: ['ok'] });
  expect((await backend.chat(next, { signal: new AbortController().signal, onDelta: () => {} })).predicted).toBe(24);
  // A request that was not counted right before has no prediction to verify.
  fake.reply({ chunks: ['ok'] });
  expect((await backend.chat([...next, { role: 'user', content: 'x' }], { signal: new AbortController().signal, onDelta: () => {} })).predicted).toBeNull();
});

test('right after an answer, the unchanged messages of the request count in whole blocks before the probe sees them', async () => {
  const backend = await open({}, { lagging: true });
  fake.reply({ chunks: ['hello'] });
  await backend.chat([SYSTEM, USER], { signal: new AbortController().signal, onDelta: () => {} });
  // System 12 + User 8 unchanged → 20 = 5 blocks of 4; the answer is not counted.
  const counted = await backend.count([SYSTEM, USER, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }]);
  expect(counted.cached).toEqual({ tokens: 20, exact: true });
  fake.stop();
  const bigger = await open({}, { lagging: true, blockSize: 16 });
  fake.reply({ chunks: ['hello'] });
  await bigger.chat([SYSTEM, USER], { signal: new AbortController().signal, onDelta: () => {} });
  expect((await bigger.count([SYSTEM, USER])).cached).toEqual({ tokens: 16, exact: true });
});

test('without the cache probe, messages equal to the last request and its answer count as cached, approximately', async () => {
  const backend = await open({}, { probe: false });
  fake.reply({ chunks: ['hello'] });
  const sent = await backend.chat([SYSTEM, USER], { signal: new AbortController().signal, onDelta: () => {} });
  expect(sent.predicted).toBeNull();
  const counted = await backend.count([SYSTEM, USER, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }]);
  expect(counted.cached).toEqual({ tokens: 12 + 8 + 6, exact: false });
  expect((await backend.count([SYSTEM, { role: 'user', content: 'hi you' }])).cached).toEqual({ tokens: 12, exact: false });
});

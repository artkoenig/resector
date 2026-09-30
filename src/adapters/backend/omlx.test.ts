import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatml, tokenize } from '../../../test/fake-llamacpp';
import { startFakeOmlx, type FakeOmlxOptions } from '../../../test/fake-omlx';
import type { Message } from '../../core/render/native';
import { prefixes, request, toolLoop } from '../../../test/requests';
import { connectOmlx, COUNTS, type OmlxOptions } from './omlx';

let fake: ReturnType<typeof startFakeOmlx>;
afterEach(() => fake.stop());

const MODEL = 'Qwen3-8B-4bit';
const open = (options: Partial<OmlxOptions> = {}, fakeOptions?: FakeOmlxOptions) => {
  fake = startFakeOmlx(fakeOptions);
  return connectOmlx(fake.url, { model: MODEL, ...options });
};
const chatOnce = async (backend: Awaited<ReturnType<typeof connectOmlx>>, signal = new AbortController().signal) =>
  backend.chat(request([{ role: 'user', content: 'hi' }]), { signal, onDelta: () => {} });

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
  const split = await (await open()).count(prefixes([...messages]));
  // fake tokenizer: each marker, word and whitespace run is a token
  expect(split.blocks).toEqual([12, 8, 6]);
  // BOS + <|im_start|> assistant \n
  expect(split.template).toBe(4);
  expect(split.total).toBe(tokenize(chatml([...messages], true), true).length);
});

test('counting sends the System block as system and the rest as Anthropic messages', async () => {
  await (await open()).count(prefixes([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
  ]));
  expect(fake.countRequests).toContainEqual({ model: MODEL, system: 'S', messages: [{ role: 'user', content: 'U' }] });
});

// Templates like Qwen3-2507 cannot render a prompt without user message; oMLX would silently fall back.
test('a Context without user message is counted with an empty user turn in the Template row', async () => {
  const split = await (await open()).count(prefixes([{ role: 'system', content: 'You are an agent.' }]));
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
  const result = await backend.chat(request([...messages]), { signal: new AbortController().signal, onDelta: d => deltas.push(d) });
  expect(deltas).toEqual(['Hel', 'lo']);
  expect(result).toEqual({ thinking: '', content: 'Hello', calls: [], finish: 'stop', usage: { prompt_tokens: 20, completion_tokens: 2 }, cached: 7, predicted: null });
  expect(fake.chatRequests).toEqual([
    { model: MODEL, temperature: 0.2, top_k: 20, messages, stream: true, stream_options: { include_usage: true } },
  ]);
});

test('max_tokens goes into the request: the window minus the Context (FR-18); oMLX counts exactly', async () => {
  const backend = await open();
  expect(backend.exact).toBe(true);
  fake.reply({ chunks: ['ok'] });
  await backend.chat(request([{ role: 'user', content: 'hi' }]), { signal: new AbortController().signal, onDelta: () => {}, maxTokens: 321 });
  expect(fake.chatRequests[0]).toMatchObject({ max_tokens: 321 });
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
  const result = await backend.chat(request([{ role: 'user', content: 'hi' }]), { signal: abort.signal, onDelta: () => abort.abort() });
  expect(result).toEqual({ thinking: '', content: 'Hal', calls: [], finish: 'aborted', usage: null, cached: null, predicted: null });
});

test('stream errors surface: missing reply, error event, dropped connection', async () => {
  const backend = await open();
  await expect(chatOnce(backend)).rejects.toThrow('oMLX 500: no scripted reply');
  fake.reply({ chunks: ['Hel'], error: 'model unloaded' });
  await expect(chatOnce(backend)).rejects.toThrow('oMLX stream: model unloaded');
  fake.reply({ chunks: ['Hel'], truncate: true });
  await expect(chatOnce(backend)).rejects.toThrow('oMLX stream ended without finish_reason');
});

const SYSTEM = { role: 'system', content: 'You are an agent.' } as const;
const USER = { role: 'user', content: 'hi there' } as const;

test("oMLX predicts the cache hit itself, in whole cache blocks, exactly", async () => {
  const backend = await open();
  expect((await backend.count(prefixes([SYSTEM, USER]))).cached).toEqual({ tokens: 0, exact: true });
  fake.reply({ chunks: ['hello'] });
  await chatOnce(backend);
  fake.reply({ chunks: ['hello'] });
  await backend.chat(request([SYSTEM, USER]), { signal: new AbortController().signal, onDelta: () => {} });
  // BOS + System 12 + User 8 + <|im_start|> assistant \n hello = 25 cached tokens → 6 blocks of 4.
  const next: Message[] = [SYSTEM, USER, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }];
  expect((await backend.count(prefixes(next))).cached).toEqual({ tokens: 24, exact: true });
  fake.reply({ chunks: ['ok'] });
  expect((await backend.chat(request(next), { signal: new AbortController().signal, onDelta: () => {} })).predicted).toBe(24);
  // A request that was not counted right before has no prediction to verify.
  fake.reply({ chunks: ['ok'] });
  expect((await backend.chat(request([...next, { role: 'user', content: 'x' }]), { signal: new AbortController().signal, onDelta: () => {} })).predicted).toBeNull();
});

test('right after an answer, the unchanged messages of the request count in whole blocks before the probe sees them', async () => {
  const backend = await open({}, { lagging: true });
  fake.reply({ chunks: ['hello'] });
  await backend.chat(request([SYSTEM, USER]), { signal: new AbortController().signal, onDelta: () => {} });
  // System 12 + User 8 unchanged → 20 = 5 blocks of 4; the answer is not counted.
  const counted = await backend.count(prefixes([SYSTEM, USER, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }]));
  expect(counted.cached).toEqual({ tokens: 20, exact: true });
  fake.stop();
  const bigger = await open({}, { lagging: true, blockSize: 16 });
  fake.reply({ chunks: ['hello'] });
  await bigger.chat(request([SYSTEM, USER]), { signal: new AbortController().signal, onDelta: () => {} });
  expect((await bigger.count(prefixes([SYSTEM, USER]))).cached).toEqual({ tokens: 16, exact: true });
});

test('without the cache probe, messages equal to the last request and its answer count as cached, approximately', async () => {
  const backend = await open({}, { probe: false });
  fake.reply({ chunks: ['hello'] });
  const sent = await backend.chat(request([SYSTEM, USER]), { signal: new AbortController().signal, onDelta: () => {} });
  expect(sent.predicted).toBeNull();
  const counted = await backend.count(prefixes([SYSTEM, USER, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }]));
  expect(counted.cached).toEqual({ tokens: 12 + 8 + 6, exact: false });
  expect((await backend.count(prefixes([SYSTEM, { role: 'user', content: 'hi you' }]))).cached).toEqual({ tokens: 12, exact: false });
});

test('counting converts tools, tool calls and tool results to the Anthropic format', async () => {
  const requests = toolLoop();
  const split = await (await open()).count(requests);
  const whole = requests.at(-1)!;
  expect(split.total).toBe(tokenize(chatml(whole.messages, true, whole.tools), true).length);
  expect(split.blocks.every(n => n > 0)).toBe(true);
  expect(fake.countRequests.at(-1)).toEqual({
    model: MODEL,
    system: 'You are an agent.',
    messages: [
      { role: 'user', content: 'look around' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'call_0', name: 'bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'pwd' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_0', content: 'a b\n[exit 0]' },
          { type: 'tool_result', tool_use_id: 'call_1', content: '/p\n[exit 0]' },
        ],
      },
    ],
    tools: [{ name: 'bash', description: whole.tools[0]!.function.description, input_schema: whole.tools[0]!.function.parameters }],
  });
});

test('a tool call without text is only tool_use blocks', async () => {
  await (await open()).count(prefixes([
    { role: 'user', content: 'U' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
  ]));
  expect(fake.countRequests.at(-1)!.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'bash', input: { command: 'ls' } }] });
});

test('tool calls stream in; tools are sent with the request', async () => {
  const backend = await open();
  fake.reply({ chunks: [], calls: [{ name: 'bash', arguments: '{"command":"ls"}' }] });
  const chat = toolLoop()[2]!;
  const result = await backend.chat(chat, { signal: new AbortController().signal, onDelta: () => {} });
  expect(result).toMatchObject({ content: '', calls: [{ name: 'bash', arguments: '{"command":"ls"}' }], finish: 'tool_calls' });
  expect(fake.chatRequests[0]).toMatchObject({ tools: chat.tools });
});

test('without the probe, blocks the last answer already rendered count as cached, tool calls included', async () => {
  const backend = await open({}, { probe: false });
  const loop = toolLoop();
  fake.reply({ chunks: ['Checking.'], calls: [{ name: 'bash', arguments: '{"command":"ls"}' }, { name: 'bash', arguments: '{"command":"pwd"}' }] });
  await backend.chat(loop[2]!, { signal: new AbortController().signal, onDelta: () => {} });
  const counted = await backend.count(loop);
  // System, Tools, User, Assistant and both Tool Calls; the Tool Results are new.
  expect(counted.cached).toEqual({ tokens: counted.blocks.slice(0, 6).reduce((a, b) => a + b, 0), exact: false });
});

test('the profile thinking goes into every request (FR-49)', async () => {
  const backend = await open({ thinking: 'on' });
  fake.reply({ chunks: ['ok'] });
  await chatOnce(backend);
  expect(fake.chatRequests[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
});

test('the thinking modes come from the chat template in the model directory the admin API names (FR-49)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resector-model-'));
  writeFileSync(join(dir, 'tokenizer_config.json'), JSON.stringify({ chat_template: "{% if enable_thinking %}{% endif %}{% if reasoning_effort == 'max' %}{% endif %}" }));
  expect((await open({}, { models: [{ id: MODEL, maxModelLen: 57344, path: dir }] })).thinkingModes).toEqual(['off', 'on', 'max']);
  fake.stop();
  writeFileSync(join(dir, 'chat_template.jinja'), "{% if reasoning_effort in ['low', 'xhigh'] %}{% endif %}");
  expect((await open({}, { models: [{ id: MODEL, maxModelLen: 57344, path: dir }] })).thinkingModes).toEqual(['low', 'xhigh']);
  fake.stop();
  expect((await open()).thinkingModes).toBeNull();
});

test('without the admin API the thinking modes come from the prompts the server renders per effort (splash, FR-49)', async () => {
  const efforts = { none: '<think></think>', low: 'effort low', medium: '<think>', high: 'effort xhigh', xhigh: 'effort xhigh' };
  expect((await open({}, { efforts })).thinkingModes).toEqual(['off', 'on', 'low', 'medium', 'xhigh']);
});

test('off is sent as reasoning_effort none only where the server rendered none as off (splash, FR-49)', async () => {
  const efforts = { none: '<think></think>', low: 'effort low' };
  fake = startFakeOmlx({ efforts });
  fake.reply({ chunks: ['ok'] });
  await chatOnce(await connectOmlx(fake.url, { model: MODEL, thinking: 'off' }));
  expect(fake.chatRequests[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none' });
  fake.stop();
  const backend = await open({ thinking: 'off' });
  fake.reply({ chunks: ['ok'] });
  await chatOnce(backend);
  expect(fake.chatRequests[0]).not.toHaveProperty('reasoning_effort');
});

test('a request with its own thinking overrides the profile (FR-49)', async () => {
  const backend = await open({ thinking: 'off' });
  fake.reply({ chunks: ['ok'] });
  await backend.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [], thinking: 'high' }, { signal: new AbortController().signal, onDelta: () => {} });
  expect(fake.chatRequests[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'high' });
});

test('a count takes at most COUNTS server slots at once: servers refuse requests beyond their slots', async () => {
  const messages: Message[] = [{ role: 'user', content: 'hi' }];
  for (let i = 0; i < 40; i++) messages.push({ role: 'assistant', content: `a${i}` }, { role: 'user', content: `u${i}` });
  const split = await (await open()).count(prefixes(messages));
  expect(split.blocks).toHaveLength(81);
  expect(fake.mostCounts()).toBe(COUNTS);
});

test('a request the server answers 503 goes again, after Retry-After', async () => {
  const backend = await open({}, { busy: 3 });
  const messages: Message[] = [{ role: 'user', content: 'hi' }];
  expect((await backend.count([{ messages, tools: [] }])).blocks).toHaveLength(1);
});

test('counts render the thinking as the chat request does: the profile, else the request its own (FR-49)', async () => {
  const backend = await open({ thinking: 'low' });
  const messages: Message[] = [{ role: 'user', content: 'hi' }];
  await backend.count([{ messages, tools: [] }]);
  expect(fake.countRequests.at(-1)).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
  await backend.count([{ messages, tools: [], thinking: 'on' }]);
  expect(fake.countRequests.at(-1)).toMatchObject({ thinking: { type: 'adaptive' } });
  expect(fake.countRequests.at(-1)).not.toHaveProperty('output_config');
  await backend.count([{ messages, tools: [], thinking: 'off' }]);
  expect(fake.countRequests.at(-1)).toMatchObject({ thinking: { type: 'disabled' } });
});

test("a request's answer start is sent as a partial assistant message for oMLX to continue", async () => {
  const backend = await open({});
  fake.reply({ chunks: ['rest'] });
  const result = await backend.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [], answerStart: '## Goal\n' }, { signal: new AbortController().signal, onDelta: () => {} });
  expect(fake.chatRequests[0]).toMatchObject({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '## Goal\n', partial: true }] });
  expect(result.content).toBe('rest');
});

test('reasoning is counted inline; before the last user message the chat template drops it (FR-48)', async () => {
  const thought = { role: 'assistant', content: '', reasoning_content: 'plan it' } as const;
  const kept: Message[] = [{ role: 'user', content: 'hi there' }, { ...thought, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, { role: 'tool', tool_call_id: 'call_0', content: 'a' }];
  const dropped: Message[] = [{ role: 'user', content: 'hi there' }, { ...thought, content: 'hello' }, { role: 'user', content: 'more' }];
  const backend = await open();
  for (const [messages, thinking] of [[kept, 5 + tokenize('<think>\nplan it\n</think>\n\n', false).length], [dropped, 0]] as const) {
    const requests = prefixes([...messages]);
    requests.splice(1, 0, request([messages[0]!, thought]));
    const split = await backend.count(requests);
    expect(split.blocks[1]).toBe(thinking);
    expect(split.blocks.reduce((a, b) => a + b, 0) + split.template).toBe(split.total);
  }
});

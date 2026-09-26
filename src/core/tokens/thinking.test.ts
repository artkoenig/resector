import { expect, test } from 'bun:test';
import type { Message, Request } from '../render/native';
import { thinkingShares, type Counter } from './thinking';

const request = (...messages: Message[]): Request => ({ messages, tools: [] });
const USER: Message = { role: 'user', content: 'hi' };
const THOUGHT: Message = { role: 'assistant', content: '', reasoning_content: 'plan' };
const ANSWER: Message = { ...THOUGHT, content: 'ok' };
// A template counting 10 per message, 5 more for a reasoning it renders: in the request always, in a prefix never.
const size = (keep: boolean) => async ({ messages }: Request) =>
  messages.reduce((sum, m) => sum + 10 + (keep && 'reasoning_content' in m ? 5 : 0), 0);
const counter: Counter = { prefix: size(false), request: size(true) };

test('each Thinking block: what it adds to its counted prefix and to the request; joined when its message goes on', async () => {
  const requests = [request(USER), request(USER, THOUGHT), request(USER, ANSWER), request(USER, ANSWER, USER)];
  expect(await thinkingShares(requests, [10, 20, 20, 30], 35, counter)).toEqual([{ step: 1, prefix: 0, request: 5, joined: true }]);
});

test('a Thinking block alone in its message is not joined; steps adding no reasoning are no Thinking blocks', async () => {
  const other: Message = { role: 'assistant', content: 'x' };
  const requests = [request(THOUGHT), request(THOUGHT, other), request(THOUGHT, other, USER)];
  expect(await thinkingShares(requests, [10, 20, 30], 35, counter)).toEqual([{ step: 0, prefix: 0, request: 5, joined: false }]);
});

test('a request that is not sendable renders its Thinking blocks as the prefixes do', async () => {
  const requests = [request(USER), request(USER, THOUGHT)];
  expect(await thinkingShares(requests, [10, 20], 20, { ...counter, request: null })).toEqual([{ step: 1, prefix: 0, request: 0, joined: false }]);
});

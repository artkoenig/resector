import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { budget, lastDrift } from './budget';

const sent = (tokens: number): SessionEvent => ({ type: 'RequestSent', hash: 'h', tokens });
const received = (prompt_tokens: number | null): SessionEvent => ({
  type: 'ResponseReceived',
  usage: prompt_tokens === null ? null : { prompt_tokens, completion_tokens: 5 },
  cached: null,
});

const answer: SessionEvent = { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'ok' };

test('drift = the prompt tokens the server reports − the tokens counted before sending', () => {
  expect(lastDrift([])).toBeNull();
  expect(lastDrift([sent(100), answer, received(112)])).toBe(12);
  expect(lastDrift([sent(100), received(95)])).toBe(-5);
});

test('the last measured drift counts: an answer without usage (aborted) keeps the one before', () => {
  expect(lastDrift([sent(100), received(112), sent(200), received(203)])).toBe(3);
  expect(lastDrift([sent(100), received(112), sent(200), received(null)])).toBe(12);
  expect(lastDrift([sent(100), received(null)])).toBeNull();
});

test('a response without its own request before it measures nothing', () => {
  expect(lastDrift([received(50)])).toBeNull();
  expect(lastDrift([sent(100), received(112), received(150)])).toBe(12);
});

const exact = { window: 1000, exact: true, drift: null };

test('max_tokens is the window minus the Context: no answer reserve (FR-18)', () => {
  expect(budget({ ...exact, total: 400 }).maxTokens).toBe(600);
  expect(budget({ ...exact, total: 999 }).maxTokens).toBe(1);
});

test('below 90 % of the window all is fine; from 90 % on a warning (FR-2)', () => {
  expect(budget({ ...exact, total: 899 })).toMatchObject({ tone: 'ok', over: 0 });
  expect(budget({ ...exact, total: 900 })).toMatchObject({ tone: 'warn', over: 0 });
  expect(budget({ ...exact, total: 999 })).toMatchObject({ tone: 'warn', over: 0 });
});

test('sending is blocked from a Context as big as the window on: over by what has to go (FR-18)', () => {
  expect(budget({ ...exact, total: 1000 })).toMatchObject({ tone: 'over', over: 1 });
  expect(budget({ ...exact, total: 1250 })).toMatchObject({ tone: 'over', over: 251 });
});

test('an exact tokenizer ignores drift and shows none', () => {
  expect(budget({ ...exact, drift: 30, total: 980 })).toMatchObject({ tone: 'warn', over: 0, drift: null });
});

test('an inexact tokenizer subtracts the last drift, either sign, from the window; ±? before the first answer (FR-2, FR-18)', () => {
  const inexact = { window: 1000, exact: false };
  expect(budget({ ...inexact, drift: null, total: 999 })).toMatchObject({ tone: 'warn', over: 0, drift: '±?' });
  expect(budget({ ...inexact, drift: 30, total: 969 })).toMatchObject({ tone: 'warn', over: 0, drift: '±30' });
  expect(budget({ ...inexact, drift: 30, total: 970 })).toMatchObject({ tone: 'over', over: 1, drift: '±30' });
  expect(budget({ ...inexact, drift: -30, total: 970 })).toMatchObject({ tone: 'over', over: 1, drift: '±30' });
  // max_tokens stays the window minus the Context: the drift only guards the send.
  expect(budget({ ...inexact, drift: 30, total: 900 }).maxTokens).toBe(100);
});

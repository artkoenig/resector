import { expect, test } from 'bun:test';
import { splitThinking } from './thinking';

test('<think>…</think> at the start of the text is the reasoning, the rest the answer (FR-46)', () => {
  expect(splitThinking('<think>\nplan\n</think>\n\nHello')).toEqual({ thinking: 'plan', content: 'Hello' });
  expect(splitThinking('  <think>a</think>b')).toEqual({ thinking: 'a', content: 'b' });
});

test('an unclosed <think> is all reasoning so far; the answer has not started', () => {
  expect(splitThinking('<think>\nstill ')).toEqual({ thinking: 'still ', content: '' });
  expect(splitThinking('<thi')).toEqual({ thinking: '', content: '' });
});

test('text without a leading <think> is all answer', () => {
  expect(splitThinking('Hello <think>x</think>')).toEqual({ thinking: '', content: 'Hello <think>x</think>' });
  expect(splitThinking('')).toEqual({ thinking: '', content: '' });
  expect(splitThinking(' <', true)).toEqual({ thinking: '', content: ' <' });
});

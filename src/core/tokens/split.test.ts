import { expect, test } from 'bun:test';
import { splitTokens } from './split';

// prefixes[k] = tokens of the template applied to blocks 1..k+1 without generation prompt;
// empty = tokens of the empty prompt (BOS); total = tokens of the actual request prompt.
test('each block gets the tokens its message adds; the rest is the Template row', () => {
  expect(splitTokens({ empty: 1, prefixes: [11, 16, 30], total: 33 })).toEqual({
    blocks: [10, 5, 14],
    template: 4,
    total: 33,
  });
});

test('without blocks the whole request is Template', () => {
  expect(splitTokens({ empty: 1, prefixes: [], total: 3 })).toEqual({ blocks: [], template: 3, total: 3 });
});

// thinking: per Thinking block, what it adds to its counted prefix and to the request.
test('a Thinking block owns the reasoning as the request renders it, not as its prefix does', () => {
  const split = splitTokens({ empty: 1, prefixes: [11, 16, 30], total: 41, thinking: [{ step: 1, prefix: 2, request: 8, joined: true }] });
  expect(split).toEqual({ blocks: [10, 11, 14], template: 6, total: 41 });
});

test('reasoning the template drops: the Thinking block owns nothing; its role markers go to its message (FR-48)', () => {
  expect(splitTokens({ empty: 1, prefixes: [11, 16, 30], total: 33, thinking: [{ step: 1, prefix: 3, request: 0, joined: true }] })).toEqual({
    blocks: [10, 0, 16],
    template: 7,
    total: 33,
  });
  expect(splitTokens({ empty: 1, prefixes: [11, 16, 30], total: 33, thinking: [{ step: 1, prefix: 0, request: 0, joined: false }] })).toEqual({
    blocks: [10, 0, 14],
    template: 9,
    total: 33,
  });
});

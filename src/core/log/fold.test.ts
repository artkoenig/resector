import { expect, test } from 'bun:test';
import { fold } from './fold';

test('Context holds the session profile and the added blocks in order', () => {
  const context = fold([
    { type: 'SessionCreated', profile: 'default', protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'You are an agent.' },
    { type: 'BlockAdded', id: 2, kind: 'User', origin: 'user', content: 'hi' },
    { type: 'RequestSent', hash: 'abc', tokens: 12 },
    { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'hello', cutOff: true },
    { type: 'ResponseReceived', usage: { prompt_tokens: 12, completion_tokens: 1 }, cached: 0 },
  ]);
  expect(context).toEqual({
    profile: 'default',
    protocol: 'native',
    blocks: [
      { id: 1, kind: 'System', origin: 'config', content: 'You are an agent.', cutOff: false },
      { id: 2, kind: 'User', origin: 'user', content: 'hi', cutOff: false },
      { id: 3, kind: 'Assistant', origin: 'model', content: 'hello', cutOff: true },
    ],
  });
});

test('an empty log is rejected', () => {
  expect(() => fold([])).toThrow('Session Log must start with SessionCreated');
});

test('a log without SessionCreated is rejected', () => {
  expect(() => fold([{ type: 'BlockAdded', id: 1, kind: 'User', origin: 'user', content: 'hi' }])).toThrow(
    'Session Log must start with SessionCreated',
  );
});

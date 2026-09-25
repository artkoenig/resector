import { expect, test } from 'bun:test';
import { fold } from '../log/fold';
import { renderNative } from './native';

test('each block becomes one chat message with its role', () => {
  const context = fold([
    { type: 'SessionCreated', profile: 'default', protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
    { type: 'BlockAdded', id: 2, kind: 'User', origin: 'user', content: 'hi' },
    { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'hello', cutOff: true },
  ]);
  expect(renderNative(context)).toEqual([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

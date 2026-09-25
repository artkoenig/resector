import { expect, test } from 'bun:test';
import { decodeLog, encodeEvent } from './codec';

test('a Session Log is one event per line; blank lines are skipped', () => {
  const events = [
    { type: 'SessionCreated', profile: 'qwen', protocol: 'native' },
    { type: 'Remove', id: 2 },
  ] as const;
  const text = events.map(encodeEvent).join('');
  expect(text).toBe('{"type":"SessionCreated","profile":"qwen","protocol":"native"}\n{"type":"Remove","id":2}\n');
  expect(decodeLog(`${text}  \n`)).toEqual([...events]);
});

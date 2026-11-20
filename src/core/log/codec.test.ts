import { expect, test } from 'bun:test';
import type { SessionEvent } from './events';
import { array, forAll, map, oneOf, string } from '../../../test/property';
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

// Property: any content survives the round trip, line breaks and U+2028 included.
test('every event decodes as it was encoded', () => {
  const event = oneOf<SessionEvent>(
    map(string(), content => ({ type: 'BlockAdded', id: 1, kind: 'User', origin: 'user', content })),
    map(string(), content => ({ type: 'Edit', id: 1, revision: 2, content })),
    map(string(), title => ({ type: 'SessionRenamed', title })),
    map(string(), pattern => ({ type: 'AllowRuleAdded', pattern })),
  );
  forAll(array(event), events => {
    expect(decodeLog(events.map(encodeEvent).join(''))).toEqual(events);
  });
});

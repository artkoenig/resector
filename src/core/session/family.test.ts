// Sessions and their Subagents' Sessions: who belongs to whom, and the order they are listed in.
import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { arranged, familyOf, subagentsOf } from './family';

const starts = (...sessions: (string | undefined)[]): SessionEvent[] =>
  sessions.map((session, i) => ({ type: 'BackgroundStarted', call: i, pid: i, log: '', ...(session && { session }) }));
const listed = (logs: Record<string, SessionEvent[]>) =>
  arranged(Object.entries(logs).map(([id, events]) => ({ id, events }))).map(l => [l.session.id, l.depth]);

test('the Subagents of a Session are those its log names; other Background Processes name none', () => {
  expect(subagentsOf(starts('a', undefined, 'b'))).toEqual(['a', 'b']);
});

test('only a start names a Subagent, whatever other events carry', () => {
  const exited = { type: 'BackgroundExited', call: 0, exit: 0, session: 'a' } as SessionEvent;
  expect(subagentsOf([exited])).toEqual([]);
});

test('a family is the Session and every Session below it, each once', () => {
  const children: Record<string, string[]> = { p: ['a', 'b'], a: ['c'], c: ['p'] };
  expect(familyOf('p', id => children[id] ?? [])).toEqual(['p', 'a', 'b', 'c']);
});

test('Subagent Sessions are listed under their parent, otherwise the order stays', () => {
  expect(listed({ a: [], x: [], p: starts('a', 'gone', 'b'), b: starts('c'), c: [] })).toEqual([['x', 0], ['p', 0], ['a', 1], ['b', 1], ['c', 2]]);
});

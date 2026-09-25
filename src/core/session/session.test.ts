import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { TOOLS } from '../toolcall/bash';
import { newSession, summarize } from './session';

const start = newSession('qwen', 'You are an agent.');
const user = (id: number, content: string): SessionEvent => ({ type: 'BlockAdded', id, kind: 'User', origin: 'user', content });

test('a new session holds its Model Profile, the System prompt and the Tools Block', () => {
  expect(start).toEqual([
    { type: 'SessionCreated', profile: 'qwen', protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'You are an agent.' },
    { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: TOOLS },
  ]);
  expect(summarize(start)).toEqual({ title: '(new session)', renamed: false, profile: 'qwen', blocks: 2, tokens: null });
});

test('the title is the first line of the first User message, shortened (FR-34)', () => {
  const long = 'x'.repeat(70);
  expect(summarize([...start, user(2, '  \n  Fix the build \nplease'), user(3, 'other')]).title).toBe('Fix the build');
  expect(summarize([...start, user(2, ' \n ')]).title).toBe('(new session)');
  expect(summarize([...start, user(2, long)]).title).toBe('x'.repeat(59) + '…');
  expect(summarize([...start, user(2, 'x'.repeat(60))]).title).toBe('x'.repeat(60));
});

test('a session rename wins; an empty one resets to the first User message', () => {
  const renamed: SessionEvent[] = [...start, user(2, 'hi'), { type: 'SessionRenamed', title: 'greeting' }, { type: 'Rename', id: 2, title: 'block title' }];
  expect(summarize(renamed)).toMatchObject({ title: 'greeting', renamed: true });
  expect(summarize([...renamed, { type: 'SessionRenamed', title: '' }])).toMatchObject({ title: 'hi', renamed: false });
});

test('the summary counts the Context blocks and takes the tokens of the last request', () => {
  const events: SessionEvent[] = [
    ...start,
    user(2, 'a'),
    { type: 'RequestSent', hash: 'h1', tokens: 20 },
    { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'b' },
    { type: 'Remove', id: 2 },
    { type: 'RequestSent', hash: 'h2', tokens: 14 },
    { type: 'ProfileFallback', profile: 'gemma' },
  ];
  expect(summarize(events)).toEqual({ title: 'a', renamed: false, profile: 'gemma', blocks: 2, tokens: 14 });
});

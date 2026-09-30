import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { TOOLS } from '../toolcall/bash';
import { inWorktree, newSession, openingBlocks, summarize } from './session';

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

test('the title is the first line of the first User message, shortened', () => {
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

test('a new session starts with the environment Note and the project instructions right after the Tools Block', () => {
  const events = newSession('qwen', 'sys', { environment: 'cwd: /p', instructions: [{ file: 'AGENTS.md', content: '# Rules\n' }] });
  expect(events.slice(3)).toEqual([
    { type: 'BlockAdded', id: 3, kind: 'Note', origin: 'environment', content: 'cwd: /p' },
    { type: 'BlockAdded', id: 4, kind: 'Note', origin: 'file', file: 'AGENTS.md', content: '[AGENTS.md]\n# Rules\n' },
  ]);
  expect(summarize(events).blocks).toBe(4);
  expect(newSession('qwen', 'sys', { environment: 'cwd: /p', instructions: [] })).toHaveLength(4);
});

test('the blocks a session starts with are those newSession added, not file references added later', () => {
  const events: SessionEvent[] = [
    ...newSession('qwen', 'sys', { environment: 'cwd: /p', instructions: [{ file: 'AGENTS.md', content: '# Rules\n' }] }),
    { type: 'FileReferenced', id: 5, file: 'a.txt' },
    user(6, 'hi'),
  ];
  expect([...openingBlocks(events)]).toEqual([1, 2, 3, 4]);
  expect([...openingBlocks([...newSession('qwen', 'sys'), user(3, 'hi'), user(4, 'again')])]).toEqual([1, 2]);
  expect([...openingBlocks(newSession('qwen', 'sys'))]).toEqual([1, 2]);
});

test('a session runs in its worktree after the last switch on; a new one in the project', () => {
  const events = newSession('p', 'sys');
  expect(inWorktree(events)).toBe(false);
  expect(inWorktree([...events, { type: 'WorktreeSet', on: true }, { type: 'SessionRenamed', title: 't' }])).toBe(true);
  expect(inWorktree([...events, { type: 'WorktreeSet', on: true }, { type: 'WorktreeSet', on: false }])).toBe(false);
});

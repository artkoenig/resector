import { expect, test } from 'bun:test';
import { fold } from '../log/fold';
import type { SessionEvent } from '../log/events';
import { inContextRequest, sourcesRequest } from './compaction';
import { renderNative } from './native';

const session = (): SessionEvent[] => [
  { type: 'SessionCreated', profile: 'default', protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
  { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: '[]' },
  { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'find the bug' },
  { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'found it' },
];

test('the sources as one user message after the system prompt, no tools', () => {
  const [, , user, assistant] = fold(session()).blocks;
  expect(sourcesRequest('rewrite', [user!, assistant!], 'keep errors')).toEqual({
    messages: [{ role: 'system', content: 'rewrite' }, { role: 'user', content: '# User\nfind the bug\n\n# Assistant\nfound it\n\nInstruction: keep errors' }],
    tools: [],
  });
});

test('in the Context: the request as sent, the instruction appended, so the prefix cache holds all but it', () => {
  const context = fold(session());
  const sent = renderNative(context);
  expect(inContextRequest(context, 'summarize')).toEqual({ ...sent, messages: [...sent.messages, { role: 'user', content: 'summarize' }] });
});

test('in the Context: the answer begins with the first heading the instruction asks for, so the model writes no reasoning', () => {
  expect(inContextRequest(fold(session()), 'summarize as:\n## Goal\n## Done').answerStart).toBe('## Goal\n');
});

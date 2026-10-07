import { expect, test } from 'bun:test';
import { fold } from '../log/fold';
import { parse, viewOf } from './policy';
import { pending, session } from './policy.harness';

test('the view: each block sent with its tokens, the other block of its Tool Pair, and whether it awaits approval', () => {
  const context = fold(session({ type: 'Remove', id: 4 }, pending));
  expect(viewOf(context, { blocks: [5, 6, 7, 8, 9, 10, 11], total: 60 }, { window: 4096 })).toEqual({
    window: 4096,
    used: 60,
    blocks: [
      { id: 1, kind: 'System', origin: 'config', content: 'sys', tokens: 5, pair: null, pending: false },
      { id: 2, kind: 'Tools', origin: 'config', content: '[]', tokens: 6, pair: null, pending: false },
      { id: 3, kind: 'Thinking', origin: 'model', content: 'hmm', tokens: 7, pair: null, pending: false },
      { id: 5, kind: 'Tool Call', origin: 'model', content: 'ls', tokens: 8, pair: 6, pending: false },
      { id: 6, kind: 'Tool Result', origin: 'tool', content: 'a b', tokens: 9, pair: 5, pending: false },
      { id: 7, kind: 'User', origin: 'user', content: 'go on', tokens: 10, pair: null, pending: false },
      { id: 8, kind: 'Tool Call', origin: 'model', content: 'pwd', tokens: 11, pair: null, pending: true },
    ],
  });
});

test('an operation of another shape is refused', () => {
  for (const op of [null, 'remove', { op: 'pin', id: 3 }, { op: 'remove', id: '3' }, { op: 'remove', id: 3.5 }, { op: 'edit', id: 3 }, { op: 'move', id: 3 }, { op: 'compact', sources: [3] }, { op: 'note', after: 2 }, { op: 'note', content: 'x' }])
    expect(parse(op)).toEqual({ error: `not an operation: ${JSON.stringify(op)}` });
  expect(parse({ op: 'move', id: 3, after: 4, extra: 1 })).toEqual({ op: 'move', id: 3, after: 4 });
});

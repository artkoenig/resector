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
      { id: 1, kind: 'System', origin: 'config', content: 'sys', tokens: 5, pair: null, pending: false, keep: false, background: null },
      { id: 2, kind: 'Tools', origin: 'config', content: '[]', tokens: 6, pair: null, pending: false, keep: false, background: null },
      { id: 3, kind: 'Thinking', origin: 'model', content: 'hmm', tokens: 7, pair: null, pending: false, keep: false, background: null },
      { id: 5, kind: 'Tool Call', origin: 'model', content: 'ls', tokens: 8, pair: 6, pending: false, keep: false, background: null },
      { id: 6, kind: 'Tool Result', origin: 'tool', content: 'a b', tokens: 9, pair: 5, pending: false, keep: false, background: null },
      { id: 7, kind: 'User', origin: 'user', content: 'go on', tokens: 10, pair: null, pending: false, keep: false, background: null },
      { id: 8, kind: 'Tool Call', origin: 'model', content: 'pwd', tokens: 11, pair: null, pending: true, keep: false, background: null },
    ],
  });
});

test('the view: a Tool Call run as a Background Process carries its process group, log and whether it runs', () => {
  const started = { type: 'BackgroundStarted' as const, call: 5, pid: 42, log: '/h/5.log' };
  const view = (...more: Parameters<typeof session>) => viewOf(fold(session(...more)), { blocks: [1, 1, 1, 1, 1, 1, 1, 1], total: 8 }, { window: 99 }).blocks;
  expect(view(started).find(b => b.id === 5)!.background).toEqual({ pid: 42, log: '/h/5.log', running: true });
  expect(view(started).find(b => b.id === 6)!.background).toBeNull();
  expect(view(started, { type: 'BackgroundExited', call: 5, exit: 0 }).find(b => b.id === 5)!.background).toEqual({ pid: 42, log: '/h/5.log', running: false });
});

test('the view: Project Instructions are to keep, a File Reference is not', () => {
  const context = fold(session({ type: 'BlockAdded', id: 8, kind: 'Note', origin: 'file', file: 'AGENTS.md', content: 'x' }, { type: 'FileReferenced', id: 9, file: 'a.ts' }));
  const { blocks } = viewOf(context, { blocks: context.blocks.map(() => 1), total: 9 }, { window: 99 });
  expect(blocks.filter(b => b.keep).map(b => b.id)).toEqual([8]);
});

test('an operation of another shape is refused', () => {
  for (const op of [null, 'remove', { op: 'pin', id: 3 }, { op: 'remove', id: '3' }, { op: 'remove', id: 3.5 }, { op: 'edit', id: 3 }, { op: 'move', id: 3 }, { op: 'compact', sources: [3] }, { op: 'note', after: 2 }, { op: 'note', content: 'x' }])
    expect(parse(op)).toEqual({ error: `not an operation: ${JSON.stringify(op)}` });
  expect(parse({ op: 'move', id: 3, after: 4, extra: 1 })).toEqual({ op: 'move', id: 3, after: 4 });
});

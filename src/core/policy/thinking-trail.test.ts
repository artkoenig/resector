import { expect, test } from 'bun:test';
import type { Kind, SessionEvent } from '../log/events';
import { fold } from '../log/fold';
import { sentBlocks } from '../render/native';
import { BUILT_IN } from './built-in';
import { applyPolicy, viewOf } from './policy';
import thinkingTrail, { INSTRUCTION } from './thinking-trail';

// Blocks from id 3 on after System and Tools Block; a Tool Result answers the Tool Call right before it.
const log = (...kinds: Kind[]): SessionEvent[] => [
  { type: 'SessionCreated', profile: 'default', protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
  { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: '[]' },
  ...kinds.map((kind, i): SessionEvent => ({ type: 'BlockAdded', id: i + 3, kind, origin: 'model', content: kind, ...(kind === 'Tool Result' ? { call: i + 2 } : {}) })),
];
const context = (...kinds: Kind[]) => {
  const folded = fold(log(...kinds));
  return viewOf(folded, { blocks: sentBlocks(folded).map(() => 1), total: 0 }, 4096);
};
const run = (...kinds: Kind[]) => thinkingTrail(context(...kinds));

test('no Thinking, no Tool Pair: nothing', () => {
  expect(run()).toEqual([]);
  expect(run('User', 'Assistant')).toEqual([]);
});

test('Tool Pairs before the newest Thinking are removed, once each', () => {
  // 3 User, 4 Thinking, 5/6 pair, 7 Thinking, 8/9 pair, 10 Thinking, 11/12 pair
  expect(run('User', 'Thinking', 'Tool Call', 'Tool Result', 'Thinking', 'Tool Call', 'Tool Result', 'Thinking', 'Tool Call', 'Tool Result')).toEqual([
    { op: 'remove', id: 5 },
    { op: 'remove', id: 8 },
  ]);
});

test('Tool Pairs after the newest Thinking stay: the model has not seen their results yet', () => {
  expect(run('User', 'Thinking', 'Tool Call', 'Tool Result', 'Tool Call', 'Tool Result')).toEqual([]);
});

test('without Thinking no Tool Pair is removed', () => {
  expect(run('User', 'Tool Call', 'Tool Result')).toEqual([]);
});

test('a pending Tool Call stays, also before the newest Thinking', () => {
  // 3 Tool Call without result, 4 Thinking
  expect(run('User', 'Tool Call', 'Thinking')).toEqual([]);
});

test('a Tool Pair whose Tool Result comes after the newest Thinking stays: the model has not seen the result', () => {
  const view = context('Thinking', 'Tool Call', 'Tool Result', 'Thinking');
  const [call, result, newest] = view.blocks.slice(3);
  expect(thinkingTrail({ ...view, blocks: [...view.blocks.slice(0, 3), call!, newest!, result!] })).toEqual([]);
});

test('4 Thinking: nothing to compact', () => {
  expect(run('User', 'Thinking', 'Assistant', 'Thinking', 'Thinking', 'User', 'Thinking')).toEqual([]);
});

test('5 Thinking: one compact over exactly those 5, in Context order', () => {
  expect(run('Thinking', 'User', 'Thinking', 'Assistant', 'Thinking', 'Thinking', 'Note', 'Thinking')).toEqual([
    { op: 'compact', sources: [3, 5, 7, 8, 10], instruction: INSTRUCTION },
  ]);
});

test('6 Thinking: all of them into one Note', () => {
  expect(run('Thinking', 'Thinking', 'Thinking', 'Thinking', 'Thinking', 'Thinking')).toEqual([{ op: 'compact', sources: [3, 4, 5, 6, 7, 8], instruction: INSTRUCTION }]);
});

test('both rules in one pass: the Tool Pairs go, the Thinking is compacted', () => {
  expect(run('Thinking', 'Tool Call', 'Tool Result', 'Thinking', 'Thinking', 'Thinking', 'Thinking')).toEqual([
    { op: 'remove', id: 4 },
    { op: 'compact', sources: [3, 6, 7, 8, 9], instruction: INSTRUCTION },
  ]);
});

test('the instruction asks for a concise trail', () => {
  expect(INSTRUCTION).toBe(
    'Summarise these reasoning steps into a concise trail: goal, findings and decisions so far with their reasons, approaches discarded, next planned step. No repetition, no tool output.',
  );
});

test('applied by the hook: the Tool Pair goes, 5 Thinking become one Note, then nothing more to do', async () => {
  const events = log('Thinking', 'Tool Call', 'Tool Result', 'Thinking', 'Thinking', 'Thinking', 'Thinking', 'User');
  const ran = await applyPolicy(
    { name: 'thinking-trail', run: thinkingTrail },
    {
      events: () => events,
      append: event => void events.push(event),
      count: async c => ({ blocks: sentBlocks(c).map(() => 1), total: 0 }),
      window: 4096,
      compact: async () => 'the trail',
      aborted: () => false,
    },
  );
  expect(ran).toEqual({ changes: [{ noun: 'Tool Pair', verb: 'removed' }, { text: '5 Thinking → 1 Note' }], error: null });
  expect(sentBlocks(fold(events)).map(b => [b.kind, b.content])).toEqual([
    ['System', 'sys'],
    ['Tools', '[]'],
    ['Note', 'the trail'],
    ['User', 'User'],
  ]);
});

test('shipped built-in as thinking-trail', () => {
  expect(BUILT_IN).toEqual([{ name: 'thinking-trail', run: thinkingTrail }]);
});

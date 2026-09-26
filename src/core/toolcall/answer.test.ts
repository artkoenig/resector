import { expect, test } from 'bun:test';
import type { ChatResult } from '../backend';
import { answerBlocks } from './answer';

const result = (over: Partial<ChatResult>): ChatResult => ({ thinking: '', content: '', calls: [], finish: 'stop', usage: null, cached: null, predicted: null, ...over });
const bash = (command: string) => ({ name: 'bash', arguments: JSON.stringify({ command }) });

test('text and each bash call become separate blocks, in order', () => {
  expect(answerBlocks(result({ content: 'Looking.', calls: [bash('ls'), bash('pwd')], finish: 'tool_calls' }), 7, ['bash'])).toEqual({
    events: [
      { type: 'BlockAdded', id: 7, kind: 'Assistant', origin: 'model', content: 'Looking.' },
      { type: 'BlockAdded', id: 8, kind: 'Tool Call', origin: 'model', content: 'ls' },
      { type: 'BlockAdded', id: 9, kind: 'Tool Call', origin: 'model', content: 'pwd' },
    ],
    notRun: null,
  });
});

test('calls without text add no Assistant block; an answer without anything adds an empty one', () => {
  expect(answerBlocks(result({ calls: [bash('ls')] }), 3, ['bash']).events).toEqual([{ type: 'BlockAdded', id: 3, kind: 'Tool Call', origin: 'model', content: 'ls' }]);
  expect(answerBlocks(result({}), 3, ['bash']).events).toEqual([{ type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: '' }]);
});

test('a cut-off answer runs no call: its calls stay in the text (FR-19)', () => {
  for (const finish of ['length', 'aborted'] as const)
    expect(answerBlocks(result({ content: 'Hm', calls: [bash('ls')], finish }), 3, ['bash'])).toEqual({
      events: [{ type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'Hm\nbash {"command":"ls"}', cutOff: true }],
      notRun: null,
    });
});

test('a call that is no bash command stays in the text, not run, and says why', () => {
  expect(answerBlocks(result({ calls: [{ name: 'python', arguments: '{}' }, bash('pwd'), { name: 'bash', arguments: '{' }] }), 3, ['bash'])).toEqual({
    events: [
      { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'python {}\nbash {' },
      { type: 'BlockAdded', id: 4, kind: 'Tool Call', origin: 'model', content: 'pwd' },
    ],
    notRun: 'unknown tool python',
  });
});

test('reasoning becomes a Thinking block before the Assistant block of the same answer (FR-46)', () => {
  expect(answerBlocks(result({ thinking: 'Plan: ls.', content: 'Looking.', calls: [bash('ls')], finish: 'tool_calls' }), 5, ['bash']).events).toEqual([
    { type: 'BlockAdded', id: 5, kind: 'Thinking', origin: 'model', content: 'Plan: ls.' },
    { type: 'BlockAdded', id: 6, kind: 'Assistant', origin: 'model', content: 'Looking.' },
    { type: 'BlockAdded', id: 7, kind: 'Tool Call', origin: 'model', content: 'ls' },
  ]);
  expect(answerBlocks(result({ thinking: 'Plan: ls.', calls: [bash('ls')] }), 5, ['bash']).events.map(e => e.kind)).toEqual(['Thinking', 'Tool Call']);
});

test('cut off while thinking: the Thinking block is cut off, no Assistant block (FR-19)', () => {
  for (const finish of ['length', 'aborted'] as const)
    expect(answerBlocks(result({ thinking: 'Hmm, the', finish }), 3, ['bash'])).toEqual({
      events: [{ type: 'BlockAdded', id: 3, kind: 'Thinking', origin: 'model', content: 'Hmm, the', cutOff: true }],
      notRun: null,
    });
  expect(answerBlocks(result({ finish: 'aborted' }), 3, ['bash']).events).toEqual([{ type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: '', cutOff: true }]);
  expect(answerBlocks(result({ thinking: 'Done.', content: 'Ans', finish: 'length' }), 3, ['bash']).events).toEqual([
    { type: 'BlockAdded', id: 3, kind: 'Thinking', origin: 'model', content: 'Done.' },
    { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Ans', cutOff: true },
  ]);
});

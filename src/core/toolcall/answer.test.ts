import { expect, test } from 'bun:test';
import type { ChatResult } from '../backend';
import { answerBlocks } from './answer';

const result = (over: Partial<ChatResult>): ChatResult => ({ content: '', calls: [], finish: 'stop', usage: null, cached: null, predicted: null, ...over });
const bash = (command: string) => ({ name: 'bash', arguments: JSON.stringify({ command }) });

test('text and each bash call become separate blocks, in order', () => {
  expect(answerBlocks(result({ content: 'Looking.', calls: [bash('ls'), bash('pwd')], finish: 'tool_calls' }), 7)).toEqual({
    events: [
      { type: 'BlockAdded', id: 7, kind: 'Assistant', origin: 'model', content: 'Looking.' },
      { type: 'BlockAdded', id: 8, kind: 'Tool Call', origin: 'model', content: 'ls' },
      { type: 'BlockAdded', id: 9, kind: 'Tool Call', origin: 'model', content: 'pwd' },
    ],
    notRun: null,
  });
});

test('calls without text add no Assistant block; an answer without anything adds an empty one', () => {
  expect(answerBlocks(result({ calls: [bash('ls')] }), 3).events).toEqual([{ type: 'BlockAdded', id: 3, kind: 'Tool Call', origin: 'model', content: 'ls' }]);
  expect(answerBlocks(result({}), 3).events).toEqual([{ type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: '' }]);
});

test('a cut-off answer runs no call: its calls stay in the text (FR-19)', () => {
  for (const finish of ['length', 'aborted'] as const)
    expect(answerBlocks(result({ content: 'Hm', calls: [bash('ls')], finish }), 3)).toEqual({
      events: [{ type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'Hm\nbash {"command":"ls"}', cutOff: true }],
      notRun: null,
    });
});

test('a call that is no bash command stays in the text, not run, and says why', () => {
  expect(answerBlocks(result({ calls: [{ name: 'python', arguments: '{}' }, bash('pwd'), { name: 'bash', arguments: '{' }] }), 3)).toEqual({
    events: [
      { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'python {}\nbash {' },
      { type: 'BlockAdded', id: 4, kind: 'Tool Call', origin: 'model', content: 'pwd' },
    ],
    notRun: 'unknown tool python',
  });
});

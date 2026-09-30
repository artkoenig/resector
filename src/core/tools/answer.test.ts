import { expect, test } from 'bun:test';
import type { ChatResult } from './answer';
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

test('text of only whitespace before calls adds no Assistant block', () => {
  expect(answerBlocks(result({ content: '\n\n', calls: [bash('ls')] }), 3, ['bash']).events).toEqual([{ type: 'BlockAdded', id: 3, kind: 'Tool Call', origin: 'model', content: 'ls' }]);
});

test('a search call becomes a Tool Call of tool search, its query the content', () => {
  const search = { name: 'search', arguments: '{"query":"bun runtime"}' };
  expect(answerBlocks(result({ calls: [search, bash('ls')] }), 3, ['bash', 'search']).events).toEqual([
    { type: 'BlockAdded', id: 3, kind: 'Tool Call', origin: 'model', content: 'bun runtime', tool: 'search' },
    { type: 'BlockAdded', id: 4, kind: 'Tool Call', origin: 'model', content: 'ls' },
  ]);
});

test('a cut-off answer runs no call: its calls stay in the text', () => {
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

test('reasoning becomes a Thinking block before the Assistant block of the same answer', () => {
  expect(answerBlocks(result({ thinking: 'Plan: ls.', content: 'Looking.', calls: [bash('ls')], finish: 'tool_calls' }), 5, ['bash']).events).toEqual([
    { type: 'BlockAdded', id: 5, kind: 'Thinking', origin: 'model', content: 'Plan: ls.' },
    { type: 'BlockAdded', id: 6, kind: 'Assistant', origin: 'model', content: 'Looking.' },
    { type: 'BlockAdded', id: 7, kind: 'Tool Call', origin: 'model', content: 'ls' },
  ]);
  expect(answerBlocks(result({ thinking: 'Plan: ls.', calls: [bash('ls')] }), 5, ['bash']).events.map(e => e.kind)).toEqual(['Thinking', 'Tool Call']);
});

test('cut off while thinking: the Thinking block is cut off, no Assistant block', () => {
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

test('a Question without a valid Recommended Option is answered with the error at once: the user never sees it', () => {
  const invalid = JSON.stringify({ questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] });
  expect(answerBlocks(result({ calls: [{ name: 'question', arguments: invalid }, bash('ls')] }), 3, ['bash', 'question'])).toEqual({
    events: [
      { type: 'BlockAdded', id: 3, kind: 'Tool Call', origin: 'model', content: invalid, tool: 'question' },
      { type: 'BlockAdded', id: 4, kind: 'Tool Call', origin: 'model', content: 'ls' },
      { type: 'BlockAdded', id: 5, kind: 'Tool Result', origin: 'tool', content: 'error: question 1: recommended is missing – give the label of the Recommended Option', call: 3 },
    ],
    notRun: null,
  });
  const error = 'error: question 1: recommended is missing – give the label of the Recommended Option';
  expect(answerBlocks(result({ content: 'Asking.', calls: [{ name: 'question', arguments: invalid }, { name: 'question', arguments: invalid }] }), 3, ['question']).events).toEqual([
    { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'Asking.' },
    { type: 'BlockAdded', id: 4, kind: 'Tool Call', origin: 'model', content: invalid, tool: 'question' },
    { type: 'BlockAdded', id: 5, kind: 'Tool Call', origin: 'model', content: invalid, tool: 'question' },
    { type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: error, call: 4 },
    { type: 'BlockAdded', id: 7, kind: 'Tool Result', origin: 'tool', content: error, call: 5 },
  ]);
});

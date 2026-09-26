import { expect, test } from 'bun:test';
import { answerText, orderedOptions, parseQuestions, questionTitle } from './question';

const options = [
  { label: 'Bun', description: 'fast' },
  { label: 'Node', description: 'common' },
];
const question = (over: object = {}) => ({ question: 'Which runtime?', header: 'Runtime', options, recommended: 'Bun', ...over });
const parsed = (...questions: object[]) => parseQuestions({ questions });

test('a Question with at least two options and a Recommended Option is valid', () => {
  expect(parsed(question())).toEqual({ questions: [question()] });
  expect(parsed(question({ multiple: true, recommended: ['Bun', 'Node'] }))).toEqual({ questions: [question({ multiple: true, recommended: ['Bun', 'Node'] })] });
  expect(parsed(question({ multiple: true }))).toEqual({ questions: [question({ multiple: true })] });
});

test('a Question without a valid Recommended Option is rejected with the reason', () => {
  expect(parsed(question({ recommended: undefined }))).toEqual({ error: 'question 1: recommended is missing – give the label of the Recommended Option' });
  expect(parsed(question({ recommended: 'Deno' }))).toEqual({ error: 'question 1: recommended "Deno" is not an option label' });
  expect(parsed(question(), question({ recommended: ['Bun'] }))).toEqual({ error: 'question 2: recommended is a list, but multiple is not set' });
  expect(parsed(question({ multiple: true, recommended: [] }))).toEqual({ error: 'question 1: recommended is missing – give the label of the Recommended Option' });
  expect(parsed(question({ multiple: true, recommended: ['Bun', 'Deno'] }))).toEqual({ error: 'question 1: recommended "Deno" is not an option label' });
  expect(parsed(question({ multiple: true, recommended: ['Bun', 3] }))).toEqual({ error: 'question 1: recommended is missing – give the label of the Recommended Option' });
});

test('fewer than two options, missing texts or no questions are rejected', () => {
  expect(parsed(question({ options: [options[0]] }))).toEqual({ error: 'question 1: at least 2 options' });
  expect(parsed(question({ options: [options[0], { label: 'Node' }] }))).toEqual({ error: 'question 1: every option needs a label and a description' });
  expect(parsed(question({ options: [options[0], null] }))).toEqual({ error: 'question 1: every option needs a label and a description' });
  expect(parsed(question({ options: [null, options[0]] }))).toEqual({ error: 'question 1: every option needs a label and a description' });
  expect(parsed(question({ header: undefined }))).toEqual({ error: 'question 1: question and header must be strings' });
  expect(parsed()).toEqual({ error: 'questions must be a non-empty list' });
  expect(parseQuestions(null)).toEqual({ error: 'questions must be a non-empty list' });
});

test('the answer is one line per question: its full text, then the answer; several comma-separated, none Unanswered', () => {
  const second = question({ question: 'Which test runner?' });
  const third = question({ question: 'Which linters?', multiple: true });
  expect(answerText([question(), second, third], [['Bun'], [], ['Bun', 'Node', 'my own']])).toBe(
    'Which runtime?: Bun\nWhich test runner?: Unanswered\nWhich linters?: Bun, Node, my own',
  );
});

test('the dock lists the Recommended Options first, then the others in the model\'s order', () => {
  const three = [...options, { label: 'Deno', description: 'secure' }];
  expect(orderedOptions(question({ options: three, recommended: 'Deno' })).map(o => o.label)).toEqual(['Deno', 'Bun', 'Node']);
  expect(orderedOptions(question({ options: three, multiple: true, recommended: ['Deno', 'Node'] })).map(o => o.label)).toEqual(['Node', 'Deno', 'Bun']);
});

test('a Question\'s title is its question texts; content that is no Question stays as is', () => {
  expect(questionTitle(JSON.stringify({ questions: [question(), question({ question: 'Which linter?' })] }))).toBe('Which runtime? · Which linter?');
  expect(questionTitle('not json')).toBe('not json');
});

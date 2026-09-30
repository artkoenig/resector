import { expect, test } from 'bun:test';
import { callArguments, parseCall, resultText } from './call';

test('a call of a tool switched off is not run', () => {
  expect(parseCall({ name: 'bash', arguments: '{"command":"ls"}' }, [])).toEqual({ error: 'tool bash is off (/tools)' });
});

test('a bash call yields its command, a search call its query', () => {
  expect(parseCall({ name: 'bash', arguments: '{"command":"ls -la"}' }, ['bash'])).toEqual({ tool: 'bash', content: 'ls -la' });
  expect(parseCall({ name: 'search', arguments: '{"query":"bun"}' }, ['bash', 'search'])).toEqual({ tool: 'search', content: 'bun' });
  expect(parseCall({ name: 'search', arguments: '{"query":"bun"}' }, ['bash'])).toEqual({ error: 'tool search is off (/tools)' });
});

const QUESTION = { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], recommended: 'A' }] };

test('a question call yields its arguments as content; an invalid one is rejected back to the model', () => {
  const args = JSON.stringify(QUESTION);
  expect(parseCall({ name: 'question', arguments: args }, ['question'])).toEqual({ tool: 'question', content: args });
  const invalid = JSON.stringify({ questions: [{ ...QUESTION.questions[0], recommended: 'C' }] });
  expect(parseCall({ name: 'question', arguments: invalid }, ['question'])).toEqual({ tool: 'question', content: invalid, rejected: 'question 1: recommended "C" is not an option label' });
  expect(parseCall({ name: 'question', arguments: args }, ['bash'])).toEqual({ error: 'tool question is off (/tools)' });
});

test('a call is sent back with the arguments it came with', () => {
  expect(callArguments('bash', 'ls -la')).toBe('{"command":"ls -la"}');
  expect(callArguments('search', 'bun')).toBe('{"query":"bun"}');
  expect(callArguments('question', JSON.stringify(QUESTION))).toBe(JSON.stringify(QUESTION));
});

test('other tools, broken JSON or a missing command are not runnable', () => {
  expect(parseCall({ name: 'python', arguments: '{"command":"x"}' }, ['bash'])).toEqual({ error: 'unknown tool python' });
  expect(parseCall({ name: 'bash', arguments: '{"command":' }, ['bash'])).toEqual({ error: 'arguments are not valid JSON' });
  expect(parseCall({ name: 'bash', arguments: '{"cmd":"ls"}' }, ['bash'])).toEqual({ error: 'no command string' });
  expect(parseCall({ name: 'bash', arguments: 'null' }, ['bash'])).toEqual({ error: 'no command string' });
  expect(parseCall({ name: 'bash', arguments: '{"command":1}' }, ['bash'])).toEqual({ error: 'no command string' });
  expect(parseCall({ name: 'toString', arguments: '{}' }, ['toString'])).toEqual({ error: 'unknown tool toString' });
  expect(parseCall({ name: 'search', arguments: '{"command":"ls"}' }, ['search'])).toEqual({ error: 'no query string' });
});

test('the result is the output, then how the run ended', () => {
  expect(resultText({ output: 'a\nb\n\n', exit: 0, stopped: null }, 120)).toBe('a\nb\n[exit 0]');
  expect(resultText({ output: '', exit: 2, stopped: null }, 120)).toBe('[exit 2]');
  expect(resultText({ output: '  \n', exit: 1, stopped: null }, 120)).toBe('[exit 1]');
  expect(resultText({ output: 'partial', exit: null, stopped: 'killed' }, 120)).toBe('partial\n[killed]');
  expect(resultText({ output: '', exit: null, stopped: 'timeout' }, 5)).toBe('[timeout after 5 s]');
});

import { expect, test } from 'bun:test';
import { parseCall, resultText, TOOLS, toolNames } from './bash';

test('the Tools Block offers bash with one command parameter (FR-12, FR-21)', () => {
  expect(JSON.parse(TOOLS)).toEqual([
    {
      name: 'bash',
      description: expect.stringContaining('project root'),
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  ]);
  expect(toolNames(TOOLS)).toBe('bash');
  expect(toolNames('[{"name":"a"},{"name":"b"}]')).toBe('a, b');
});

test('a bash call yields its command', () => {
  expect(parseCall({ name: 'bash', arguments: '{"command":"ls -la"}' })).toEqual({ command: 'ls -la' });
});

test('other tools, broken JSON or a missing command are not runnable', () => {
  expect(parseCall({ name: 'python', arguments: '{"command":"x"}' })).toEqual({ error: 'unknown tool python' });
  expect(parseCall({ name: 'bash', arguments: '{"command":' })).toEqual({ error: 'arguments are not valid JSON' });
  expect(parseCall({ name: 'bash', arguments: '{"cmd":"ls"}' })).toEqual({ error: 'no command string' });
  expect(parseCall({ name: 'bash', arguments: 'null' })).toEqual({ error: 'no command string' });
  expect(parseCall({ name: 'bash', arguments: '{"command":1}' })).toEqual({ error: 'no command string' });
});

test('the result is the output, then how the run ended', () => {
  expect(resultText({ output: 'a\nb\n\n', exit: 0, stopped: null }, 120)).toBe('a\nb\n[exit 0]');
  expect(resultText({ output: '', exit: 2, stopped: null }, 120)).toBe('[exit 2]');
  expect(resultText({ output: '  \n', exit: 1, stopped: null }, 120)).toBe('[exit 1]');
  expect(resultText({ output: 'partial', exit: null, stopped: 'killed' }, 120)).toBe('partial\n[killed]');
  expect(resultText({ output: '', exit: null, stopped: 'timeout' }, 5)).toBe('[timeout after 5 s]');
});

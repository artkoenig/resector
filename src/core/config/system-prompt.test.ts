import { expect, test } from 'bun:test';
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt';

test('the shipped system prompt is short and carries the style (FR-30)', () => {
  // ~4 characters per token for English prose.
  expect(DEFAULT_SYSTEM_PROMPT.length / 4).toBeLessThanOrEqual(400);
  expect(DEFAULT_SYSTEM_PROMPT).toContain('Be extremely concise. Sacrifice grammar for the sake of concision.');
  expect(DEFAULT_SYSTEM_PROMPT).not.toContain('bash');
  // The file's final newline is not part of the prompt.
  expect(DEFAULT_SYSTEM_PROMPT).toEndWith('concision.');
});

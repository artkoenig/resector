// Shipped default system prompt (FR-30): role and style. No examples, no environment, no tools.
import prompt from './system-prompt.md' with { type: 'text' };

export const DEFAULT_SYSTEM_PROMPT = prompt.trimEnd();

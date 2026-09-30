// Compaction requests: the messages that ask the model for a Note, built here like every request (the ACL to Inference).
import type { Block, Context } from '../log/fold';
import { renderNative, type Request } from './native';

// Only the sources and the instruction, no tools. Titles are display only, never sent.
export function sourcesRequest(system: string, sources: Block[], instruction: string): Request {
  const text = sources.map(b => `# ${b.kind}\n${b.content}`).join('\n\n');
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: `${text}\n\nInstruction: ${instruction}` }], tools: [] };
}

// The Context as the next request sends it, the instruction as the last message: only that is new to the server's prefix cache.
// No reasoning: the Note is the answer, begun with the instruction's first line. Not thinking off: the chat template renders
// the thinking mode into the system prompt, so switching it would miss the cache.
export function inContextRequest(context: Context, instruction: string): Request {
  const request = renderNative(context);
  const start = instruction.split('\n').find(l => l.startsWith('## '));
  return { ...request, messages: [...request.messages, { role: 'user', content: instruction }], ...(start && { answerStart: `${start}\n` }) };
}

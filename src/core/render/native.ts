import type { Kind } from '../log/events';
import type { Context } from '../log/fold';

export type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const ROLE: Record<Kind, Message['role']> = { System: 'system', User: 'user', Assistant: 'assistant' };

// native Tool Protocol: one chat message per Context Block.
export function renderNative(context: Context): Message[] {
  return context.blocks.map(b => ({ role: ROLE[b.kind], content: b.content }));
}

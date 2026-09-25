import type { Kind } from '../log/events';
import type { Block, Context } from '../log/fold';

export type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const ROLE: Record<Kind, Message['role']> = { System: 'system', User: 'user', Assistant: 'assistant' };

// What goes into the next request: removed blocks are only struck through at the Gate.
export const sentBlocks = (context: Context): Block[] => context.blocks.filter(b => !b.removed);

// native Tool Protocol: one chat message per sent Context Block; a bottom pin is a user-role Note (FR-10).
export function renderNative(context: Context): Message[] {
  return sentBlocks(context).map(b => ({ role: b.pin === 'bottom' ? 'user' : ROLE[b.kind], content: b.content }));
}

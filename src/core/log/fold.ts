import type { Kind, Origin, SessionEvent, ToolProtocol } from './events';

export type Block = { id: number; kind: Kind; origin: Origin; content: string; cutOff: boolean };
export type Context = { profile: string; protocol: ToolProtocol; blocks: Block[] };

// Context = fold(events): replaying the Session Log yields the Context.
export function fold(events: SessionEvent[]): Context {
  const [first, ...rest] = events;
  if (first?.type !== 'SessionCreated') throw new Error('Session Log must start with SessionCreated');
  const blocks: Block[] = [];
  for (const e of rest) {
    if (e.type === 'BlockAdded')
      blocks.push({ id: e.id, kind: e.kind, origin: e.origin, content: e.content, cutOff: e.cutOff === true });
  }
  return { profile: first.profile, protocol: first.protocol, blocks };
}

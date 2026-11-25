// Which Sessions are whose Subagents, read from the parents' Session Logs: for listing and deleting them together.
import type { SessionEvent } from '../log/events';

// The Sessions of the Subagents a Session started, also of those that never opened theirs.
export const subagentsOf = (events: SessionEvent[]): string[] =>
  events.flatMap(e => (e.type === 'BackgroundStarted' && e.session !== undefined ? [e.session] : []));

// A Session and its Subagents' Sessions, the Session first. A Subagent resumed as an ordinary Session may have its own.
export function familyOf(id: string, childrenOf: (id: string) => string[]): string[] {
  const family = new Set([id]);
  // A Set's iteration reaches what is added meanwhile.
  for (const member of family) for (const child of childrenOf(member)) family.add(child);
  return [...family];
}

export type Listed<S> = { session: S; depth: number };

// The sessions with each Subagent's after its parent; otherwise in the order given. depth: 0 = no Subagent's.
export function arranged<S extends { id: string; events: SessionEvent[] }>(sessions: S[]): Listed<S>[] {
  const parents = new Map<string, string>();
  for (const s of sessions) for (const child of subagentsOf(s.events)) if (!parents.has(child)) parents.set(child, s.id);
  const below = (parent: string | undefined, depth: number): Listed<S>[] =>
    sessions.filter(s => parents.get(s.id) === parent).flatMap(session => [{ session, depth }, ...below(session.id, depth + 1)]);
  return below(undefined, 0);
}

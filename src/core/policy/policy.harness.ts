// Shared test support for the policy modules: a Session Log of every kind of block, and a pending Tool Call.
import type { SessionEvent } from '../log/events';

// System, Tools, User, Thinking, Assistant, a Tool Pair (5, 6), a User message.
export const session = (...then: SessionEvent[]): SessionEvent[] => [
  { type: 'SessionCreated', profile: 'default', protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
  { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: '[]' },
  { type: 'BlockAdded', id: 3, kind: 'Thinking', origin: 'model', content: 'hmm' },
  { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'let me look' },
  { type: 'BlockAdded', id: 5, kind: 'Tool Call', origin: 'model', content: 'ls' },
  { type: 'BlockAdded', id: 6, kind: 'Tool Result', origin: 'tool', content: 'a b', call: 5 },
  { type: 'BlockAdded', id: 7, kind: 'User', origin: 'user', content: 'go on' },
  ...then,
];
export const pending: SessionEvent = { type: 'BlockAdded', id: 8, kind: 'Tool Call', origin: 'model', content: 'pwd' };

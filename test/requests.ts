// Requests for backend tests: plain chat messages (no tools, one prefix per message), and a tool loop.
import { fold } from '../src/core/log/fold';
import { renderPrefixes, type Message, type Request } from '../src/core/render/native';
import { newSession } from '../src/core/session/session';

export const request = (messages: Message[]): Request => ({ messages, tools: [] });
export const prefixes = (messages: Message[]): Request[] => messages.map((_, i) => request(messages.slice(0, i + 1)));

// System, Tools, User, Assistant text with two Tool Calls, their two Tool Results.
export const toolLoop = (): Request[] =>
  renderPrefixes(
    fold([
      ...newSession('default', 'You are an agent.'),
      { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'look around' },
      { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Checking.' },
      { type: 'BlockAdded', id: 5, kind: 'Tool Call', origin: 'model', content: 'ls' },
      { type: 'BlockAdded', id: 6, kind: 'Tool Call', origin: 'model', content: 'pwd' },
      { type: 'BlockAdded', id: 7, kind: 'Tool Result', origin: 'tool', content: 'a b\n[exit 0]', call: 5 },
      { type: 'BlockAdded', id: 8, kind: 'Tool Result', origin: 'tool', content: '/p\n[exit 0]', call: 6 },
    ]),
  );

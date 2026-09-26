// Requests for backend tests: plain chat messages (no tools, one prefix per message), and a tool loop.
import type { SessionEvent } from '../src/core/log/events';
import { fold } from '../src/core/log/fold';
import { renderPrefixes, type Message, type Request } from '../src/core/render/native';
import { newSession } from '../src/core/session/session';
import { toggleTool, TOOLS } from '../src/core/toolcall/bash';

// A Tools Block of bash only: fixtures whose token counts do not follow the default tools.
export const BASH_TOOLS = (toggleTool(TOOLS, 'question') as { content: string }).content;
// A new session's events with `tools` as its Tools Block.
export const withTools = (events: SessionEvent[], tools: string): SessionEvent[] =>
  events.map(e => (e.type === 'BlockAdded' && e.kind === 'Tools' ? { ...e, content: tools } : e));

export const request = (messages: Message[]): Request => ({ messages, tools: [] });
export const prefixes = (messages: Message[]): Request[] => messages.map((_, i) => request(messages.slice(0, i + 1)));

// System, Tools, User, Assistant text with two Tool Calls, their two Tool Results.
export const toolLoop = (): Request[] =>
  renderPrefixes(
    fold([
      ...withTools(newSession('default', 'You are an agent.'), BASH_TOOLS),
      { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'look around' },
      { type: 'BlockAdded', id: 4, kind: 'Assistant', origin: 'model', content: 'Checking.' },
      { type: 'BlockAdded', id: 5, kind: 'Tool Call', origin: 'model', content: 'ls' },
      { type: 'BlockAdded', id: 6, kind: 'Tool Call', origin: 'model', content: 'pwd' },
      { type: 'BlockAdded', id: 7, kind: 'Tool Result', origin: 'tool', content: 'a b\n[exit 0]', call: 5 },
      { type: 'BlockAdded', id: 8, kind: 'Tool Result', origin: 'tool', content: '/p\n[exit 0]', call: 6 },
    ]),
  );

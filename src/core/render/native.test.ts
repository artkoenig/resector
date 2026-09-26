import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { fold } from '../log/fold';
import { TOOLS } from '../toolcall/bash';
import { renderNative, renderPrefixes } from './native';

const created: SessionEvent = { type: 'SessionCreated', profile: 'default', protocol: 'native' };
const add = (id: number, kind: Extract<SessionEvent, { type: 'BlockAdded' }>['kind'], content: string, call?: number): SessionEvent =>
  ({ type: 'BlockAdded', id, kind, origin: 'user', content, ...(call !== undefined && { call }) });
const BASH = { type: 'function' as const, function: JSON.parse(TOOLS)[0] };

test('each block becomes one chat message with its role', () => {
  const context = fold([
    created,
    add(1, 'System', 'sys'),
    add(2, 'User', 'hi'),
    { type: 'BlockAdded', id: 3, kind: 'Assistant', origin: 'model', content: 'hello', cutOff: true },
  ]);
  expect(renderNative(context)).toEqual({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    tools: [],
  });
});

test('removed blocks are not sent; a bottom pin is sent as a user-role Note at the very end', () => {
  const context = fold([
    created,
    add(1, 'System', 'sys'),
    add(2, 'User', 'hi'),
    add(3, 'Assistant', 'rules'),
    add(4, 'User', 'gone'),
    { type: 'Pin', id: 3, at: 'bottom' },
    { type: 'Remove', id: 4 },
  ]);
  expect(renderNative(context).messages).toEqual([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'user', content: 'rules' },
  ]);
});

const loop = [
  created,
  add(1, 'System', 'sys'),
  add(2, 'Tools', TOOLS),
  add(3, 'User', 'look'),
  add(4, 'Assistant', 'checking'),
  add(5, 'Tool Call', 'ls'),
  add(6, 'Tool Call', 'pwd'),
  add(7, 'Tool Result', 'a b', 5),
  add(8, 'Tool Result', '/p', 6),
];
// Call ids number the calls of their assistant message.
const call = (index: number, command: string) => ({ id: `call_${index}`, type: 'function' as const, function: { name: 'bash', arguments: JSON.stringify({ command }) } });

test('the Tools Block goes into the tools field; Assistant text and its Tool Calls merge into one message (FR-12)', () => {
  expect(renderNative(fold(loop))).toEqual({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'look' },
      { role: 'assistant', content: 'checking', tool_calls: [call(0, 'ls'), call(1, 'pwd')] },
      { role: 'tool', tool_call_id: 'call_0', content: 'a b' },
      { role: 'tool', tool_call_id: 'call_1', content: '/p' },
    ],
    tools: [BASH],
  });
});

test('a Tool Call without Assistant text, or after a Tool Result, starts its own assistant message', () => {
  const context = fold([created, add(1, 'User', 'go'), add(2, 'Tool Call', 'ls'), add(3, 'Tool Result', 'x', 2), add(4, 'Tool Call', 'pwd')]);
  expect(renderNative(context).messages).toEqual([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [call(0, 'ls')] },
    { role: 'tool', tool_call_id: 'call_0', content: 'x' },
    { role: 'assistant', content: '', tool_calls: [call(0, 'pwd')] },
  ]);
});

test('an Assistant block after a Tool Call starts a new message; a bottom-pinned Tool Call is a user-role Note', () => {
  const context = fold([created, add(1, 'Tool Call', 'ls'), add(2, 'Assistant', 'done'), add(3, 'Tool Call', 'pwd'), { type: 'Pin', id: 3, at: 'bottom' }]);
  expect(renderNative(context).messages).toEqual([
    { role: 'assistant', content: '', tool_calls: [call(0, 'ls')] },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'pwd' },
  ]);
});

test('prefixes: the request as the first 1, 2, … sent blocks render it, for per-block tokens', () => {
  const prefixes = renderPrefixes(fold(loop));
  expect(prefixes).toHaveLength(8);
  expect(prefixes[0]).toEqual({ messages: [{ role: 'system', content: 'sys' }], tools: [] });
  expect(prefixes[1]).toEqual({ messages: [{ role: 'system', content: 'sys' }], tools: [BASH] });
  expect(prefixes[4]!.messages.at(-1)).toEqual({ role: 'assistant', content: 'checking', tool_calls: [call(0, 'ls')] });
  expect(prefixes[7]).toEqual(renderNative(fold(loop)));
});

test('an empty Context renders an empty request', () => {
  expect(renderNative(fold([created]))).toEqual({ messages: [], tools: [] });
  expect(renderPrefixes(fold([created]))).toEqual([]);
});

test('a Note from a Tool Pair is a user message, never tool syntax; the other calls keep theirs', () => {
  const context = fold([...loop, { type: 'PairToNote', id: 9, call: 5 }]);
  expect(renderNative(context).messages.slice(1)).toEqual([
    { role: 'user', content: 'look' },
    { role: 'assistant', content: 'checking', tool_calls: [call(0, 'pwd')] },
    { role: 'tool', tool_call_id: 'call_0', content: '/p' },
    { role: 'user', content: '[Tool bash: ls]\na b' },
  ]);
});

test('a Thinking block is the reasoning_content of its answer: text and Tool Calls join its message (FR-47)', () => {
  const context = fold([
    created,
    add(1, 'User', 'hi'),
    add(2, 'Thinking', 'plan'),
    add(3, 'Assistant', 'Looking.'),
    add(4, 'Tool Call', 'ls'),
    add(5, 'Tool Result', 'a', 4),
    add(6, 'Thinking', 'next'),
    add(7, 'Tool Call', 'pwd'),
    add(8, 'Tool Result', '/p', 7),
    add(9, 'Thinking', 'cut'),
  ]);
  const call = (command: string) => ({ id: 'call_0', type: 'function' as const, function: { name: 'bash', arguments: JSON.stringify({ command }) } });
  expect(renderNative(context).messages).toEqual([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Looking.', reasoning_content: 'plan', tool_calls: [call('ls')] },
    { role: 'tool', tool_call_id: 'call_0', content: 'a' },
    { role: 'assistant', content: '', reasoning_content: 'next', tool_calls: [call('pwd')] },
    { role: 'tool', tool_call_id: 'call_0', content: '/p' },
    { role: 'assistant', content: '', reasoning_content: 'cut' },
  ]);
});

test('an Assistant block after anything but its Thinking block starts its own message', () => {
  const context = fold([
    created,
    add(1, 'Assistant', 'first'),
    add(2, 'Thinking', 'plan'),
    add(3, 'User', 'moved here'),
    add(4, 'Assistant', 'text'),
    add(5, 'Thinking', 'again'),
    add(6, 'Assistant', 'joined'),
    add(7, 'Assistant', 'own'),
    add(8, 'Thinking', 'call'),
    add(9, 'Tool Call', 'ls'),
    add(10, 'Assistant', 'after call'),
  ]);
  expect(renderNative(context).messages).toEqual([
    { role: 'assistant', content: 'first' },
    { role: 'assistant', content: '', reasoning_content: 'plan' },
    { role: 'user', content: 'moved here' },
    { role: 'assistant', content: 'text' },
    { role: 'assistant', content: 'joined', reasoning_content: 'again' },
    { role: 'assistant', content: 'own' },
    { role: 'assistant', content: '', reasoning_content: 'call', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'assistant', content: 'after call' },
  ]);
});

test('thinking set at the Gate goes into every prefix; without it the backend sends the profile thinking (FR-49)', () => {
  const events: SessionEvent[] = [created, add(1, 'System', 'sys'), add(2, 'User', 'hi')];
  expect(renderPrefixes(fold(events)).map(r => r.thinking)).toEqual([undefined, undefined]);
  const set = renderPrefixes(fold([...events, { type: 'ThinkingSet', thinking: 'medium' }]));
  expect(set.map(r => r.thinking)).toEqual(['medium', 'medium']);
});

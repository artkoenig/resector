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

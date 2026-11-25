// Tests for waiting on the terminal's answers before quitting.
import { expect, test } from 'bun:test';
import { terminalSettled, type Settling } from './settle';

function fakeTerminal() {
  const handlers: ((sequence: string) => boolean)[] = [];
  const written: string[] = [];
  const terminal: Settling = {
    write: text => void written.push(text),
    prependInputHandler: handler => void handlers.unshift(handler),
    removeInputHandler: handler => void handlers.splice(handlers.indexOf(handler), 1),
  };
  // True when a handler took the sequence.
  const receive = (sequence: string) => handlers.some(h => h(sequence));
  return { terminal, written, handlers, receive };
}

test('settles once the terminal reports its status, after the answers asked for before', async () => {
  const { terminal, written, handlers, receive } = fakeTerminal();
  let settled = false;
  const waiting = terminalSettled(terminal).then(() => void (settled = true));
  expect(written).toEqual(['\x1b[5n']);
  // A late answer to a startup query is left to the renderer.
  expect(receive('\x1b[?2026;2$y')).toBe(false);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(receive('\x1b[0n')).toBe(true);
  await waiting;
  expect(handlers).toEqual([]);
});

test('settles after the timeout when the terminal does not answer', async () => {
  const { terminal, handlers } = fakeTerminal();
  await terminalSettled(terminal, 10);
  expect(handlers).toEqual([]);
});

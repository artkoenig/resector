import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { exitNoteText, exitOf, owedExitNotes } from './background';

const call = (id: number, content: string): SessionEvent => ({ type: 'BlockAdded', id, kind: 'Tool Call', origin: 'model', content, background: true });
const started = (c: number, pid: number): SessionEvent => ({ type: 'BackgroundStarted', call: c, pid, log: `/logs/${pid}.log` });

test('an exit belongs to the Background Process running with that pid; none running: nothing', () => {
  const events = [call(4, 'serve'), started(4, 42)];
  expect(exitOf(events, 42, { exit: 0 })).toEqual({ type: 'BackgroundExited', call: 4, exit: 0 });
  expect(exitOf(events, 7, { exit: 0 })).toBeNull();
  expect(exitOf([...events, { type: 'BackgroundExited', call: 4, exit: 0 }], 42, { exit: 1 })).toBeNull();
});

test('a reused pid is the later process', () => {
  const events = [call(4, 'a'), started(4, 42), { type: 'BackgroundExited' as const, call: 4, exit: 0 }, call(6, 'b'), started(6, 42)];
  expect(exitOf(events, 42, { signal: 'SIGTERM' })).toEqual({ type: 'BackgroundExited', call: 6, signal: 'SIGTERM' });
});

test('every logged exit without its Note is owed one, in order; the command is the one that ran', () => {
  const events: SessionEvent[] = [
    call(4, 'serve'), started(4, 42), call(6, 'watch'), { type: 'Edit', id: 6, revision: 2, content: 'watch -v' }, started(6, 43),
    { type: 'Edit', id: 6, revision: 3, content: 'later' }, { type: 'BackgroundExited', call: 6, signal: 'user' },
    { type: 'BackgroundExited', call: 4, exit: 2 },
  ];
  expect(owedExitNotes(events)).toEqual([
    { exited: 6, content: 'Background Process pid 43 ended: stopped by the user\ncommand: watch -v\nlog: /logs/43.log' },
    { exited: 4, content: 'Background Process pid 42 ended: exited with 2\ncommand: serve\nlog: /logs/42.log' },
  ]);
  const noted: SessionEvent = { type: 'BlockAdded', id: 9, kind: 'Note', origin: 'background', content: '…', exited: 6 };
  expect(owedExitNotes([...events, noted]).map(n => n.exited)).toEqual([4]);
});

test('no content of the call before its start: no command; an exit without its start: no Note', () => {
  const events: SessionEvent[] = [started(4, 42), { type: 'BackgroundExited', call: 4, exit: 0 }, { type: 'BackgroundExited', call: 5, exit: 0 }];
  expect(owedExitNotes(events)).toEqual([{ exited: 4, content: 'Background Process pid 42 ended: exited with 0\ncommand: \nlog: /logs/42.log' }]);
});

test('the Note says why it ended', () => {
  const text = (end: Parameters<typeof exitNoteText>[1]) => exitNoteText({ pid: 1, log: 'l', command: 'c' }, end).split('\n')[0];
  expect([{ exit: 0 }, { signal: 'SIGKILL' }, { signal: 'session ended' }, { signal: 'user' }, { signal: 'orphaned' }].map(text)).toEqual([
    'Background Process pid 1 ended: exited with 0',
    'Background Process pid 1 ended: killed by SIGKILL',
    'Background Process pid 1 ended: stopped when the session ended',
    'Background Process pid 1 ended: stopped by the user',
    'Background Process pid 1 ended: killed after resector stopped unexpectedly',
  ]);
});

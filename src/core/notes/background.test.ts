import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { endedBy, exitNoteText, exitOf, owedExitNotes, runningSubagents } from './background';

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

test('endedBy: whether resector ended the process for that reason', () => {
  expect(endedBy({ signal: 'user' }, 'user')).toBe(true);
  expect(endedBy({ signal: 'session ended' }, 'user')).toBe(false);
  expect(endedBy({ signal: 'session ended' }, 'session ended')).toBe(true);
  expect(endedBy({ exit: 0 }, 'user')).toBe(false);
  // An end without a signal names none, not even undefined.
  expect(endedBy({ exit: 0 }, undefined as never)).toBe(false);
});

test('a Subagent\'s Note is made of its report and the prompt it was started with', () => {
  const report = { session: 'ses_a', turns: 2, tokens: 500, outcome: 'answer' as const, text: 'all done' };
  const subagent = (id: number, content: string): SessionEvent => ({ type: 'BlockAdded', id, kind: 'Tool Call', origin: 'model', tool: 'subagent', content });
  const start = (call: number, pid: number): SessionEvent => ({ type: 'BackgroundStarted', call, pid, log: `/logs/${pid}.log` });
  const events: SessionEvent[] = [
    subagent(4, 'look'), start(4, 42), { type: 'BackgroundExited', call: 4, exit: 0, report },
    { type: 'BlockAdded', id: 6, kind: 'Tool Call', origin: 'model', tool: 'bash', content: 'serve' }, start(6, 43), { type: 'BackgroundExited', call: 6, exit: 0 },
    subagent(8, 'search'), start(8, 44), { type: 'BackgroundExited', call: 8, signal: 'user', report: { ...report, outcome: 'aborted', text: '' } },
  ];
  expect(owedExitNotes(events).map(n => n.content)).toEqual([
    'Subagent pid 42 ended: answer · 2 turns · 500 tokens\nprompt: look\nsession: ses_a · log: /logs/42.log\n\nall done',
    'Background Process pid 43 ended: exited with 0\ncommand: serve\nlog: /logs/43.log',
    'Subagent pid 44 ended: stopped by the user · 2 turns · 500 tokens\nprompt: search\nsession: ses_a · log: /logs/44.log',
  ]);
});

test('the running Subagents are the started subagent calls without an exit', () => {
  const call = (id: number, tool?: 'subagent') => ({ type: 'BlockAdded' as const, id, kind: 'Tool Call' as const, origin: 'model' as const, content: 'x', ...(tool && { tool }) });
  const started = (call: number) => ({ type: 'BackgroundStarted' as const, call, pid: call, log: '' });
  const events: SessionEvent[] = [call(1, 'subagent'), call(2, 'subagent'), call(3), call(4, 'subagent'), started(1), started(2), started(3), { type: 'BackgroundExited', call: 2, signal: 'user' }];
  expect(runningSubagents(events)).toBe(1);
  expect(runningSubagents([...events, started(4)])).toBe(2);
  expect(runningSubagents([])).toBe(0);
  const otherEvent = { type: 'Edited', id: 5, tool: 'subagent' } as unknown as SessionEvent;
  expect(runningSubagents([otherEvent, started(5)])).toBe(0);
});

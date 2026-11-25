import { expect, test } from 'bun:test';
import type { SubagentReport } from '../log/events';
import { DEFAULT_SUMMARY_PROMPT, subagentNoteText } from './subagent';

const start = { pid: 42, log: '/l/42.log', prompt: '\nFind the call sites.\nAll of them.' };
const base = { session: 'ses_a', turns: 6, tokens: 18200 };
const note = (reason: string, signalled: boolean, report?: SubagentReport) => subagentNoteText(start, reason, signalled, report);
const head = (ended: string) => `Subagent pid 42 ended: ${ended}\nprompt: Find the call sites.\nsession: ses_a · log: /l/42.log`;

test('answer, max-turns: the head and the whole summary', () => {
  const summary = `found:\n${'- a line of the summary\n'.repeat(500)}done`;
  expect(note('exited with 0', false, { ...base, outcome: 'answer', text: summary })).toBe(`${head('answer · 6 turns · 18.2k tokens')}\n\n${summary}`);
  expect(note('exited with 1', false, { ...base, turns: 1, outcome: 'max-turns', text: 'open: all' })).toBe(`${head('max-turns · 1 turn · 18.2k tokens')}\n\nopen: all`);
});

test('error: the head and the status text', () => {
  expect(note('exited with 1', false, { ...base, outcome: 'error', text: 'backend error: gone' })).toBe(`${head('error · 6 turns · 18.2k tokens')}\n\nbackend error: gone`);
});

test('kill: the head says who or what ended it', () => {
  const ended = head('stopped by the user · 6 turns · 18.2k tokens');
  expect(note('stopped by the user', true, { ...base, outcome: 'aborted' })).toBe(ended);
  // Killed before it could say so itself.
  expect(note('stopped by the user', true, base)).toBe(ended);
  expect(note('exited with 143', false, { ...base, outcome: 'aborted' })).toBe(head('aborted · 6 turns · 18.2k tokens'));
});

test('killed only after its run had ended: its Outcome and summary', () => {
  expect(note('stopped by the user', true, { ...base, outcome: 'answer', text: 'done' })).toBe(`${head('answer · 6 turns · 18.2k tokens')}\n\ndone`);
});

test('without a report, or one without a Session: only what is known', () => {
  expect(note('exited with 2', false)).toBe('Subagent pid 42 ended: exited with 2\nprompt: Find the call sites.\nlog: /l/42.log');
  expect(note('exited with 1', false, { turns: 0, tokens: 0, outcome: 'error', text: 'no config' }))
    .toBe('Subagent pid 42 ended: error · 0 turns · 0 tokens\nprompt: Find the call sites.\nlog: /l/42.log\n\nno config');
});

test('a long first line of the prompt is cut', () => {
  const prompt = (text: string) => subagentNoteText({ ...start, prompt: text }, 'r', false).split('\n')[1];
  expect(prompt('x'.repeat(70))).toBe(`prompt: ${'x'.repeat(70)}`);
  expect(prompt('x'.repeat(71))).toBe(`prompt: ${'x'.repeat(69)}…`);
});

test('the built-in summary prompt asks what was done, found and is open, for files and commits', () => {
  for (const asked of ['done', 'found', 'open', 'files touched', 'commits', 'text only']) expect(DEFAULT_SUMMARY_PROMPT).toContain(asked);
});

test('a worktree left at the end: the head names it and its branch, and says when it has uncommitted changes', () => {
  const worktree = { path: '/data/worktrees/ses_a', branch: 'resector/ses_a', base: 'abc' };
  const report: SubagentReport = { ...base, outcome: 'answer', text: 'done' };
  const ended = head('answer · 6 turns · 18.2k tokens');
  const text = (left?: { dirty: boolean }) => subagentNoteText({ ...start, worktree }, 'exited with 0', false, report, left);
  expect(text({ dirty: false })).toBe(`${ended}\nworktree: /data/worktrees/ses_a · branch: resector/ses_a\n\ndone`);
  expect(text({ dirty: true })).toBe(`${ended}\nworktree: /data/worktrees/ses_a · branch: resector/ses_a · uncommitted changes\n\ndone`);
  // Removed as empty: none to name.
  expect(text()).toBe(`${ended}\n\ndone`);
});

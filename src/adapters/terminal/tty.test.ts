// The terminal of a Headless Run: Tool Approval and Questions asked, answered line by line.
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Block } from '../../core/log/fold';
import type { Verdict } from '../../core/approval/approval';
import { openTty, ttyTerminal } from './tty';

// A terminal reading the given lines in turn, then EOF; out: all it wrote.
function fake(lines: string[]) {
  let out = '';
  const terminal = ttyTerminal({ write: text => void (out += text), read: async () => lines.shift() ?? null }, false);
  return { terminal, out: () => out };
}

const call = { id: 3, kind: 'Tool Call', origin: 'model', content: 'touch x && ls', cutOff: false } as Block;
const verdict: Verdict = {
  action: 'ask',
  checks: [
    { text: 'touch x', action: 'ask', why: 'no rule → default ask', unallowable: false },
    { text: 'ls', action: 'allow', why: 'built-in rule "ls *"', unallowable: false },
  ],
};
const signal = new AbortController().signal;
const QUESTION = { question: 'Which one?', header: 'pick', options: [{ label: 'a', description: 'A' }, { label: 'b', description: 'B' }], recommended: 'b' };

test('Tool Approval shows each sub-command with its verdict and reason, then takes y, a or n', async () => {
  const once = fake(['y']);
  expect(await once.terminal.approve(call, verdict, signal)).toBe('once');
  expect(once.out()).toBe('? approve touch x && ls\n  ? touch x (no rule → default ask)\n  ✓ ls (built-in rule "ls *")\n  y run once · a allow for session · n reject › ');
  expect(await fake(['a']).terminal.approve(call, verdict, signal)).toBe('session');
  expect(await fake([' N ']).terminal.approve(call, verdict, signal)).toBe('reject');
});

test('Tool Approval asks again on other input; at EOF the call is rejected', async () => {
  const again = fake(['yes please', 'y']);
  expect(await again.terminal.approve(call, verdict, signal)).toBe('once');
  expect(again.out().split('reject › ')).toHaveLength(3);
  const ended = fake([]);
  expect(await ended.terminal.approve(call, verdict, signal)).toBe('reject');
  expect(ended.out()).toEndWith('reject › \n');
});

test('a Question numbers its options, Recommended first; a number, free text, empty or - answers it', async () => {
  const shown = fake(['2']);
  expect(await shown.terminal.answer([QUESTION], signal)).toEqual([['a']]);
  expect(shown.out()).toBe('? Which one?\n  1. b (Recommended) – B\n  2. a – A\n  number, or your own answer (empty: recommended, - skip) › ');
  expect(await fake(['', 'neither', '-', ' 1 ']).terminal.answer([QUESTION, QUESTION, QUESTION, QUESTION], signal)).toEqual([['b'], ['neither'], [], ['b']]);
});

test('a Question with several answers takes numbers separated by commas; EOF declines it as a whole', async () => {
  const several = { ...QUESTION, multiple: true, recommended: ['a', 'b'] };
  expect(await fake(['2, 1', '']).terminal.answer([several, several], signal)).toEqual([['b', 'a'], ['a', 'b']]);
  expect(await fake(['1']).terminal.answer([QUESTION, QUESTION], signal)).toBeNull();
});

test('a terminal that cannot be opened is none; a file is read line by line, an EOF answers no more than the one asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resector-tty-'));
  expect(openTty(join(dir, 'gone'))).toBeNull();
  writeFileSync(join(dir, 'tty'), 'n\ny\n');
  const tty = openTty(join(dir, 'tty'))!;
  expect([await tty.terminal.approve(call, verdict, signal), await tty.terminal.approve(call, verdict, signal), await tty.terminal.approve(call, verdict, signal)]).toEqual(['reject', 'once', 'reject']);
  tty.close();
  const aborted = AbortSignal.abort();
  writeFileSync(join(dir, 'later'), 'y\n');
  const later = openTty(join(dir, 'later'))!;
  expect(await later.terminal.approve(call, verdict, aborted)).toBe('reject');
  expect(await later.terminal.approve(call, verdict, signal)).toBe('once');
  later.close();
});

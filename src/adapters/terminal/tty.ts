// The terminal of a Headless Run: Tool Approval and Questions asked on stderr, answered from /dev/tty, since stdin may
// carry the prompt.
import { closeSync, openSync, read } from 'node:fs';
import type { Action, Verdict } from '../../core/approval/approval';
import type { Block } from '../../core/log/fold';
import { orderedOptions, isRecommended, type Answer, type Question } from '../../core/tools/question';
import type { Terminal } from '../../gate/ports';

// read: the next line, null at EOF (Ctrl-D) or once signal is aborted.
export type TtyIo = { write(text: string): void; read(signal: AbortSignal): Promise<string | null> };

const CHOICES = { y: 'once', a: 'session', n: 'reject' } as const;

export function ttyTerminal(io: TtyIo, color: boolean): Terminal {
  const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = paint('1');
  const dim = paint('2');
  const yellow = paint('33');
  const magenta = paint('35');
  const mark: Record<Action, string> = { allow: paint('32')('✓'), ask: yellow('?'), deny: paint('31')('✗') };

  async function approve(call: Block, verdict: Verdict, signal: AbortSignal) {
    io.write(`${yellow('?')} ${bold('approve')} ${call.content}\n`);
    io.write(verdict.checks.map(c => `  ${mark[c.action]} ${c.text} ${dim(`(${c.why})`)}\n`).join(''));
    for (;;) {
      io.write(`  ${yellow('y')} run once · ${yellow('a')} allow for session · ${yellow('n')} reject › `);
      const line = await io.read(signal);
      if (line === null) {
        io.write('\n');
        return 'reject';
      }
      const choice = CHOICES[line.trim().toLowerCase() as keyof typeof CHOICES];
      if (choice) return choice;
    }
  }

  async function answer(questions: Question[], signal: AbortSignal): Promise<Answer[] | null> {
    const answers: Answer[] = [];
    for (const q of questions) {
      const options = orderedOptions(q);
      io.write(`${magenta('?')} ${bold(q.question)}\n`);
      io.write(options.map((o, i) => `  ${i + 1}. ${o.label}${isRecommended(q, o) ? ' (Recommended)' : ''} – ${o.description}\n`).join(''));
      io.write(`  ${q.multiple ? 'numbers' : 'number'}, or your own answer (empty: recommended, - skip) › `);
      const line = await io.read(signal);
      if (line === null) {
        io.write('\n');
        return null;
      }
      answers.push(answerOf(line.trim(), q));
    }
    return answers;
  }

  return { approve, answer };
}

// Numbers pick options (several, comma-separated, when the question allows), anything else is the answer itself.
function answerOf(line: string, q: Question): Answer {
  if (!line) return [q.recommended].flat();
  if (line === '-') return [];
  const options = orderedOptions(q);
  const picked = line.split(',').map(n => options[Number(n.trim()) - 1]?.label);
  const numbers = /^\d+(\s*,\s*\d+)*$/.test(line) && (q.multiple || picked.length === 1) && picked.every(l => l !== undefined);
  return numbers ? (picked as string[]) : [line];
}

// The terminal at path, asking on stderr; null when it cannot be opened (no terminal: nobody is asked). It is read
// only while asking: a run in the background is not stopped for reading, and an EOF (Ctrl-D) ends that answer only.
export function openTty(path = '/dev/tty'): { terminal: Terminal; close(): void } | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  // What was read past the line asked for (a paste, a file): the next answers.
  let rest = '';
  let pending: Promise<string | null> | null = null;
  const chunk = () =>
    (pending ??= new Promise(resolve =>
      read(fd, Buffer.alloc(4096), 0, 4096, null, (error, n, buffer) => {
        pending = null;
        resolve(error || !n ? null : buffer.toString('utf8', 0, n));
      }),
    ));
  async function line(): Promise<string | null> {
    for (;;) {
      const at = rest.indexOf('\n');
      if (at >= 0) {
        const found = rest.slice(0, at);
        rest = rest.slice(at + 1);
        return found;
      }
      const more = await chunk();
      if (more === null) {
        const last = rest;
        rest = '';
        return last || null;
      }
      rest += more;
    }
  }
  // An aborted run ends: a line read after it is not wanted.
  const until = (signal: AbortSignal) =>
    signal.aborted ? Promise.resolve(null) : Promise.race([line(), new Promise<null>(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }))]);
  const write = (text: string) => void process.stderr.write(text);
  return { terminal: ttyTerminal({ write, read: until }, !!process.stderr.isTTY), close: () => closeSync(fd) };
}

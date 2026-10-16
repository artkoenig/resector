// --show on stderr: one prefixed line per event of the chosen kinds, Thinking streamed, statuses. Text only; run.ts
// writes it.
import type { Shown } from '../core/config/config';
import type { SessionEvent } from '../core/log/events';
import { resultEnd } from '../core/tools/call';
import type { Status } from '../gate';
import { count } from '../gate/text';

// Tool Result lines shown before `… N more lines`.
const RESULT_LINES = 3;
// A note's first line, of a Note or a policy's, is cut to this many characters.
const NOTE_WIDTH = 80;
const headline = (text: string) => {
  const line = text.split('\n')[0]!;
  return line.length > NOTE_WIDTH ? `${line.slice(0, NOTE_WIDTH - 1)}…` : line;
};

export function createShow(kinds: Shown[], color: boolean) {
  const on = new Set(kinds);
  const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = paint('2');
  const cyan = paint('36');
  // The Thinking printed so far of the answer streaming; open: its last line awaits more.
  let printed = '';
  let open = false;
  // Other lines start on a line of their own; the Thinking goes on after a new ∴.
  const lines = (...ls: string[]) => (ls.length ? close() + ls.map(l => `${l}\n`).join('') : '');
  const close = () => (open ? ((open = false), '\n') : '');

  function event(e: SessionEvent): string {
    if (e.type === 'BlockAdded') return block(e);
    if (e.type === 'FileReferenced') return on.has('notes') ? lines(dim(`◆ @${e.file}`)) : '';
    const by = 'by' in e ? e.by : undefined;
    const operation = by && by !== 'user' && on.has('policy') ? operationText(e) : null;
    return operation ? lines(dim(`◆ ${by}: ${operation}`)) : '';
  }

  function block(e: Extract<SessionEvent, { type: 'BlockAdded' }>): string {
    if (e.kind === 'Tool Call' && on.has('tools')) return lines(`${cyan('$')} ${e.tool === 'search' ? `search ${e.content}` : e.content}`);
    if (e.kind === 'Tool Result' && on.has('tools')) return lines(...resultLines(e.content).map(dim));
    if (e.kind !== 'Note' || !on.has('notes')) return '';
    const more = e.content.split('\n').length - 1;
    return lines(dim(`◆ note: ${headline(e.content)}${more ? ` (+${count(more, 'line')})` : ''}`));
  }

  // The new part of the Thinking streaming, each line after ∴.
  function thinking(text: string): string {
    const fresh = text.slice(printed.length);
    if (!on.has('thinking') || !fresh) return '';
    printed = text;
    const start = open ? '' : dim('∴ ');
    open = true;
    return start + fresh.split('\n').map(dim).join(`\n${dim('∴ ')}`);
  }
  function end(): string {
    printed = '';
    return close();
  }

  // Errors end the run: the closing lines say them.
  const status = (s: Status) => (on.size && s.tone !== 'error' ? lines(dim(`· ${s.text}`)) : '');

  return { event, thinking, end, status };
}

// The output cut to its first lines, then how the run ended.
function resultLines(content: string): string[] {
  const { output, end } = resultEnd(content);
  const more = output.length - RESULT_LINES;
  return [...output.slice(0, RESULT_LINES).map(l => `  │ ${l}`), ...(more > 0 ? [`  │ … ${count(more, 'more line')}`] : []), ...(end ? [`  └ ${end}`] : [])];
}

const ids = (all: number[]) => all.map(id => `#${id}`).join(', ');

function operationText(e: SessionEvent): string | null {
  switch (e.type) {
    case 'Remove': return `remove ${ids([e.id, ...(e.others ?? [])])}`;
    case 'Compact': return `compact ${ids(e.sources)}`;
    case 'PairToNote': return `note #${e.call}`;
    case 'NoteAdded': return `note ${headline(e.content)}`;
    case 'Edit': return `edit #${e.id}`;
    case 'Move': return `move #${e.id}`;
    default: return null;
  }
}

// Reasoning inline in the answer text (architecture §4 "Thinking"): a backend without reasoning parser
// streams `<think>…</think>` before the answer.
const OPEN = '<think>';
const CLOSE = '</think>';

// The reasoning and the answer in the text streamed so far. While the text may still become `<think>`,
// or the tag is not closed yet, the answer has not started; `done`: the text is complete.
export function splitThinking(text: string, done = false): { thinking: string; content: string } {
  const start = text.trimStart();
  if (OPEN.startsWith(start)) return { thinking: '', content: done ? text : '' };
  if (!start.startsWith(OPEN)) return { thinking: '', content: text };
  const end = start.indexOf(CLOSE);
  if (end < 0) return { thinking: start.slice(OPEN.length).trimStart(), content: '' };
  return { thinking: start.slice(OPEN.length, end).trim(), content: start.slice(end + CLOSE.length).trimStart() };
}

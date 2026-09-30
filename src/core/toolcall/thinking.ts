// Reasoning inline in the answer text: a backend without reasoning parser
// streams `<think>…</think>` before the answer.
const OPEN = '<think>';
const CLOSE = '</think>';

// The reasoning and the answer in the text streamed so far. While the text may still become `<think>`,
// or the tag is not closed yet, the answer has not started; `done`: the text is complete.
export function splitThinking(text: string, done = false): { thinking: string; content: string } {
  const start = text.trimStart();
  if (OPEN.startsWith(start)) return { thinking: '', content: done ? text : '' };
  if (!start.startsWith(OPEN)) return { thinking: '', content: text };
  const inside = start.slice(OPEN.length);
  const end = inside.indexOf(CLOSE);
  if (end < 0) return { thinking: inside.trimStart(), content: '' };
  return { thinking: inside.slice(0, end).trim(), content: inside.slice(end + CLOSE.length).trimStart() };
}

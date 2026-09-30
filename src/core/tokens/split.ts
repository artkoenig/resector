// Tokens a Thinking block adds to its counted prefix and to the whole request; joined: the next
// block is part of the same message.
export type ThinkingShare = { step: number; prefix: number; request: number; joined: boolean };
export type PrefixCounts = { empty: number; prefixes: number[]; total: number; thinking?: ThinkingShare[] };
export type TokenSplit = { blocks: number[]; template: number; total: number };

// Per-block tokens via prefix differences: a block owns the tokens
// its message adds to the rendered prompt, role markers included. The Template row takes the rest
// (BOS, generation prompt), so the rows always sum to the exact request size.
export function splitTokens({ empty, prefixes, total, thinking = [] }: PrefixCounts): TokenSplit {
  let previous = empty;
  const blocks = prefixes.map(count => {
    const own = count - previous;
    previous = count;
    return own;
  });
  let template = total - previous + empty;
  for (const t of thinking) template -= ownThinking(blocks, t);
  return { blocks, template, total };
}

// A counted prefix ends before the last user message, so the chat template may render a Thinking block
// there that it drops in the request, or the other way round: the block owns what the request renders.
// One the template drops owns nothing; its role markers go to the block of its message after it, else
// to the Template row. Returns the tokens the block took from the Template row.
function ownThinking(blocks: number[], { step, prefix, request, joined }: ThinkingShare): number {
  blocks[step]! += request - prefix;
  if (request) return request - prefix;
  const markers = blocks[step]!;
  blocks[step] = 0;
  if (joined) blocks[step + 1]! += markers;
  return request - prefix - (joined ? 0 : markers);
}

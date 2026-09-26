// What a Thinking block's reasoning adds to its counted prefix and to the whole request (FR-48); joined:
// the next block is part of the same message.
export type Reasoning = { step: number; prefix: number; request: number; joined: boolean };
export type PrefixCounts = { empty: number; prefixes: number[]; total: number; reasoning?: Reasoning[] };
export type TokenSplit = { blocks: number[]; template: number; total: number };

// Per-block tokens via prefix differences (architecture §4 "Token counting"): a block owns the tokens
// its message adds to the rendered prompt, role markers included. The Template row takes the rest
// (BOS, generation prompt), so the rows always sum to the exact request size.
export function splitTokens({ empty, prefixes, total, reasoning = [] }: PrefixCounts): TokenSplit {
  let previous = empty;
  const blocks = prefixes.map(count => {
    const own = count - previous;
    previous = count;
    return own;
  });
  let template = total - previous + empty;
  for (const r of reasoning) template -= ownReasoning(blocks, r);
  return { blocks, template, total };
}

// A counted prefix ends before the last user message, so the chat template may render a reasoning there
// that it drops in the request, or the other way round: the Thinking block owns what the request renders.
// One the template drops owns nothing; its role markers go to the block of its message after it, else
// to the Template row. Returns the tokens the block took from the Template row.
function ownReasoning(blocks: number[], { step, prefix, request, joined }: Reasoning): number {
  blocks[step]! += request - prefix;
  if (request) return request - prefix;
  const markers = blocks[step]!;
  blocks[step] = 0;
  if (joined) blocks[step + 1]! += markers;
  return request - prefix - (joined ? 0 : markers);
}

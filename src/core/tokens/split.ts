export type PrefixCounts = { empty: number; prefixes: number[]; total: number };
export type TokenSplit = { blocks: number[]; template: number; total: number };

// Per-block tokens via prefix differences (architecture §4 "Token counting"): a block owns the tokens
// its message adds to the rendered prompt, role markers included. The Template row takes the rest
// (BOS, generation prompt), so the rows always sum to the exact request size.
export function splitTokens({ empty, prefixes, total }: PrefixCounts): TokenSplit {
  let previous = empty;
  const blocks = prefixes.map(count => {
    const own = count - previous;
    previous = count;
    return own;
  });
  return { blocks, template: total - previous + empty, total };
}

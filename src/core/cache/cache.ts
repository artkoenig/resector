// Prefix cache (architecture §4 "Prefix cache"): the server reuses the prompt up to the first element
// that differs from what it last processed; rows before that invalidation point are ●, from it on ○.

// Length of the common prefix of `a` and `b`: the index of the first differing element.
export function commonPrefix<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean = Object.is): number {
  let i = 0;
  while (i < a.length && i < b.length && same(a[i]!, b[i]!)) i++;
  return i;
}

// Per row (tokens in Context order): warm when all its tokens lie within the `cached` prompt tokens. A
// row of 0 tokens (a Thinking block the chat template drops, FR-48) is warm when the row after it is:
// the prompt differs from where it was.
export function warmRows(blocks: number[], cached: number): boolean[] {
  let end = 0;
  let warm = true;
  const rows = blocks.map(tokens => {
    end += tokens;
    warm &&= end <= cached;
    return warm;
  });
  for (let i = rows.length - 2; i >= 0; i--) if (blocks[i] === 0) rows[i] = rows[i + 1]!;
  return rows;
}

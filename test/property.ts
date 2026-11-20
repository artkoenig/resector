// Property-based testing without a dependency: generators draw from a stream of choices, a failing case shrinks
// by shortening and lowering that stream (Hypothesis style), so every generator shrinks for free.
// PROPERTY_SEED=<n> replays a run, PROPERTY_SEED=random explores new ones; PROPERTY_RUNS=<n> overrides the runs.

export type Gen<T> = (draw: Draw) => T;
// An integer in [0, bound): from the seeded random source, or replayed from recorded choices (0 past their end).
export type Draw = (bound: number) => number;

const UINT = 2 ** 32;
// mulberry32: small, seedable, good enough for test data.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT;
  };
}

const recording = (next: () => number, choices: number[]): Draw => bound => {
  const c = Math.floor(next() * bound);
  choices.push(c);
  return c;
};
const replaying = (choices: number[]): Draw => {
  let i = 0;
  return bound => (bound <= 0 ? 0 : Math.min(choices[i++] ?? 0, bound - 1));
};

// Generators: choice 0 is always the simplest value, which is where shrinking heads.
export const int = (min: number, max: number): Gen<number> => draw => min + draw(max - min + 1);
export const bool: Gen<boolean> = draw => draw(2) === 1;
export const pick = <T>(...values: T[]): Gen<T> => draw => values[draw(values.length)]!;
export const oneOf = <T>(...gens: Gen<T>[]): Gen<T> => draw => gens[draw(gens.length)]!(draw);
export const constant = <T>(value: T): Gen<T> => () => value;
export const map = <T, U>(gen: Gen<T>, f: (t: T) => U): Gen<U> => draw => f(gen(draw));
// One "more?" choice per element: deleting choices deletes elements. mean: the expected length below max.
export const array = <T>(item: Gen<T>, max = 12, mean = 3): Gen<T[]> => draw => {
  const items: T[] = [];
  while (items.length < max && draw(mean + 1) !== 0) items.push(item(draw));
  return items;
};
export const tuple = <T extends unknown[]>(...gens: { [K in keyof T]: Gen<T[K]> }): Gen<T> => draw => gens.map(g => g(draw)) as T;
export const record = <T extends object>(gens: { [K in keyof T]: Gen<T[K]> }): Gen<T> => draw =>
  Object.fromEntries(Object.entries(gens).map(([k, g]) => [k, (g as Gen<unknown>)(draw)])) as T;

// Characters that break naive code: separators, quotes, escapes, line breaks JSON keeps but JS once did not.
const CHARS = ['a', 'b', ' ', '\n', '\t', '\r', '"', "'", '\\', '/', '*', '[', ']', '{', '}', '$', '.', '-', '=', 'ä', '😀', ' ', '\0'];
export const string = (alphabet: string[] = CHARS, max = 16): Gen<string> => map(array(pick(...alphabet), max), cs => cs.join(''));

export type Options = { runs?: number; seed?: number };

function seedOf(fallback: number): number {
  const env = process.env.PROPERTY_SEED;
  if (env === 'random') return Math.floor(Math.random() * UINT);
  return env ? Number(env) : fallback;
}

// Runs the property on `runs` generated cases; it fails by throwing (expect) or returning false. On a failure, throws
// with the shrunk case, its error and the seed to replay it.
export function forAll<T>(gen: Gen<T>, property: (value: T) => void | boolean, { runs = 200, seed = 1 }: Options = {}): void {
  const start = seedOf(seed);
  const total = Number(process.env.PROPERTY_RUNS ?? runs);
  const next = random(start);
  for (let run = 0; run < total; run++) {
    const choices: number[] = [];
    const value = gen(recording(next, choices));
    if (failure(property, value) === null) continue;
    const shrunk = shrink(gen, property, choices);
    const smallest = gen(replaying(shrunk));
    const error = failure(property, smallest)!;
    throw new Error(`property failed (seed ${start}, run ${run + 1}) for\n${show(smallest)}\n${error}`);
  }
}

function failure<T>(property: (value: T) => void | boolean, value: T): string | null {
  try {
    return property(value) === false ? 'returned false' : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const show = (value: unknown) => JSON.stringify(value, (_, v) => (v instanceof Set ? [...v] : v), 2) ?? String(value);

// Greedy: delete chunks of choices, then lower single ones, while the case still fails; repeat until nothing helps.
function shrink<T>(gen: Gen<T>, property: (value: T) => void | boolean, choices: number[]): number[] {
  const fails = (cs: number[]) => failure(property, gen(replaying(cs))) !== null;
  let best = choices;
  for (let improved = true; improved; ) {
    improved = false;
    for (const size of [8, 4, 3, 2, 1]) {
      for (let i = 0; i + size <= best.length; ) {
        const candidate = [...best.slice(0, i), ...best.slice(i + size)];
        if (fails(candidate)) [best, improved] = [candidate, true];
        else i++;
      }
    }
    for (let i = 0; i < best.length; i++) {
      for (const lower of [0, best[i]! >> 1, best[i]! - 1]) {
        if (lower < 0 || lower >= best[i]!) continue;
        const candidate = best.with(i, lower);
        if (fails(candidate)) [best, improved] = [candidate, true];
      }
    }
  }
  return best;
}

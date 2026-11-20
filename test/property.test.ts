import { expect, test } from 'bun:test';
import { array, forAll, int, string } from './property';

test('a property that holds passes every run', () => {
  let runs = 0;
  forAll(int(0, 9), n => {
    runs++;
    return n >= 0 && n <= 9;
  }, { runs: 50 });
  expect(runs).toBe(50);
});

test('a failing case shrinks to the smallest one that still fails', () => {
  expect(() => forAll(array(int(0, 100)), xs => xs.every(x => x < 50))).toThrow(/for\n\[\n  50\n\]\nreturned false/);
});

test('a thrown error is reported with the seed that replays it', () => {
  expect(() => forAll(string(), s => expect(s).not.toContain('\n'), { seed: 7 })).toThrow(/seed 7, run \d+\)[\s\S]*"\\n"/);
});

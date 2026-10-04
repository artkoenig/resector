import { expect, test } from 'bun:test';
import { BUILT_IN, DEFAULT_POLICY } from './built-in';
import guidedCompaction from './guided-compaction';
import leanCompact from './lean-compact';

test('lean-compact and guided-compaction are built in, with their descriptions; lean-compact is on by default', () => {
  expect(BUILT_IN).toEqual([
    { name: 'lean-compact', run: leanCompact, description: 'drops reads and short thinking, compacts at ½' },
    { name: 'guided-compaction', run: guidedCompaction, description: 'compacts at ½, keeps the reads the model asks for' },
  ]);
  expect(DEFAULT_POLICY).toBe('lean-compact');
});

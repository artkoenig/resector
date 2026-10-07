import { expect, test } from 'bun:test';
import { BUILT_IN, DEFAULT_POLICY } from './built-in';
import guidedCompaction from './guided-compaction';
import leanCompact from './lean-compact';
import summaryReset from './summary-reset';

test('lean-compact, guided-compaction and summary-reset are built in, with their descriptions; summary-reset is on by default', () => {
  expect(BUILT_IN).toEqual([
    { name: 'lean-compact', run: leanCompact, description: 'drops reads and short thinking, compacts at ½' },
    { name: 'guided-compaction', run: guidedCompaction, description: 'compacts at ½, keeps the reads the model asks for' },
    { name: 'summary-reset', run: summaryReset, description: 'errors tool calls once the work takes ½, keeps only the summary the model writes' },
  ]);
  expect(DEFAULT_POLICY).toBe('summary-reset');
});

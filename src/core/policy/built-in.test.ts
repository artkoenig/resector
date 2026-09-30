import { expect, test } from 'bun:test';
import { BUILT_IN, DEFAULT_POLICY } from './built-in';
import leanCompact from './lean-compact';

test('lean-compact is the one built-in policy, with its description, and on by default', () => {
  expect(BUILT_IN).toEqual([{ name: 'lean-compact', run: leanCompact, description: 'drops reads and short thinking, compacts at ½' }]);
  expect(DEFAULT_POLICY).toBe('lean-compact');
});

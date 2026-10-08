import { expect, test } from 'bun:test';
import { BUILT_IN, DEFAULT_POLICY } from './built-in';
import summaryReset from './summary-reset';

test('summary-reset is the only built-in policy, with its description, and on by default', () => {
  expect(BUILT_IN).toEqual([
    { name: 'summary-reset', run: summaryReset, description: 'errors tool calls once the work takes ½ of the room left, keeps only the summary the model writes' },
  ]);
  expect(DEFAULT_POLICY).toBe('summary-reset');
});

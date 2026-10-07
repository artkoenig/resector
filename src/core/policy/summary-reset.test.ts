import { expect, test } from 'bun:test';
import type { Kind } from '../log/events';
import type { PolicyBlock } from './policy';
import summaryReset, { ERROR, HANDOVER, INTRO } from './summary-reset';

type Spec = Kind | [Kind, Partial<PolicyBlock>];

// Blocks with ids from 1; a Tool Result pairs with the Tool Call right before it.
const blocks = (...specs: Spec[]): PolicyBlock[] => {
  const kinds = specs.map(s => (Array.isArray(s) ? s[0] : s));
  return specs.map((s, i) => {
    const kind = kinds[i]!;
    const pair = kind === 'Tool Call' && kinds[i + 1] === 'Tool Result' ? i + 2 : kind === 'Tool Result' ? i : null;
    const block: PolicyBlock = { id: i + 1, kind, origin: 'model', content: kind, tokens: 300, pair, pending: false };
    return Array.isArray(s) ? { ...block, ...s[1] } : block;
  });
};
const intro: Spec = ['Note', { origin: 'policy', content: INTRO }];
const error = (id: number) => ({ op: 'edit' as const, id, content: ERROR });

test('the intro goes right after the System and Tools Block, once', () => {
  expect(summaryReset({ window: 99, used: 10, blocks: blocks('System', 'Tools', ['Note', { origin: 'environment' }], 'User') })).toEqual([{ op: 'note', after: 2, content: INTRO }]);
  expect(summaryReset({ window: 99, used: 10, blocks: blocks('System', 'Tools', intro, 'User') })).toEqual([]);
});

test('the intro tells the model the rules: half, the error, the summary tags, only the summary stays', () => {
  for (const part of ['takes half of it', 'fails with an error', 'between <summary> and </summary>', 'Only that summary is kept']) expect(INTRO).toContain(part);
});

test('below half the window nothing happens', () => {
  expect(summaryReset({ window: 99, used: 49, blocks: blocks('User', 'Tool Call', 'Tool Result') })).toEqual([]);
});

test('from half the window on, the results of the newest calls become the error; older ones, a Question\'s answers and errors stay', () => {
  const context = blocks('User', 'Tool Call', 'Tool Result', 'Assistant', 'Tool Call', 'Tool Call', 'Tool Result', ['Tool Result', { pair: 5 }], 'Tool Call', ['Tool Result', { origin: 'user' }]);
  expect(summaryReset({ window: 99, used: 50, blocks: context })).toEqual([error(7), error(8)]);
  const done = blocks('User', 'Tool Call', ['Tool Result', { content: ERROR }]);
  expect(summaryReset({ window: 99, used: 90, blocks: done })).toEqual([]);
});

test('the error asks for a summary between summary tags and says the call ran', () => {
  expect(ERROR).toContain('between <summary> and </summary>');
  expect(ERROR).toContain('This command ran, but its output is withheld');
});

test('a summary of the model becomes a Note led by the handover in its place; every block before it goes but the System, Tools Block, intro and the project\'s Notes', () => {
  const context = blocks(
    'System', 'Tools', intro, ['Note', { origin: 'environment' }], 'User', 'Tool Call', ['Tool Result', { content: ERROR }], 'Thinking',
    ['Assistant', { content: 'Here it is.\n<summary>\n## Task\nfix x\n</summary>' }], 'User',
  );
  expect(summaryReset({ window: 99, used: 10, blocks: context })).toEqual([
    { op: 'note', after: 9, content: `${HANDOVER}\n\n## Task\nfix x` },
    ...[5, 6, 8, 9].map(id => ({ op: 'remove' as const, id })),
  ]);
});

test('a later summary overwrites the handover Note instead of adding one', () => {
  const context = blocks(
    'System', intro, ['Note', { origin: 'policy', content: `${HANDOVER}\n\nold` }], 'User', 'Tool Call', 'Tool Result',
    ['Assistant', { content: '<summary>new</summary>' }], 'User',
  );
  expect(summaryReset({ window: 99, used: 10, blocks: context })).toEqual([
    { op: 'edit', id: 3, content: `${HANDOVER}\n\nnew` },
    ...[4, 5, 7].map(id => ({ op: 'remove' as const, id })),
  ]);
});

test('a summary quoting the tags is kept whole, from the first opening tag to the last closing one', () => {
  const content = '<summary>\n## Facts\nthe tags are <summary> and </summary>\n## Next steps\nedit\n</summary>';
  expect(summaryReset({ window: 99, used: 10, blocks: blocks('System', intro, 'User', ['Assistant', { content }], 'User') })[0]).toEqual({
    op: 'note', after: 4, content: `${HANDOVER}\n\n## Facts\nthe tags are <summary> and </summary>\n## Next steps\nedit`,
  });
});

test('after a reset only the work since counts toward the half, not the summary and what stays', () => {
  const context = blocks('System', intro, ['Note', { origin: 'policy', content: `${HANDOVER}\n\nfix x`, tokens: 3000 }], 'User', 'Tool Call', 'Tool Result');
  // System, intro and handover: 3600 tokens; the work since: 900.
  expect(summaryReset({ window: 1900, used: 4500, blocks: context })).toEqual([]);
  expect(summaryReset({ window: 1800, used: 4500, blocks: context })).toEqual([error(6)]);
});

test('without the closing tag there is no summary yet', () => {
  expect(summaryReset({ window: 99, used: 10, blocks: blocks('User', ['Assistant', { content: '<summary>half' }], 'User') })).toEqual([]);
});

test('after the reset, nothing more: the Note holds the summary without its tags', () => {
  const context = blocks('System', intro, ['Note', { origin: 'policy', content: `${HANDOVER}\n\nfix x` }], 'User');
  expect(summaryReset({ window: 99, used: 10, blocks: context })).toEqual([]);
});

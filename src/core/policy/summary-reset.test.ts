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
const thinkingOff = { op: 'thinking' as const, mode: 'off' };
const send = { op: 'send' as const };

test('the intro goes right after the System and Tools Block, once', () => {
  expect(summaryReset({ window: 99, used: 10, blocks: blocks('System', 'Tools', ['Note', { origin: 'environment' }], 'User') })).toEqual([{ op: 'note', after: 2, content: INTRO }]);
  expect(summaryReset({ window: 99, used: 10, blocks: blocks('System', 'User') })).toEqual([{ op: 'note', after: 1, content: INTRO }]);
  expect(summaryReset({ window: 99, used: 10, blocks: blocks('System', 'Tools', intro, 'User') })).toEqual([]);
  // Only the policy's Note with the intro is it.
  const others = blocks('System', 'Tools', ['Note', { origin: 'policy', content: HANDOVER }], ['User', { content: INTRO }]);
  expect(summaryReset({ window: 99, used: 10, blocks: others })).toEqual([{ op: 'note', after: 2, content: INTRO }]);
});

test('the intro tells the model the rules: half the room left, the error, the summary tags, only the summary stays', () => {
  for (const part of ['takes half of the room left', 'fails with an error', 'between <summary> and </summary>', 'Only that summary is kept']) expect(INTRO).toContain(part);
});

test('below half the window nothing happens', () => {
  expect(summaryReset({ window: 99, used: 49, blocks: blocks('User', 'Tool Call', 'Tool Result') })).toEqual([]);
});

test('from half the window on, the results of the newest calls become the error and the request goes without thinking; older ones, a Question\'s answers and errors stay', () => {
  const context = blocks('User', 'Tool Call', 'Tool Result', 'Assistant', 'Tool Call', 'Tool Call', 'Tool Result', ['Tool Result', { pair: 5 }], 'Tool Call', ['Tool Result', { origin: 'user' }]);
  expect(summaryReset({ window: 99, used: 50, blocks: context })).toEqual([error(7), error(8), thinkingOff]);
  const done = blocks('User', 'Tool Call', ['Tool Result', { content: ERROR }]);
  expect(summaryReset({ window: 99, used: 90, blocks: done })).toEqual([thinkingOff]);
  // No call since the last answer: nothing to error, thinking as the session's.
  expect(summaryReset({ window: 99, used: 90, blocks: blocks('User', 'Tool Call', 'Tool Result', 'Assistant', 'User') })).toEqual([]);
});

test('the error asks for a summary between summary tags and says the call ran', () => {
  expect(ERROR).toContain('between <summary> and </summary>');
  expect(ERROR).toContain('do not draft it in your thinking');
  expect(ERROR).toContain('Summarize only what is deleted');
  expect(ERROR).not.toContain('unverified');
  expect(ERROR).toContain('This command ran, but its output is withheld');
  expect(ERROR).toBe(ERROR.trim());
});

test('a summary of the model becomes a Note led by the handover in its place; every block before it goes but the System, Tools Block, intro and the project\'s Notes; then it is sent on', () => {
  const context = blocks(
    'System', 'Tools', intro, ['Note', { origin: 'environment' }], ['Note', { origin: 'file' }], 'User', 'Tool Call', ['Tool Result', { content: ERROR }], 'Thinking',
    ['Assistant', { content: 'Here it is.\n<summary>\n## Task\nfix x\n</summary>' }], 'User',
  );
  expect(summaryReset({ window: 99, used: 10, blocks: context })).toEqual([
    { op: 'note', after: 10, content: `${HANDOVER}\n\n## Task\nfix x` },
    ...[6, 7, 9, 10].map(id => ({ op: 'remove' as const, id })),
    send,
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
    send,
  ]);
});

test('only the policy\'s Note led by the handover is overwritten, no other block starting with it', () => {
  const context = blocks(
    'System', intro, ['User', { origin: 'policy', content: `${HANDOVER}\n\nquoted` }], ['Note', { origin: 'compaction', content: `${HANDOVER}\n\nx` }],
    ['Assistant', { content: '<summary>new</summary>' }], 'User',
  );
  expect(summaryReset({ window: 99, used: 10, blocks: context })).toEqual([
    { op: 'note', after: 5, content: `${HANDOVER}\n\nnew` },
    ...[3, 4, 5].map(id => ({ op: 'remove' as const, id })),
    send,
  ]);
});

test('a summary quoting the tags is kept whole, from the first opening tag to the last closing one', () => {
  const content = '<summary>\n## Facts\nthe tags are <summary> and </summary>\n## Next steps\nedit\n</summary>';
  expect(summaryReset({ window: 99, used: 10, blocks: blocks('System', intro, 'User', ['Assistant', { content }], 'User') })[0]).toEqual({
    op: 'note', after: 4, content: `${HANDOVER}\n\n## Facts\nthe tags are <summary> and </summary>\n## Next steps\nedit`,
  });
});

test('after a reset the work since counts toward half the room the summary and what stays leave', () => {
  const context = blocks('System', intro, ['Note', { origin: 'policy', content: `${HANDOVER}\n\nfix x`, tokens: 3000 }], 'User', 'Tool Call', 'Tool Result');
  // System, intro and handover: 3600 tokens; the work since: 900, half of 1800 left.
  expect(summaryReset({ window: 5401, used: 4500, blocks: context })).toEqual([]);
  expect(summaryReset({ window: 5400, used: 4500, blocks: context })).toEqual([error(6), thinkingOff]);
});

test('the error asks for a fixed structure: finished work without code, the changes still to make as diffs, not an earlier summary\'s form', () => {
  expect(ERROR).toContain('## Task\n');
  expect(ERROR).toContain('## Done\nThe finished work, one line per changed file: what changed and what for. No code');
  expect(ERROR).toContain('## Patches\nEvery code change still to make, as a unified diff in a ```diff block');
  expect(ERROR).toContain('## Next steps\n');
  expect(ERROR).toContain('in this structure, not in its form');
  expect(ERROR).toContain('Copy code only into Patches');
  expect(ERROR).toContain('## Facts\nWhat you found, as results, not as activities. No file contents.');
  expect(ERROR).toContain('A call whose output you did not see is a step that runs it');
});

test('without the closing tag there is no summary yet', () => {
  expect(summaryReset({ window: 99, used: 10, blocks: blocks('User', ['Assistant', { content: '<summary>half' }], 'User') })).toEqual([]);
});

test('the handover says the files are as the summary describes and its patches apply as they are', () => {
  expect(HANDOVER).toContain('the files are as it describes them');
  expect(HANDOVER).toContain('its Patches are planned against them: apply them as they are');
  expect(HANDOVER).not.toContain('unverified');
});

test('after the reset, nothing more: the Note holds the summary without its tags', () => {
  const context = blocks('System', intro, ['Note', { origin: 'policy', content: `${HANDOVER}\n\nfix x` }], 'User');
  expect(summaryReset({ window: 99, used: 10, blocks: context })).toEqual([]);
});

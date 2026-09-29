import { expect, test } from 'bun:test';
import type { Kind, SessionEvent } from '../log/events';
import { fold } from '../log/fold';
import { sentBlocks } from '../render/native';
import { BUILT_IN } from './built-in';
import { applyPolicy, viewOf } from './policy';
import thinkingTrail, { ABOUT, INSTRUCTION, LEAD } from './thinking-trail';

// Blocks from id 3 on after System and Tools Block; a Tool Result answers the Tool Call right before it.
const log = (...kinds: Kind[]): SessionEvent[] => [
  { type: 'SessionCreated', profile: 'default', protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
  { type: 'BlockAdded', id: 2, kind: 'Tools', origin: 'config', content: '[]' },
  ...kinds.map((kind, i): SessionEvent => ({ type: 'BlockAdded', id: i + 3, kind, origin: 'model', content: kind, ...(kind === 'Tool Result' ? { call: i + 2 } : {}) })),
];
// 2/3 of the window used: Tool Pairs the model has reasoned past go.
const WINDOW = 999;
const FULL = 666;
const view = (...kinds: Kind[]) => {
  const folded = fold(log(...kinds));
  return viewOf(folded, { blocks: sentBlocks(folded).map(() => 1), total: FULL }, WINDOW);
};
// As `view`, with the policy's Note already after the Tools Block: only the rules on the trail act.
const about = { id: 99, kind: 'Note' as const, origin: 'policy' as const, content: ABOUT, tokens: 1, pair: null, pending: false };
const context = (...kinds: Kind[]) => {
  const { blocks, ...rest } = view(...kinds);
  return { ...rest, blocks: [...blocks.slice(0, 2), about, ...blocks.slice(2)] };
};
const run = (...kinds: Kind[]) => thinkingTrail(context(...kinds));
const lead = { ...about, id: 98, content: LEAD };
// The Notes the result of a Compaction, led by the policy's lead.
const compacted = (...kinds: Kind[]) => {
  const { blocks, ...rest } = context(...kinds);
  const notes = blocks.map(b => (b.kind === 'Note' && b !== about ? { ...b, origin: 'compaction' as const } : b));
  const first = notes.findIndex(b => b.origin === 'compaction');
  return { ...rest, blocks: first < 0 ? notes : [...notes.slice(0, first), lead, ...notes.slice(first)] };
};
const runCompacted = (...kinds: Kind[]) => thinkingTrail(compacted(...kinds));

const compact = (...sources: number[]) => ({ op: 'compact' as const, sources, instruction: INSTRUCTION });

test('without its Note: the Note right after the Tools Block, alone in its pass', () => {
  expect(thinkingTrail(view('User'))).toEqual([{ op: 'note', after: 2, content: ABOUT }]);
  expect(thinkingTrail(view('Thinking', 'Tool Call', 'Tool Result', 'Thinking'))).toEqual([{ op: 'note', after: 2, content: ABOUT }]);
});

test('a Note of the policy with other content does not count; without a Tools Block no Note', () => {
  const { blocks, ...rest } = view('User');
  expect(thinkingTrail({ ...rest, blocks: [...blocks, { ...about, content: 'edited' }] })).toEqual([{ op: 'note', after: 2, content: ABOUT }]);
  expect(thinkingTrail({ ...rest, blocks: [...blocks, { ...about, origin: 'file' }] })).toEqual([{ op: 'note', after: 2, content: ABOUT }]);
  expect(thinkingTrail({ ...rest, blocks: blocks.filter(b => b.kind !== 'Tools') })).toEqual([]);
});

test('the Note tells what happens, no thresholds, no instructions', () => {
  expect(ABOUT).toBe(
    'Tool calls and results are removed once you have reasoned past them; your reasoning and answers are later replaced by summaries, shown as user messages, which are merged over time without dropping insights.',
  );
});

test('no Thinking, no Tool Pair: nothing', () => {
  expect(run()).toEqual([]);
  expect(run('User', 'Assistant')).toEqual([]);
});

test('Tool Pairs before the newest Thinking are removed, once each, as the Thinking is compacted', () => {
  // 3 User, 4 Thinking, 5/6 pair, 7 Thinking, 8/9 pair, 10 Thinking, 11/12 pair
  expect(run('User', 'Thinking', 'Tool Call', 'Tool Result', 'Thinking', 'Tool Call', 'Tool Result', 'Thinking', 'Tool Call', 'Tool Result')).toEqual([
    { op: 'remove', id: 5 },
    { op: 'remove', id: 8 },
    compact(4, 7, 10),
  ]);
});

test('under 2/3 of the window used, the trail stays; from 2/3 on the Tool Pairs go and the Thinking is compacted together', () => {
  const trail = context('Thinking', 'Tool Call', 'Tool Result', 'Thinking', 'Thinking', 'Thinking', 'Thinking', 'Thinking');
  expect(thinkingTrail({ ...trail, used: FULL - 1 })).toEqual([]);
  expect(thinkingTrail({ ...trail, used: FULL })).toEqual([{ op: 'remove', id: 4 }, compact(3, 6, 7, 8, 9, 10)]);
});

test('a Tool Pair answered by the user stays, also before the newest Thinking: a Question\'s answers are not reasoned past', () => {
  // 3 Thinking, 4/5 Question pair answered by the user, 6/7 pair, 8 Thinking
  const trail = context('Thinking', 'Tool Call', 'Tool Result', 'Tool Call', 'Tool Result', 'Thinking');
  const blocks = trail.blocks.map(b => (b.id === 5 ? { ...b, origin: 'user' as const } : b));
  expect(thinkingTrail({ ...trail, blocks })).toEqual([{ op: 'remove', id: 6 }, compact(3, 8)]);
});

test('Tool Pairs after the newest Thinking stay: the model has not seen their results yet', () => {
  expect(run('User', 'Thinking', 'Tool Call', 'Tool Result', 'Tool Call', 'Tool Result')).toEqual([compact(4)]);
});

test('without Thinking nothing is removed or compacted', () => {
  expect(run('User', 'Tool Call', 'Tool Result', 'Assistant')).toEqual([]);
});

test('a pending Tool Call stays, also before the newest Thinking', () => {
  // 3 User, 4 Tool Call without result, 5 Thinking
  expect(run('User', 'Tool Call', 'Thinking')).toEqual([compact(5)]);
});

test('a Tool Pair whose Tool Result comes after the newest Thinking stays: the model has not seen the result', () => {
  const trail = context('Thinking', 'Tool Call', 'Tool Result', 'Thinking');
  const [call, result, newest] = trail.blocks.slice(4);
  expect(thinkingTrail({ ...trail, blocks: [...trail.blocks.slice(0, 4), call!, newest!, result!] })).toEqual([compact(3, 6)]);
});

test('one Thinking is enough: compacted with the Assistant blocks, in Context order', () => {
  expect(run('User', 'Assistant', 'Thinking', 'Note', 'Assistant')).toEqual([compact(4, 5, 7)]);
});

test('both rules in one pass: the Tool Pairs go, the Thinking is compacted', () => {
  expect(run('Thinking', 'Tool Call', 'Tool Result', 'Thinking', 'Thinking', 'Thinking', 'Thinking')).toEqual([
    { op: 'remove', id: 4 },
    compact(3, 6, 7, 8, 9),
  ]);
});

test('4 Notes of a Compaction: nothing to compact', () => {
  expect(runCompacted('Note', 'User', 'Note', 'Assistant', 'Note', 'Note')).toEqual([]);
});

test('5 Notes of a Compaction: one compact over exactly those 5, in Context order', () => {
  expect(runCompacted('Note', 'User', 'Note', 'Assistant', 'Note', 'Note', 'Note')).toEqual([
    compact(3, 5, 7, 8, 9),
  ]);
});

test('Notes of a Compaction are compacted also under 2/3 of the window', () => {
  expect(thinkingTrail({ ...compacted('Note', 'Note', 'Note', 'Note', 'Note', 'Thinking'), used: 0 })).toEqual([compact(3, 4, 5, 6, 7)]);
});

test('its lead right before the first Note of a Compaction, also under 2/3 of the window', () => {
  // 3 User, 4 Note, 5 Note: the lead after 3.
  const { blocks, ...rest } = context('User', 'Note', 'Note');
  const notes = blocks.map(b => (b.kind === 'Note' && b !== about ? { ...b, origin: 'compaction' as const } : b));
  expect(thinkingTrail({ ...rest, used: 0, blocks: notes })).toEqual([{ op: 'note', after: 3, content: LEAD }]);
  // Before the second Note or with other content it is stale, and a lead goes before the first.
  const [b0, b1, b2, b3, n4, n5] = notes;
  expect(thinkingTrail({ ...rest, used: 0, blocks: [b0!, b1!, b2!, b3!, n4!, lead, n5!] })).toEqual([{ op: 'remove', id: 98 }, { op: 'note', after: 3, content: LEAD }]);
  expect(thinkingTrail({ ...rest, used: 0, blocks: [b0!, b1!, b2!, b3!, { ...lead, content: 'x' }, n4!, n5!] })).toEqual([{ op: 'note', after: 98, content: LEAD }]);
  expect(thinkingTrail({ ...rest, used: 0, blocks: [b0!, b1!, b2!, b3!, { ...lead, origin: 'file' }, n4!, n5!] })).toEqual([{ op: 'note', after: 98, content: LEAD }]);
});

test('without a Note of a Compaction its lead goes: none is added', () => {
  const { blocks, ...rest } = context('User');
  expect(thinkingTrail({ ...rest, blocks: [...blocks, lead] })).toEqual([{ op: 'remove', id: 98 }]);
  expect(run('User', 'Note')).toEqual([]);
});

test('the lead tells the model the summary is its own work, not a new task', () => {
  expect(LEAD).toBe('The summary below is of your own earlier work in this session, not a new task. Build on it, do not redo what is under Done; continue with Next steps.');
});

test('other Notes do not count', () => {
  expect(run('Note', 'Note', 'Note', 'Note', 'Note')).toEqual([]);
});

test('Thinking is compacted with the Notes of earlier Compactions, however many: one trail', () => {
  expect(runCompacted('Note', 'Note', 'Note', 'Note', 'Note', 'Thinking', 'User', 'Assistant')).toEqual([compact(3, 4, 5, 6, 7, 8, 10)]);
  expect(runCompacted('Note', 'User', 'Thinking')).toEqual([compact(3, 5)]);
});

test('the instruction asks for accumulated knowledge in a fixed structure', () => {
  expect(INSTRUCTION).toBe(
    'Accumulate the knowledge in these blocks into one Note that replaces them: a reader without them must be able to continue the work. Discard nothing: keep every insight, also those from earlier Notes; merge only what is said twice. Write each point as its result, never as the activity: not "located the files" but the paths; not "decided on an approach" but the approach and why. Keep names, paths, identifiers, commands and values verbatim. Write only what the blocks show (code read, tool output, test results); mark anything not verified as unverified; no point may contradict another. Under Next steps, list what remains, in order, each concrete enough to act on. Answer in exactly this structure:\n## Goal\n## Facts\n## Decisions\n## Done\n## Dead ends\n## Next steps',
  );
});

test('applied by the hook: the Tool Pair goes, 5 Thinking become one Note led by the lead, then nothing more to do', async () => {
  const events = log('Thinking', 'Tool Call', 'Tool Result', 'Thinking', 'Thinking', 'Thinking', 'Thinking', 'User');
  const ran = await applyPolicy(
    { name: 'thinking-trail', run: thinkingTrail },
    {
      events: () => events,
      append: event => void events.push(event),
      count: async c => ({ blocks: sentBlocks(c).map(() => 1), total: FULL }),
      window: WINDOW,
      compact: async () => 'the trail',
      aborted: () => false,
    },
  );
  expect(ran).toEqual({ changes: [{ noun: 'Note', verb: 'added' }, { noun: 'Tool Pair', verb: 'removed' }, { text: '5 Thinking → 1 Note' }, { noun: 'Note', verb: 'added' }], error: null });
  expect(sentBlocks(fold(events)).map(b => [b.kind, b.content])).toEqual([
    ['System', 'sys'],
    ['Tools', '[]'],
    ['Note', ABOUT],
    ['Note', LEAD],
    ['Note', 'the trail'],
    ['User', 'User'],
  ]);
});

test('applied by the hook: the Thinking and the Notes of earlier Compactions become one Note', async () => {
  // Blocks 3–6 compacted into a Note each, 13–16.
  const events = [
    ...log('User', 'User', 'User', 'User', 'Thinking', 'Thinking', 'Thinking', 'Thinking', 'Thinking', 'User'),
    ...[3, 4, 5, 6].map((id): SessionEvent => ({ type: 'Compact', sources: [id], instruction: 'i', noteId: id + 10, content: `trail ${id}` })),
  ];
  const ran = await applyPolicy(
    { name: 'thinking-trail', run: thinkingTrail },
    {
      events: () => events,
      append: event => void events.push(event),
      count: async c => ({ blocks: sentBlocks(c).map(() => 1), total: FULL }),
      window: WINDOW,
      compact: async () => 'the trail',
      aborted: () => false,
    },
  );
  expect(ran).toEqual({ changes: [{ noun: 'Note', verb: 'added' }, { noun: 'Note', verb: 'added' }, { text: '4 Note + 5 Thinking → 1 Note' }], error: null });
  expect(sentBlocks(fold(events)).map(b => [b.kind, b.content])).toEqual([
    ['System', 'sys'],
    ['Tools', '[]'],
    ['Note', ABOUT],
    ['Note', LEAD],
    ['Note', 'the trail'],
    ['User', 'User'],
  ]);
});

test('shipped built-in as thinking-trail', () => {
  expect(BUILT_IN).toEqual([{ name: 'thinking-trail', run: thinkingTrail }]);
});

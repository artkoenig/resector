import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { fold } from '../log/fold';
import { TOOLS } from '../tools/catalog';
import { addNote, approvable, attributed, decline, deny, edit, isFixed, inPair, move, moveAfter, nextCall, reject, remove, removeAll, revise, toggleTool, untouchable, withoutDenied, toNote, toolResult, undo } from './operations';

const session = (...then: SessionEvent[]): SessionEvent[] => [
  { type: 'SessionCreated', profile: 'default', protocol: 'native' },
  { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
  { type: 'BlockAdded', id: 2, kind: 'User', origin: 'user', content: 'a' },
  { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'b' },
  { type: 'BlockAdded', id: 4, kind: 'User', origin: 'user', content: 'c' },
  ...then,
];
const at = (events: SessionEvent[], id: number) => {
  const context = fold(events);
  return [context, context.blocks.find(b => b.id === id)!] as const;
};
const FIXED = { error: 'System prompt is fixed' };
const BOUNDARY = { error: 'boundary reached' };

test('move up anchors the block after the neighbour’s predecessor', () => {
  expect(move(...at(session(), 3), -1)).toEqual({ event: { type: 'Move', id: 3, after: 1 } });
  expect(move(...at(session(), 4), -1)).toEqual({ event: { type: 'Move', id: 4, after: 2 } });
});

test('move down anchors the block after its neighbour', () => {
  expect(move(...at(session(), 2), 1)).toEqual({ event: { type: 'Move', id: 2, after: 3 } });
});

test('move skips struck-through blocks', () => {
  const events = session({ type: 'Remove', id: 3 });
  expect(move(...at(events, 2), 1)).toEqual({ event: { type: 'Move', id: 2, after: 4 } });
  expect(move(...at(events, 4), -1)).toEqual({ event: { type: 'Move', id: 4, after: 1 } });
});

test('move stops at System and the ends', () => {
  expect(move(...at(session(), 1), 1)).toEqual(FIXED);
  expect(move(...at(session(), 2), -1)).toEqual(BOUNDARY);
  expect(move(...at(session(), 4), 1)).toEqual(BOUNDARY);
});

test('remove any block but System', () => {
  expect(remove(at(session(), 3)[1])).toEqual({ event: { type: 'Remove', id: 3 } });
  expect(remove(at(session(), 1)[1])).toEqual({ error: 'System prompt cannot be removed' });
});

test('d with marks removes every marked block in one event; nothing marked, nothing removed', () => {
  const [context] = at(session(), 1);
  const blocks = (...ids: number[]) => ids.map(id => context.blocks.find(b => b.id === id)!);
  expect(removeAll(blocks(2, 4, 3))).toEqual({ event: { type: 'Remove', id: 2, others: [4, 3] } });
  expect(removeAll(blocks(2, 1))).toEqual({ error: 'System prompt cannot be removed' });
  expect(removeAll([])).toEqual({ error: 'nothing marked' });
});

test('undo names the latest Context operation not yet undone', () => {
  const events = session({ type: 'Remove', id: 2 }, { type: 'Rename', id: 3, title: 'x' }, { type: 'RequestSent', hash: 'h', tokens: 1 });
  expect(undo(events)).toEqual({ event: { type: 'Undo', eventId: 6 } });
  expect(undo([...events, { type: 'Undo', eventId: 6 }])).toEqual({ event: { type: 'Undo', eventId: 5 } });
  for (const op of [{ type: 'Move', id: 3, after: 1 }, { type: 'Edit', id: 3, revision: 2, content: 'x' }] as SessionEvent[])
    expect(undo(session(op))).toEqual({ event: { type: 'Undo', eventId: 5 } });
});

test('undo passes over Pin and Unpin from older logs: replay ignores them (ADR 0002)', () => {
  const legacy = [{ type: 'Pin', id: 3, at: 'top' }, { type: 'Unpin', id: 3 }] as unknown as SessionEvent[];
  expect(undo(session({ type: 'Remove', id: 2 }, ...legacy))).toEqual({ event: { type: 'Undo', eventId: 5 } });
  expect(undo(session(...legacy))).toEqual({ error: 'nothing to undo' });
});

test('undo has nothing to cancel without Context operations', () => {
  expect(undo(session())).toEqual({ error: 'nothing to undo' });
  expect(undo(session({ type: 'Remove', id: 2 }, { type: 'Undo', eventId: 5 }))).toEqual({ error: 'nothing to undo' });
});

const tools: SessionEvent = { type: 'BlockAdded', id: 5, kind: 'Tools', origin: 'config', content: '[]' };
const call = (id: number): SessionEvent => ({ type: 'BlockAdded', id, kind: 'Tool Call', origin: 'model', content: `cmd ${id}` });
const answered = (id: number, of: number): SessionEvent => ({ type: 'BlockAdded', id, kind: 'Tool Result', origin: 'tool', content: 'out', call: of });
const AWAITS = { error: 'Tool Call awaits approval – y run once · a allow for session · n reject · e edit' };

test('the Tools Block is fixed like System', () => {
  const [context, block] = at(session(tools), 5);
  expect(isFixed(block)).toBe(true);
  expect(move(context, block, -1)).toEqual({ error: 'Tools Block is fixed' });
  expect(remove(block)).toEqual({ error: 'Tools Block cannot be removed' });
  expect(isFixed(at(session(), 2)[1])).toBe(false);
});

test('/tools switches a tool in the Tools Block as its next Revision; unknown tools and a missing block are errors', () => {
  const on = { type: 'BlockAdded', id: 5, kind: 'Tools', origin: 'config', content: TOOLS } as const;
  const events = session(on);
  const [context] = at(events, 5);
  expect(toggleTool(events, context, 'search', [])).toEqual({ event: { type: 'Edit', id: 5, revision: 2, content: expect.stringContaining('"search"') } });
  expect(toggleTool(events, context, 'python', [])).toEqual({ error: 'unknown tool python – bash search question' });
  expect(toggleTool(session(), fold(session()), 'search', [])).toEqual({ error: 'no Tools Block' });
});

// The new session's Tools Block without one tool.
const toolsWithout = (name: string) => JSON.stringify((JSON.parse(TOOLS) as { name: string }[]).filter(t => t.name !== name), null, 2);

test('a tool denied by rule cannot be switched on, but off', () => {
  const events = session({ type: 'BlockAdded', id: 5, kind: 'Tools', origin: 'config', content: toolsWithout('question') });
  const [context] = at(events, 5);
  expect(toggleTool(events, context, 'question', ['question'])).toEqual({ error: 'question is denied by rule' });
  const on = session({ type: 'BlockAdded', id: 5, kind: 'Tools', origin: 'config', content: TOOLS });
  expect(toggleTool(on, fold(on), 'question', ['question'])).toEqual({ event: { type: 'Edit', id: 5, revision: 2, content: toolsWithout('question') } });
});

test('the harness takes denied tools out of the Tools Block, not undoable; nothing when none is on', () => {
  const events = session({ type: 'BlockAdded', id: 5, kind: 'Tools', origin: 'config', content: TOOLS });
  expect(withoutDenied(events, fold(events), ['question'])).toEqual({ type: 'Edit', id: 5, revision: 2, content: toolsWithout('question'), harness: true });
  expect(withoutDenied(events, fold(events), [])).toBeNull();
  expect(withoutDenied(events, fold(events), ['search'])).toBeNull();
  expect(withoutDenied(session(), fold(session()), ['question'])).toBeNull();
});

test('a Tool Call awaiting approval is not moved or removed', () => {
  const events = session(call(6));
  expect(move(...at(events, 6), -1)).toEqual(AWAITS);
  expect(remove(at(events, 6)[1])).toEqual(AWAITS);
  expect(remove(at([...events, answered(7, 6)], 6)[1])).toEqual({ event: { type: 'Remove', id: 6 } });
});

test('Tool Calls are approved one by one in order', () => {
  const events = session(call(6), call(7), answered(8, 6), call(9));
  expect(nextCall(fold(events))?.id).toBe(7);
  expect(approvable(...at(events, 7))).toBeNull();
  expect(approvable(...at(events, 9))).toBe('approve the earlier Tool Call first');
  expect(approvable(...at(events, 6))).toBe('not awaiting approval');
  expect(approvable(...at(events, 2))).toBe('not awaiting approval');
  expect(nextCall(fold(session()))).toBeUndefined();
});

test('reject answers the call with a Tool Result "rejected by user"', () => {
  const events = session(call(6), call(7));
  expect(reject(...at(events, 6), 8)).toEqual({
    event: { type: 'BlockAdded', id: 8, kind: 'Tool Result', origin: 'tool', content: 'rejected by user', call: 6 },
  });
  expect(reject(...at(events, 7), 8)).toEqual({ error: 'approve the earlier Tool Call first' });
});

test('a denied call is answered with a Tool Result "denied by rule"', () => {
  const events = session(call(6), call(7));
  expect(deny(...at(events, 6), 8)).toEqual({
    event: { type: 'BlockAdded', id: 8, kind: 'Tool Result', origin: 'tool', content: 'denied by rule', call: 6 },
  });
  expect(deny(...at(events, 7), 8)).toEqual({ error: 'approve the earlier Tool Call first' });
});

test('a declined Question is answered with a Tool Result "declined"', () => {
  expect(decline(...at(session(call(6)), 6), 8)).toEqual({
    event: { type: 'BlockAdded', id: 8, kind: 'Tool Result', origin: 'tool', content: 'declined', call: 6 },
  });
});

test('a run becomes the Tool Result of its call, flagged when stopped', () => {
  const [, block] = at(session(call(6)), 6);
  expect(toolResult(block, 7, { output: 'x', exit: 0, stopped: null }, 120)).toEqual({
    type: 'BlockAdded', id: 7, kind: 'Tool Result', origin: 'tool', content: 'x\n[exit 0]', call: 6,
  });
  expect(toolResult(block, 7, { output: '', exit: null, stopped: 'killed' }, 120)).toEqual({
    type: 'BlockAdded', id: 7, kind: 'Tool Result', origin: 'tool', content: '[killed]', call: 6, stopped: 'killed',
  });
});

const editOf = (events: SessionEvent[], id: number, text: string) => edit(events, at(events, id)[1], text);

test('edit creates the next Revision of the block', () => {
  expect(editOf(session(), 2, 'better')).toEqual({ event: { type: 'Edit', id: 2, revision: 2, content: 'better' } });
  const edited = session({ type: 'Edit', id: 2, revision: 2, content: 'x' }, { type: 'Edit', id: 3, revision: 2, content: 'y' });
  expect(editOf(edited, 2, 'z')).toEqual({ event: { type: 'Edit', id: 2, revision: 3, content: 'z' } });
});

test('Revision numbers are not reused after an undo: the undone one stays in the Session Log', () => {
  const events = session({ type: 'Edit', id: 2, revision: 2, content: 'x' }, { type: 'Undo', eventId: 5 });
  expect(editOf(events, 2, 'y')).toEqual({ event: { type: 'Edit', id: 2, revision: 3, content: 'y' } });
});

test('an unchanged save creates no Revision', () => {
  expect(editOf(session(), 2, 'a')).toEqual({ error: 'unchanged – no new Revision' });
});

test('the newline an editor appends at the end is dropped, unless the content had one; a command loses all', () => {
  expect(editOf(session(), 2, 'a\n')).toEqual({ error: 'unchanged – no new Revision' });
  expect(editOf(session(), 2, 'b\n\nc\n\n')).toEqual({ event: { type: 'Edit', id: 2, revision: 2, content: 'b\n\nc\n' } });
  expect(editOf(session(call(6)), 6, 'ls \\\n  -a\n\n')).toEqual({ event: { type: 'Edit', id: 6, revision: 2, content: 'ls \\\n  -a' } });
  const multiline = session({ type: 'BlockAdded', id: 5, kind: 'User', origin: 'user', content: 'x\n' });
  expect(editOf(multiline, 5, 'y\n')).toEqual({ event: { type: 'Edit', id: 5, revision: 2, content: 'y\n' } });
});

test('editable: all kinds but the Tools Block and executed Tool Calls', () => {
  const events = session(tools, call(6), answered(7, 6), call(8));
  expect(editOf(events, 5, '[]x')).toEqual({ error: 'Tools Block is not editable' });
  expect(editOf(events, 6, 'rm')).toEqual({ error: 'executed Tool Calls are immutable' });
  expect(editOf(events, 8, 'ls -a')).toEqual({ event: { type: 'Edit', id: 8, revision: 2, content: 'ls -a' } });
  expect(editOf(events, 7, 'short')).toEqual({ event: { type: 'Edit', id: 7, revision: 2, content: 'short' } });
  expect(editOf(events, 1, 'new sys')).toEqual({ event: { type: 'Edit', id: 1, revision: 2, content: 'new sys' } });
  const question: SessionEvent = { type: 'BlockAdded', id: 9, kind: 'Tool Call', origin: 'model', content: '{"questions":[]}', tool: 'question' };
  expect(editOf(session(question), 9, '{}')).toEqual({ error: 'a Question is answered in the dock, not edited' });
});

test('a Tool Pair is an executed Tool Call or a Tool Result', () => {
  const events = session(call(6), answered(7, 6), call(8));
  expect([6, 7, 8, 2].map(id => inPair(at(events, id)[1]))).toEqual([true, true, false, false]);
});

test('toNote turns the pair of either block into a Note; not a pending call or another block', () => {
  const events = session(call(6), answered(7, 6), call(8));
  for (const id of [6, 7]) expect(toNote(at(events, id)[1], 9)).toEqual({ event: { type: 'PairToNote', id: 9, call: 6 } });
  expect(toNote(at(events, 8)[1], 9)).toEqual(AWAITS);
  expect(toNote(at(events, 2)[1], 9)).toEqual({ error: 'not a Tool Pair' });
});

test('undo cancels a PairToNote', () => {
  expect(undo(session(call(6), answered(7, 6), { type: 'PairToNote', id: 8, call: 6 }))).toEqual({ event: { type: 'Undo', eventId: 7 } });
});

test('a block moves past the Tool Calls and Tool Results of an answer as a whole, never between them', () => {
  const events = session(call(6), call(7), answered(8, 6), answered(9, 7), { type: 'BlockAdded', id: 10, kind: 'User', origin: 'user', content: 'd' });
  expect(move(...at(events, 10), -1)).toEqual({ event: { type: 'Move', id: 10, after: 4 } });
  expect(move(...at(events, 4), 1)).toEqual({ event: { type: 'Move', id: 4, after: 9 } });
  const last = session(call(6), answered(7, 6));
  expect(move(...at(last, 4), 1)).toEqual({ event: { type: 'Move', id: 4, after: 7 } });
  const struck = [...events, { type: 'Remove', id: 9 } as SessionEvent];
  expect(move(...at(struck, 4), 1)).toEqual({ event: { type: 'Move', id: 4, after: 8 } });
});

test('undo passes over the harness refreshing the environment Note', () => {
  const events = session({ type: 'Edit', id: 2, revision: 2, content: 'x' }, { type: 'Edit', id: 3, revision: 2, content: 'env', harness: true });
  expect(undo(events)).toEqual({ event: { type: 'Undo', eventId: 5 } });
  expect(undo(session({ type: 'Edit', id: 3, revision: 2, content: 'env', harness: true }))).toEqual({ error: 'nothing to undo' });
});

test('an edit after a harness Revision is numbered after it', () => {
  const events = session({ type: 'Edit', id: 3, revision: 2, content: 'env', harness: true });
  expect(edit(events, at(events, 3)[1], 'mine')).toEqual({ event: { type: 'Edit', id: 3, revision: 3, content: 'mine' } });
});

test('moveAfter anchors the block after any block of the Context, as a Context Policy moves it (ADR 0001)', () => {
  expect(moveAfter(...at(session(), 4), 1)).toEqual({ event: { type: 'Move', id: 4, after: 1 } });
  expect(moveAfter(...at(session(), 2), 4)).toEqual({ event: { type: 'Move', id: 2, after: 4 } });
  expect(moveAfter(...at(session(tools), 2), 5)).toEqual({ event: { type: 'Move', id: 2, after: 5 } });
});

test('moveAfter keeps System and Tools first, the calls and results of an answer together, and needs a change', () => {
  const events = session(call(6), call(7), answered(8, 6), answered(9, 7));
  expect(moveAfter(...at(events, 1), 2)).toEqual(FIXED);
  expect(moveAfter(...at(session(call(10)), 10), 2)).toEqual(AWAITS);
  expect(moveAfter(...at(events, 8), 2)).toEqual({ error: 'a Tool Pair moves as a Note' });
  expect(moveAfter(...at(events, 2), 6)).toEqual({ error: 'not between the Tool Calls and Tool Results of an answer' });
  expect(moveAfter(...at(events, 2), 8)).toEqual({ error: 'not between the Tool Calls and Tool Results of an answer' });
  expect(moveAfter(...at(events, 2), 9)).toEqual({ event: { type: 'Move', id: 2, after: 9 } });
  const opening: SessionEvent[] = [
    { type: 'SessionCreated', profile: 'default', protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
    { ...tools, id: 2 } as SessionEvent,
    { type: 'BlockAdded', id: 3, kind: 'User', origin: 'user', content: 'a' },
    { type: 'BlockAdded', id: 4, kind: 'User', origin: 'user', content: 'b' },
  ];
  expect(moveAfter(...at(opening, 4), 1)).toEqual({ error: 'System and Tools Block stay first' });
  expect(moveAfter(...at(opening, 4), 2)).toEqual({ event: { type: 'Move', id: 4, after: 2 } });
  expect(moveAfter(...at(session(), 3), 2)).toEqual({ error: 'unchanged – already there' });
  expect(moveAfter(...at(session(), 3), 3)).toEqual({ error: 'no block 3 in the Context' });
  expect(moveAfter(...at(session({ type: 'Remove', id: 2 }), 4), 2)).toEqual({ error: 'no block 2 in the Context' });
});

test('moveAfter looks past struck-through blocks: they are not sent', () => {
  const struck = session({ type: 'Remove', id: 3 });
  expect(moveAfter(...at(struck, 4), 2)).toEqual({ error: 'unchanged – already there' });
  expect(moveAfter(...at(session(call(6), answered(7, 6), { type: 'Remove', id: 6 }), 2), 4)).toEqual({ event: { type: 'Move', id: 2, after: 4 } });
});

test('untouchable: System and Tools Block and pending Tool Calls, for any operation', () => {
  const events = session(tools, call(6), answered(7, 6), call(8));
  expect([1, 5, 8].map(id => untouchable(at(events, id)[1]))).toEqual([FIXED, { error: 'Tools Block is fixed' }, AWAITS]);
  expect([2, 6, 7].map(id => untouchable(at(events, id)[1]))).toEqual([null, null, null]);
});

test('revise: the content as the next Revision, as is; unchanged, none', () => {
  expect(revise(session(), at(session(), 2)[1], 'b\n')).toEqual({ event: { type: 'Edit', id: 2, revision: 2, content: 'b\n' } });
  expect(revise(session(), at(session(), 2)[1], 'a')).toEqual({ error: 'unchanged – no new Revision' });
});

test('attributed names who made a Context operation; other events and harness edits stay as they are', () => {
  const ops: SessionEvent[] = [
    { type: 'Move', id: 2, after: 3 }, { type: 'Remove', id: 2 }, { type: 'Edit', id: 2, revision: 2, content: 'x' },
    { type: 'PairToNote', id: 9, call: 6 }, { type: 'Compact', sources: [2], instruction: 'i', noteId: 9, content: 'n' },
    { type: 'NoteAdded', id: 9, after: 2, content: 'n' },
  ];
  for (const event of ops) expect(attributed(event, 'trail')).toEqual({ ...event, by: 'trail' } as SessionEvent);
  const others: SessionEvent[] = [{ type: 'Edit', id: 2, revision: 2, content: 'x', harness: true }, { type: 'Rename', id: 2, title: 't' }, { type: 'Undo', eventId: 3 }, call(6)];
  for (const event of others) expect(attributed(event, 'user')).toEqual(event);
});

test('addNote: a Context Policy\'s Note after any block sent, keeping System and Tools first and an answer together', () => {
  const context = fold(session(tools, call(6), call(7), answered(8, 6), answered(9, 7)));
  expect(addNote(context, 10, 5, 'about')).toEqual({ event: { type: 'NoteAdded', id: 10, after: 5, content: 'about' } });
  expect(addNote(context, 10, 9, 'about')).toEqual({ event: { type: 'NoteAdded', id: 10, after: 9, content: 'about' } });
  expect(addNote(context, 10, 6, 'about')).toEqual({ error: 'not between the Tool Calls and Tool Results of an answer' });
  expect(addNote(context, 10, 99, 'about')).toEqual({ error: 'no block 99 in the Context' });
  expect(addNote(fold(session({ type: 'Remove', id: 3 })), 10, 3, 'about')).toEqual({ error: 'no block 3 in the Context' });
  expect(addNote(context, 10, 5, ' \n')).toEqual({ error: 'empty Note' });
  const opening = fold([session()[0]!, session()[1]!, { ...tools, id: 2 } as SessionEvent]);
  expect(addNote(opening, 3, 1, 'about')).toEqual({ error: 'System and Tools Block stay first' });
});

test('undo cancels a policy\'s Note', () => {
  expect(undo(session({ type: 'NoteAdded', id: 5, after: 2, content: 'n' }))).toEqual({ event: { type: 'Undo', eventId: 5 } });
});

import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { fold } from '../log/fold';
import { fileNote, parseReference, peekReferences, readReferences, references, snapshot } from './files';

test('@file references are taken from the input; the rest is the User text (FR-27)', () => {
  expect(references('@file src/a.ts explain this')).toEqual({ files: ['src/a.ts'], text: 'explain this' });
  expect(references('compare @file a.ts:3-5 and\n@file b.ts')).toEqual({ files: ['a.ts:3-5', 'b.ts'], text: 'compare and' });
  expect(references('@file a.ts')).toEqual({ files: ['a.ts'], text: '' });
  expect(references('mail me@file.io')).toEqual({ files: [], text: 'mail me@file.io' });
  expect(references('@files x')).toEqual({ files: [], text: '@files x' });
  expect(references('  hi  ')).toEqual({ files: [], text: 'hi' });
  expect(references('@file  a.ts')).toEqual({ files: ['a.ts'], text: '' });
  expect(references('@file a.ts\nline one\nline two')).toEqual({ files: ['a.ts'], text: 'line one\nline two' });
});

test('a reference is a path with an optional line or line range', () => {
  expect(parseReference('src/a.ts')).toEqual({ path: 'src/a.ts', from: null, to: null });
  expect(parseReference('src/a.ts:3')).toEqual({ path: 'src/a.ts', from: 3, to: 3 });
  expect(parseReference('src/a.ts:3-5')).toEqual({ path: 'src/a.ts', from: 3, to: 5 });
  expect(parseReference('a:b.ts:12')).toEqual({ path: 'a:b.ts', from: 12, to: 12 });
  expect(parseReference('a.ts:x')).toEqual({ path: 'a.ts:x', from: null, to: null });
  expect(parseReference('a.ts:3x')).toEqual({ path: 'a.ts:3x', from: null, to: null });
});

test('a file Note names its file first', () => {
  expect(fileNote('AGENTS.md', '# Rules\n')).toBe('[AGENTS.md]\n# Rules\n');
});

const text = 'one\ntwo\nthree\nfour\n';
const read = (path: string) => (path === 'a.ts' ? text : null);

test('the snapshot is the whole file, or the numbered lines of its range', () => {
  expect(snapshot('a.ts', read)).toEqual({ content: `[a.ts]\n${text}` });
  expect(snapshot('a.ts:2-3', read)).toEqual({ content: '[a.ts:2-3]\n2: two\n3: three' });
  expect(snapshot('a.ts:4', read)).toEqual({ content: '[a.ts:4]\n4: four' });
  expect(snapshot('a.ts:3-99', read)).toEqual({ content: '[a.ts:3-99]\n3: three\n4: four' });
});

test('a missing file or a range past its end is no snapshot', () => {
  expect(snapshot('b.ts', read)).toEqual({ error: 'file not found: b.ts' });
  expect(snapshot('b.ts:1-2', read)).toEqual({ error: 'file not found: b.ts' });
  expect(snapshot('a.ts:5-6', read)).toEqual({ error: 'no line 5 in a.ts (4 lines)' });
  expect(snapshot('a.ts:3-2', read)).toEqual({ error: 'empty range 3-2 in a.ts' });
  expect(snapshot('a.ts:0-2', read)).toEqual({ error: 'no line 0 in a.ts (4 lines)' });
});

const session = (...then: SessionEvent[]) =>
  fold([
    { type: 'SessionCreated', profile: 'default', protocol: 'native' },
    { type: 'BlockAdded', id: 1, kind: 'System', origin: 'config', content: 'sys' },
    ...then,
  ]);
const twoRefs = session({ type: 'FileReferenced', id: 2, file: 'a.ts:1' }, { type: 'FileReferenced', id: 3, file: 'b.ts' });

test('at the Gate an unread reference shows the file as it is now; a missing one says so', () => {
  const peeked = peekReferences(twoRefs, read).blocks;
  expect(peeked[1]).toMatchObject({ id: 2, unread: true, content: '[a.ts:1]\n1: one' });
  expect(peeked[1]!.missing).toBeUndefined();
  expect(peeked[2]).toMatchObject({ id: 3, unread: true, content: '', missing: 'file not found: b.ts' });
  expect(peeked[0]).toBe(twoRefs.blocks[0]!);
});

test('on send each unread reference is read into its snapshot (FR-27)', () => {
  const found = readReferences(session({ type: 'FileReferenced', id: 2, file: 'a.ts:1' }, { type: 'FileReferenced', id: 3, file: 'a.ts' }), read);
  expect(found).toEqual({ events: [{ type: 'FileRead', id: 2, content: '[a.ts:1]\n1: one' }, { type: 'FileRead', id: 3, content: `[a.ts]\n${text}` }] });
});

test('a missing file aborts sending; removed references are not read', () => {
  expect(readReferences(twoRefs, read)).toEqual({ error: 'file not found: b.ts', id: 3 });
  const removed = session({ type: 'FileReferenced', id: 2, file: 'b.ts' }, { type: 'Remove', id: 2 });
  expect(readReferences(removed, read)).toEqual({ events: [] });
  expect(readReferences(session({ type: 'FileReferenced', id: 2, file: 'a.ts' }, { type: 'FileRead', id: 2, content: 'x' }), read)).toEqual({ events: [] });
});

import { beforeAll, expect, test } from 'bun:test';
import type { Split } from '../../core/approval/approval';
import { createSplit } from './split';

let split: Split;
beforeAll(async () => {
  split = await createSplit();
});

const texts = (command: string) => split(command)?.map(c => c.text);

test('a simple command is one sub-command with its literal arguments', () => {
  expect(split('grep -n "a b" \'c\' d\\ e src/x.ts')).toEqual([{ text: 'grep -n "a b" \'c\' d\\ e src/x.ts', args: ['-n', 'a b', 'c', 'd e', 'src/x.ts'], writes: [] }]);
});

test('lists, pipelines, subshells and loops are split into their simple commands', () => {
  expect(texts('ls -la && cat x | grep y; echo done || true')).toEqual(['ls -la', 'cat x', 'grep y', 'echo done', 'true']);
  expect(texts('(cd src && ls) & wait')).toEqual(['cd src', 'ls', 'wait']);
  expect(texts('for f in *; do rm $f; done')).toEqual(['rm $f']);
  expect(texts('if [[ -f x ]]; then cat x; fi')).toEqual(['[[ -f x ]]', 'cat x']);
});

test('command substitutions are sub-commands of their own; the argument is not literal', () => {
  expect(split('ls $(rm -rf x)')).toEqual([
    { text: 'ls $(rm -rf x)', args: [null], writes: [] },
    { text: 'rm -rf x', args: ['-rf', 'x'], writes: [] },
  ]);
  expect(texts('echo `whoami` "$(date)"')).toEqual(['echo `whoami` "$(date)"', 'whoami', 'date']);
  expect(texts('export X=$(pwd)')).toEqual(['export X=$(pwd)', 'pwd']);
});

test('expansions make an argument not literal; concatenations of literals are literal', () => {
  expect(split('cat $HOME/x "${A}" "~/lit" a"b"\'c\' 42')![0]!.args).toEqual([null, null, '~/lit', 'abc', '42']);
});

test('variable assignments stay part of the command text', () => {
  expect(texts('PAGER=cat git log')).toEqual(['PAGER=cat git log']);
});

test('output redirects are the files a command writes; input redirects are arguments; fd copies are neither', () => {
  expect(split('echo hi > out.txt 2>&1')).toEqual([{ text: 'echo hi', args: ['hi'], writes: ['out.txt'] }]);
  expect(split('sort < in.txt >> /tmp/sorted')).toEqual([{ text: 'sort', args: ['in.txt'], writes: ['/tmp/sorted'] }]);
  expect(split('ls 2>/dev/null &> "$LOG"')![0]!.writes).toEqual(['/dev/null', null]);
  expect(split('{ ls; pwd; } > all.txt')!.map(c => c.writes)).toEqual([['all.txt'], ['all.txt']]);
});

test('a heredoc feeding a command: its redirect is still found', () => {
  expect(split('cat <<EOF > notes.md\nhello\nEOF')).toEqual([{ text: 'cat', args: [], writes: ['notes.md'] }]);
});

test('what does not parse is null', () => {
  expect(split('echo "open')).toBeNull();
  expect(split('ls &&')).toBeNull();
  expect(split('if true; then')).toBeNull();
});

test('nothing to run: no sub-commands', () => {
  expect(split('# comment')).toEqual([]);
  expect(split('')).toEqual([]);
});

import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditor, createFileEditor } from './editor';

const bin = mkdtempSync(join(tmpdir(), 'resector-editor-bin-'));
// A fake editor: a script that runs `body` with the file as $1.
function script(name: string, body: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function editor(env: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), 'resector-editor-'));
  const calls: string[] = [];
  const edit = createEditor({ env, dir, suspend: () => calls.push('suspend'), resume: () => calls.push('resume') });
  return { edit, calls, files: () => readdirSync(dir) };
}

test('opens $EDITOR on a file with the text and returns the saved text; the file is removed', async () => {
  const { edit, files } = editor({ EDITOR: script('upper', `tr a-z A-Z < "$1" > "$1.new" && mv "$1.new" "$1"`) });
  expect(await edit('hello\nworld')).toBe('HELLO\nWORLD');
  expect(files()).toEqual([]);
});

test('$VISUAL wins over $EDITOR; the editor command may carry arguments', async () => {
  const append = script('append', `printf ' %s' "$2" >> "$3"`);
  const { edit } = editor({ VISUAL: `${append} dummy extra`, EDITOR: script('never', 'exit 9') });
  expect(await edit('text')).toBe('text extra');
});

test('the screen is handed to the editor and taken back', async () => {
  const { edit, calls } = editor({ EDITOR: script('noop', 'true') });
  await edit('x');
  expect(calls).toEqual(['suspend', 'resume']);
});

test('an editor exiting with an error (e.g. :cq) is an error, the screen is taken back', async () => {
  const { edit, calls, files } = editor({ EDITOR: script('fail', 'echo changed > "$1"; exit 1') });
  await expect(edit('x')).rejects.toThrow(/exited with 1/);
  expect(calls).toEqual(['suspend', 'resume']);
  expect(files()).toEqual([]);
});

test('a file is opened in $EDITOR itself, the screen handed over and taken back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resector-editor-file-'));
  const file = join(dir, 'a.ts');
  writeFileSync(file, 'x');
  const calls: string[] = [];
  const open = createFileEditor({ env: { EDITOR: script('mark', 'echo edited > "$1"') }, suspend: () => calls.push('suspend'), resume: () => calls.push('resume') });
  await open(file);
  expect(readFileSync(file, 'utf8')).toBe('edited\n');
  expect(calls).toEqual(['suspend', 'resume']);
  await expect(createFileEditor({ env: { EDITOR: script('fail2', 'exit 3') }, suspend() {}, resume() {} })(file)).rejects.toThrow(/exited with 3/);
});

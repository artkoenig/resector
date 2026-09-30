import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from './runner';

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'resector-run-')));
const run = (command: string, { timeout = 120, signal = new AbortController().signal } = {}) => {
  const chunks: string[] = [];
  const result = createRunner({ cwd, timeout }).run(command, { signal, onOutput: t => chunks.push(t) });
  return { result, chunks };
};

test('runs bash -c in the project root; stdout and stderr in one output, with the exit code', async () => {
  const { result, chunks } = run('pwd; echo err >&2; exit 3');
  expect(await result).toEqual({ output: `${cwd}\nerr\n`, exit: 3, stopped: null });
  expect(chunks.join('')).toBe(`${cwd}\nerr\n`);
});

test('stdin is /dev/null: a command reading it ends at once', async () => {
  expect(await run('cat; echo done').result).toEqual({ output: 'done\n', exit: 0, stopped: null });
});

test('the timeout stops the command and everything it started', async () => {
  const started = Date.now();
  const result = await run('echo before; sleep 5 | cat', { timeout: 0.3 }).result;
  expect(result).toEqual({ output: 'before\n', exit: null, stopped: 'timeout' });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(createRunner({ cwd, timeout: 7 }).timeout).toBe(7);
});

test('aborting kills the command; its output so far is kept', async () => {
  const abort = new AbortController();
  const { result, chunks } = run('echo partial; sleep 5', { signal: abort.signal });
  while (!chunks.length) await Bun.sleep(10);
  abort.abort();
  expect(await result).toEqual({ output: 'partial\n', exit: null, stopped: 'killed' });
});

test('an already aborted signal kills at once', async () => {
  const abort = new AbortController();
  abort.abort();
  expect((await run('sleep 5', { signal: abort.signal }).result).stopped).toBe('killed');
});

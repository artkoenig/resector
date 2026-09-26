import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearcher } from './ddgr';

// A fake ddgr on the PATH that echoes its arguments.
const bin = realpathSync(mkdtempSync(join(tmpdir(), 'resector-ddgr-')));
writeFileSync(join(bin, 'ddgr'), '#!/bin/sh\nprintf "%s|" "$@"\n');
chmodSync(join(bin, 'ddgr'), 0o755);

test('the query goes to ddgr as one argument after --, with JSON output and 5 results', async () => {
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const searcher = createSearcher({ cwd: bin, timeout: 30 });
    const result = await searcher.run('-x "a b"; rm', { signal: new AbortController().signal, onOutput: () => {} });
    expect(result).toEqual({ output: '--json|--noprompt|-n|5|--|-x "a b"; rm|', exit: 0, stopped: null });
    expect(searcher.timeout).toBe(30);
  } finally {
    process.env.PATH = path;
  }
});

test('without ddgr on the PATH, the result tells the model so instead of failing', async () => {
  const path = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), 'resector-empty-'));
  try {
    const result = await createSearcher({ cwd: bin, timeout: 30 }).run('bun', { signal: new AbortController().signal, onOutput: () => {} });
    expect(result).toEqual({ output: expect.stringContaining('ddgr not found'), exit: 127, stopped: null });
  } finally {
    process.env.PATH = path;
  }
});

// Starting Subagents: the process's arguments and environment.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackground } from './background';
import { createSubagents } from './subagent';

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'resector-subagent-')));
const registry = createBackground({ dir: join(cwd, 'logs'), record: join(cwd, 'ses.background') });
afterEach(() => registry.stopAll());

test('the process of a Subagent gets prompt, profile and flags unchanged, without a shell', async () => {
  const started: Parameters<typeof registry.start>[] = [];
  const recording = { ...registry, start: (...args: Parameters<typeof registry.start>) => (started.push(args), registry.start(['true'], args[1])) };
  const prompt = '-fix "it" $(rm x)\n`now`';
  await createSubagents({ cwd, profile: 'qwen', registry: recording }).run(prompt, { signal: new AbortController().signal, onOutput: () => {} });
  const [argv, { cwd: at, wait, env }] = started[0]!;
  expect(argv.slice(2)).toEqual([`--prompt=${prompt}`, '--model=qwen', '--auto-approve', '--show', 'tools']);
  expect({ at, wait, env }).toEqual({ at: cwd, wait: 0, env: { RESECTOR_SUBAGENT: 'start', RESECTOR_SUBAGENT_REPORTS: registry.dir } });
});

test('a process started from its arguments sees them as they are, and the environment added to it', async () => {
  const result = await registry.start(['sh', '-c', 'printf "%s|%s" "$1" "$ADDED"', 'sh', '$(x) "y"'], { cwd, wait: 5, signal: new AbortController().signal, env: { ADDED: 'yes' } });
  expect(result.output).toBe('$(x) "y"|yes');
});

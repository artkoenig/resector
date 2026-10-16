#!/usr/bin/env bun
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import pkg from '../package.json';
import { configPaths } from './adapters/fs/config';
import { projectSessionStore } from './adapters/store/sessions';
import { HeadlessSchema, SHOWN } from './core/config/config';
import type { Flags } from './core/config/headless';
import type { SessionRef } from './core/session/session';
import type { Run } from './cli/run';
import type { Start } from './ui/start';

export type Result = { code: number; out: string };
// --export-fixture: the Session Log as JSONL on stdout, for golden tests.
type ExportLog = (ref: SessionRef) => string;

const USAGE =
  'usage: resector [-c [id]] | resector -p <prompt> [options] | resector --export-fixture [id] | resector --version\n' +
  'options with -p: -m <profile> --policy <name|off> --thinking <off|on|level> --tools <list|none> --show <list|all> --max-turns <n> -w --auto-approve\n';
// The flags of a Headless Run: allowed only with -p.
const RUN_OPTIONS = {
  model: { type: 'string', short: 'm' },
  policy: { type: 'string' },
  thinking: { type: 'string' },
  tools: { type: 'string' },
  show: { type: 'string' },
  'max-turns': { type: 'string' },
  worktree: { type: 'boolean', short: 'w' },
  'auto-approve': { type: 'boolean' },
} as const;
const OPTIONS = { version: { type: 'boolean' }, continue: { type: 'boolean', short: 'c' }, 'export-fixture': { type: 'boolean' }, prompt: { type: 'string', short: 'p' }, ...RUN_OPTIONS } as const;
type Values = ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof OPTIONS }>>['values'];
const USAGE_ERROR: Result = { code: 2, out: USAGE };
const projectLog: ExportLog = ref => projectSessionStore(configPaths({ home: homedir(), cwd: process.cwd(), env: process.env })).exportLog(ref);

export function main(argv: string[], exportLog = projectLog): Result | { start: Start } | { run: Run } {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
    if (positionals.length > 1) return USAGE_ERROR;
    if (values.prompt === undefined && Object.keys(RUN_OPTIONS).some(k => k in values)) return USAGE_ERROR;
    return values['export-fixture'] ? { code: 0, out: exportLog(positionals[0] ?? true) } : command(values, positionals[0]);
  } catch (e) {
    return e instanceof TypeError ? USAGE_ERROR : { code: 1, out: `resector: ${(e as Error).message}\n` };
  }
}

// id: the one positional, taken by -c only.
function command(values: Values, id?: string): Result | { start: Start } | { run: Run } {
  if (values.version) return { code: 0, out: `resector ${pkg.version}\n` };
  if (values.prompt !== undefined) return runCommand(values.prompt, values, id);
  if (values.continue) return { start: { resume: id ?? true } };
  return id ? USAGE_ERROR : { start: {} };
}

// -p takes neither -c nor an id.
function runCommand(prompt: string, values: Values, id?: string): Result | { run: Run } {
  const flags = values.continue || id ? null : runFlags(values);
  return flags ? { run: { prompt, flags } } : USAGE_ERROR;
}

// The flags as the headless config section names them, checked like it; null for a bad value.
function runFlags(values: Values): Flags | null {
  const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean);
  const parsed = HeadlessSchema.safeParse({
    profile: values.model,
    policy: values.policy,
    thinking: values.thinking,
    tools: values.tools === undefined ? undefined : values.tools === 'none' ? [] : list(values.tools),
    show: values.show === 'all' ? SHOWN : values.show === undefined ? undefined : list(values.show),
    maxTurns: values['max-turns'] === undefined ? undefined : Number(values['max-turns']),
    worktree: values.worktree,
  });
  return parsed.success ? { ...parsed.data, autoApprove: values['auto-approve'] } : null;
}

if (import.meta.main) {
  const command = main(process.argv.slice(2));
  // bunfig.toml preloads Solid's reactive build only when started in this repository; resector runs in any project.
  if ('start' in command || 'run' in command) (await import('@opentui/solid/bun-plugin')).ensureSolidTransformPlugin();
  if ('start' in command) await (await import('./ui/start')).start(command.start);
  else if ('run' in command) {
    const { run, processIo } = await import('./cli/run');
    process.exit(await run(command.run, processIo()));
  } else {
    (command.code ? process.stderr : process.stdout).write(command.out);
    process.exit(command.code);
  }
}

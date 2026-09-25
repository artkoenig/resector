#!/usr/bin/env bun
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import pkg from '../package.json';
import { projectSessionStore } from './adapters/store/sessions';
import type { SessionRef } from './core/session/session';

export type Result = { code: number; out: string };
export type Start = { resume?: SessionRef };
// --export-fixture: the Session Log as JSONL on stdout, for golden tests (architecture §7).
type ExportLog = (ref: SessionRef) => string;

const USAGE = 'usage: resector [-c [id]] | resector --export-fixture [id] | resector --version\n';
const OPTIONS = { version: { type: 'boolean' }, continue: { type: 'boolean', short: 'c' }, 'export-fixture': { type: 'boolean' } } as const;
const USAGE_ERROR: Result = { code: 1, out: USAGE };
const projectLog: ExportLog = ref => projectSessionStore(homedir(), process.cwd()).exportLog(ref);

export function main(argv: string[], exportLog = projectLog): Result | { start: Start } {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
    if (positionals.length > 1) return USAGE_ERROR;
    return values['export-fixture'] ? { code: 0, out: exportLog(positionals[0] ?? true) } : command(values, positionals[0]);
  } catch (e) {
    return e instanceof TypeError ? USAGE_ERROR : { code: 1, out: `resector: ${(e as Error).message}\n` };
  }
}

// id: the one positional, taken by -c only.
function command(values: { version?: boolean; continue?: boolean }, id?: string): Result | { start: Start } {
  if (values.version) return { code: 0, out: `resector ${pkg.version}\n` };
  if (values.continue) return { start: { resume: id ?? true } };
  return id ? USAGE_ERROR : { start: {} };
}

if (import.meta.main) {
  const command = main(process.argv.slice(2));
  if ('start' in command) await (await import('./ui/start')).start(command.start);
  else {
    (command.code ? process.stderr : process.stdout).write(command.out);
    process.exit(command.code);
  }
}

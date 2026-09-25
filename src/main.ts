#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json';

export type Result = { code: number; out: string };
// resume: true = the last session of the project (FR-32).
export type Start = { resume?: true | string };
export type Command = Result | { start: Start } | { exportFixture: true | string };

const USAGE = 'usage: resector [-c [id]] | resector --export-fixture [id] | resector --version\n';

const OPTIONS = { version: { type: 'boolean' }, continue: { type: 'boolean', short: 'c' }, 'export-fixture': { type: 'boolean' } } as const;
const USAGE_ERROR: Result = { code: 1, out: USAGE };

export function main(argv: string[]): Command {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
    return positionals.length > 1 ? USAGE_ERROR : command(values, positionals[0]);
  } catch {
    return USAGE_ERROR;
  }
}

// id: the one positional, taken by -c and --export-fixture only.
function command(values: { version?: boolean; continue?: boolean; 'export-fixture'?: boolean }, id?: string): Command {
  if (values.version) return { code: 0, out: `resector ${pkg.version}\n` };
  if (values['export-fixture']) return { exportFixture: id ?? true };
  if (values.continue) return { start: { resume: id ?? true } };
  return id ? USAGE_ERROR : { start: {} };
}

async function run(command: Command) {
  if ('start' in command) return (await import('./ui/start')).start(command.start);
  if ('exportFixture' in command) return (await import('./ui/start')).exportFixture(command.exportFixture);
  process.stdout.write(command.out);
  process.exit(command.code);
}

if (import.meta.main) await run(main(process.argv.slice(2)));

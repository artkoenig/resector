#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json';

export type Result = { code: number; out: string };
export type Start = { endpoint: string };

const USAGE = 'usage: resector [--endpoint <url>] | resector --version\n';

export function main(argv: string[]): Result | Start {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { version: { type: 'boolean' }, endpoint: { type: 'string', default: 'http://localhost:8080' } },
    });
    return values.version ? { code: 0, out: `resector ${pkg.version}\n` } : { endpoint: values.endpoint };
  } catch {
    return { code: 1, out: USAGE };
  }
}

if (import.meta.main) {
  const command = main(process.argv.slice(2));
  if ('endpoint' in command) await (await import('./ui/start')).start(command.endpoint);
  else {
    process.stdout.write(command.out);
    process.exit(command.code);
  }
}

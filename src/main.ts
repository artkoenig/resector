#!/usr/bin/env bun
import pkg from '../package.json';

export type Result = { code: number; out: string };

export function main(argv: string[]): Result {
  if (argv[0] === '--version') return { code: 0, out: `resector ${pkg.version}\n` };
  return { code: 1, out: 'usage: resector --version\n' };
}

if (import.meta.main) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(out);
  process.exit(code);
}

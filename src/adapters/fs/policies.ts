// Context Policies from disk (ADR 0001): `<name>.ts` in `policies/` under the config root, loaded at start only.
// No project-level policies: a cloned repository must not be able to run code.
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Policy } from '../../core/policy/policy';

// failed: a policy that could not be loaded and why; it is not offered.
export type LoadedPolicies = { policies: Policy[]; failed: string[] };

// The built-in policies, then the files in name order; a file named like a built-in one replaces it.
export async function loadPolicies(dir: string, builtIn: Policy[] = []): Promise<LoadedPolicies> {
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.ts')).sort() : [];
  const loaded = await Promise.all(files.map(f => loadPolicy(join(dir, f))));
  const own = loaded.filter((p): p is Policy => typeof p !== 'string');
  const policies = [...builtIn.filter(b => !own.some(p => p.name === b.name)), ...own];
  return { policies, failed: loaded.filter((p): p is string => typeof p === 'string') };
}

// The module's default export is the policy function; its file name is the policy's name; a string export
// `description` says in a few words what it does.
async function loadPolicy(path: string): Promise<Policy | string> {
  const name = basename(path, '.ts');
  try {
    const { default: run, description } = await import(path);
    if (typeof run !== 'function') return `${name}: no default export function`;
    return typeof description === 'string' ? { name, run, description } : { name, run };
  } catch (e) {
    return `${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPaths } from './config';
import { loadPolicies, policiesDir } from './policies';

const dir = () => mkdtempSync(join(tmpdir(), 'resector-policies-'));

test('policies live in policies/ under the config root, also when RESECTOR_CONFIG moves the global config', () => {
  expect(policiesDir(configPaths({ home: '/h', cwd: '/p', env: {} }))).toBe('/h/.config/resector/policies');
  expect(policiesDir(configPaths({ home: '/h', cwd: '/p', env: { RESECTOR_CONFIG: '/tmp/c/config.jsonc' } }))).toBe('/h/.config/resector/policies');
});

test('each .ts file with a default export function is a policy named after the file', async () => {
  const root = dir();
  writeFileSync(join(root, 'trim.ts'), `export default (context: { blocks: { id: number }[] }) => context.blocks.slice(0, 1).map(b => ({ op: 'remove', id: b.id }));\n`);
  writeFileSync(join(root, 'none.ts'), "export const description = 'does nothing';\nexport default () => [];\n");
  writeFileSync(join(root, 'notes.md'), 'not a policy');
  const { policies, failed } = await loadPolicies(root);
  expect(policies.map(p => p.name)).toEqual(['none', 'trim']);
  expect(policies.map(p => p.description)).toEqual(['does nothing', undefined]);
  expect(await policies[1]!.run({ window: 1, used: 0, blocks: [{ id: 4 } as never] })).toEqual([{ op: 'remove', id: 4 }]);
  expect(failed).toEqual([]);
});

test('a policy that fails to load is reported and not offered', async () => {
  const root = dir();
  writeFileSync(join(root, 'broken.ts'), 'export default (;\n');
  writeFileSync(join(root, 'plain.ts'), 'export const rules = 1;\n');
  writeFileSync(join(root, 'ok.ts'), 'export default () => [];\n');
  const { policies, failed } = await loadPolicies(root);
  expect(policies.map(p => p.name)).toEqual(['ok']);
  expect(failed).toHaveLength(2);
  expect(failed[0]).toMatch(/^broken: \S/);
  expect(failed[1]).toBe('plain: no default export function');
});

test('built-in policies come first; a file of the same name replaces one; no directory, only them', async () => {
  const builtIn = [{ name: 'trail', run: () => [] }, { name: 'keep', run: () => [] }];
  const root = dir();
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'trail.ts'), 'export default () => [{ op: "remove", id: 1 }];\n');
  const { policies } = await loadPolicies(root, builtIn);
  expect(policies.map(p => p.name)).toEqual(['keep', 'trail']);
  expect(policies[1]!.run({ window: 1, used: 0, blocks: [] })).toEqual([{ op: 'remove', id: 1 }]);
  expect(await loadPolicies(join(root, 'missing'), builtIn)).toEqual({ policies: builtIn, failed: [] });
});

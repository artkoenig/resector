import { beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_INSTRUCTION } from '../../core/compaction/compaction';
import { DEFAULT_SYSTEM_PROMPT } from '../../core/config/system-prompt';
import { configPaths, loadConfig } from './config';

let home: string;
let cwd: string;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'resector-config-'));
  home = join(root, 'home');
  cwd = join(root, 'project');
});

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test('global and project config are found in their standard places and merged', () => {
  put(join(home, '.config/resector/config.jsonc'), '{ "profiles": { "qwen": { "backend": "llamacpp", "window": 8192 } }, "defaultProfile": "qwen" }');
  put(join(cwd, '.resector/config.jsonc'), '{ "profiles": { "qwen": { "window": 4096 } } }');
  const loaded = loadConfig(configPaths({ home, cwd, env: {} }));
  expect(loaded?.profile()).toMatchObject({ name: 'qwen', window: 4096 });
});

test('without any config file there is nothing to load (first start)', () => {
  expect(loadConfig(configPaths({ home, cwd, env: {} }))).toBeNull();
});

test('RESECTOR_CONFIG replaces the global config path', () => {
  put(join(home, '.config/resector/config.jsonc'), '{ "profiles": { "a": { "backend": "llamacpp" } }, "defaultProfile": "a" }');
  put(join(home, 'alt.jsonc'), '{ "profiles": { "b": { "backend": "ollama" } }, "defaultProfile": "b" }');
  const loaded = loadConfig(configPaths({ home, cwd, env: { RESECTOR_CONFIG: join(home, 'alt.jsonc') } }));
  expect(loaded?.profile().name).toBe('b');
  expect(Object.keys(loaded!.config.profiles)).toEqual(['b']);
});

test('the system prompt comes from the profile file, else system.md (project before global), else the default', () => {
  const paths = configPaths({ home, cwd, env: {} });
  put(paths.global, '{ "profiles": { "plain": { "backend": "llamacpp" }, "own": { "backend": "llamacpp", "systemPrompt": "own.md" } } }');
  const systemPrompt = (name: string) => {
    const loaded = loadConfig(paths)!;
    return loaded.systemPrompt(loaded.profile(name));
  };
  expect(systemPrompt('plain')).toBe(DEFAULT_SYSTEM_PROMPT);
  put(join(home, '.config/resector/system.md'), 'global prompt\n');
  expect(systemPrompt('plain')).toBe('global prompt\n');
  put(join(cwd, '.resector/system.md'), 'project prompt');
  expect(systemPrompt('plain')).toBe('project prompt');
  expect(() => systemPrompt('own')).toThrow(`system prompt of profile "own" not found: ${join(home, '.config/resector/own.md')}`);
  put(join(home, '.config/resector/own.md'), 'own prompt');
  expect(systemPrompt('own')).toBe('own prompt');
});

test('the default compaction instruction comes from compaction.md (project before global), else the shipped one (FR-13)', () => {
  const paths = configPaths({ home, cwd, env: {} });
  put(paths.global, '{}');
  expect(loadConfig(paths)!.compactionInstruction()).toBe(DEFAULT_INSTRUCTION);
  put(join(home, '.config/resector/compaction.md'), 'keep errors\n');
  expect(loadConfig(paths)!.compactionInstruction()).toBe('keep errors');
  put(join(cwd, '.resector/compaction.md'), 'keep paths');
  expect(loadConfig(paths)!.compactionInstruction()).toBe('keep paths');
});

import { beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_INSTRUCTION } from '../../core/compaction/compaction';
import { DEFAULT_SYSTEM_PROMPT } from '../../core/config/system-prompt';
import { configPaths, loadConfig, projectKey } from './config';

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

test('global and project config are found in their standard places and merged; .resector/ is not read', () => {
  put(join(home, '.config/resector/config.jsonc'), '{ "profiles": { "qwen": { "backend": "llamacpp", "window": 8192 } }, "defaultProfile": "qwen" }');
  put(join(cwd, '.resector/config.jsonc'), '{ "profiles": { "qwen": { "window": 1024 } } }');
  const paths = configPaths({ home, cwd, env: {} });
  expect(paths.project).toBe(join(paths.projectHome.config, 'config.jsonc'));
  expect(loadConfig(paths)?.profile()).toMatchObject({ name: 'qwen', window: 8192 });
  put(paths.project, '{ "profiles": { "qwen": { "window": 4096 } } }');
  expect(loadConfig(paths)?.profile()).toMatchObject({ name: 'qwen', window: 4096 });
});

test('the project config can loosen permissions: its rules come after the global ones', () => {
  const paths = configPaths({ home, cwd, env: {} });
  put(paths.global, '{ "permission": { "make *": "allow", "git commit *": "ask" } }');
  put(paths.project, '{ "permission": { "make *": "deny", "git commit *": "allow" } }');
  const { permissions } = loadConfig(paths)!;
  expect(permissions.filter(r => r.source !== 'built-in').map(r => [r.pattern, r.action, r.source])).toEqual([
    ['make *', 'allow', 'global'], ['git commit *', 'ask', 'global'], ['make *', 'deny', 'project'], ['git commit *', 'allow', 'project'],
  ]);
});

test('without any config file there is nothing to load (first start)', () => {
  expect(loadConfig(configPaths({ home, cwd, env: {} }))).toBeNull();
});

const keyOf = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd });
// A repository with one commit on main.
function repository(path: string) {
  put(join(path, 'src/a.ts'), 'a\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']]) git(path, ...args);
  return realpathSync(path);
}

test('the project key is the main checkout, the same from a subdirectory, a worktree and a symlink', () => {
  const repo = repository(cwd);
  const key = keyOf(repo);
  expect(projectKey(repo)).toBe(key);
  expect(projectKey(join(repo, 'src'))).toBe(key);
  git(repo, 'worktree', 'add', '-q', '-b', 'other', join(repo, '../wt'));
  expect(projectKey(join(repo, '../wt/src'))).toBe(key);
  symlinkSync(repo, join(repo, '../link'));
  expect(projectKey(join(repo, '../link/src'))).toBe(key);
  // GIT_DIR of a calling hook does not count.
  process.env.GIT_DIR = join(dirname(cwd), 'elsewhere/.git');
  try {
    expect(projectKey(join(repo, 'src'))).toBe(key);
  } finally {
    delete process.env.GIT_DIR;
  }
});

test('without git the project key is the start directory; a submodule is a project of its own, with its worktrees; so is a bare repository', () => {
  mkdirSync(join(cwd, 'sub'), { recursive: true });
  expect(projectKey(join(cwd, 'sub'))).toBe(keyOf(realpathSync(join(cwd, 'sub'))));
  const lib = repository(join(dirname(cwd), 'lib'));
  const repo = repository(cwd);
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
  expect(projectKey(join(repo, 'vendor/lib'))).toBe(keyOf(join(repo, 'vendor/lib')));
  git(join(repo, 'vendor/lib'), 'worktree', 'add', '-q', '-b', 'other', join(repo, '../lib-wt'));
  expect(projectKey(join(repo, '../lib-wt'))).toBe(keyOf(join(repo, 'vendor/lib')));
  // A bare repository's worktrees share it.
  git(dirname(cwd), 'clone', '-q', '--bare', lib, 'b.git');
  git(join(dirname(cwd), 'b.git'), 'worktree', 'add', '-q', '../bwt', 'main');
  expect(projectKey(join(dirname(cwd), 'bwt'))).toBe(keyOf(realpathSync(join(dirname(cwd), 'b.git'))));
});

test('the Project Home: one root under the XDG config home, one under the XDG data home, ~/.config and ~/.local/share by default', () => {
  const key = projectKey(cwd);
  expect(configPaths({ home: '/h', cwd, env: {} })).toMatchObject({
    global: '/h/.config/resector/config.jsonc',
    policies: '/h/.config/resector/policies',
    projectHome: { config: `/h/.config/resector/projects/${key}`, data: `/h/.local/share/resector/projects/${key}` },
  });
  expect(configPaths({ home: '/h', cwd, env: { XDG_CONFIG_HOME: '/x/conf', XDG_DATA_HOME: '/x/data' } })).toMatchObject({
    global: '/x/conf/resector/config.jsonc',
    policies: '/x/conf/resector/policies',
    projectHome: { config: `/x/conf/resector/projects/${key}`, data: `/x/data/resector/projects/${key}` },
  });
  // Relative XDG values do not count.
  expect(configPaths({ home: '/h', cwd, env: { XDG_CONFIG_HOME: 'conf', XDG_DATA_HOME: 'data' } }).projectHome).toEqual({
    config: `/h/.config/resector/projects/${key}`, data: `/h/.local/share/resector/projects/${key}`,
  });
});

test('RESECTOR_CONFIG moves neither the Project Home nor policies/', () => {
  const paths = configPaths({ home: '/h', cwd, env: { RESECTOR_CONFIG: '/x/c.jsonc' } });
  expect(paths.global).toBe('/x/c.jsonc');
  expect(paths.policies).toBe('/h/.config/resector/policies');
  expect(paths.projectHome).toEqual(configPaths({ home: '/h', cwd, env: {} }).projectHome);
});

test('RESECTOR_CONFIG replaces the global config path', () => {
  put(join(home, '.config/resector/config.jsonc'), '{ "profiles": { "a": { "backend": "llamacpp" } }, "defaultProfile": "a" }');
  put(join(home, 'alt.jsonc'), '{ "profiles": { "b": { "backend": "ollama" } }, "defaultProfile": "b" }');
  const loaded = loadConfig(configPaths({ home, cwd, env: { RESECTOR_CONFIG: join(home, 'alt.jsonc') } }));
  expect(loaded?.profile().name).toBe('b');
  expect(Object.keys(loaded!.config.profiles)).toEqual(['b']);
});

test('the system prompt comes from the profile file, else system.md (Project Home before global), else the default', () => {
  // No project config.jsonc: system.md in the Project Home counts anyway.
  const paths = configPaths({ home, cwd, env: {} });
  put(paths.global, '{ "profiles": { "plain": { "backend": "llamacpp" }, "own": { "backend": "llamacpp", "systemPrompt": "own.md" } } }');
  const systemPrompt = (name: string) => {
    const loaded = loadConfig(paths)!;
    return loaded.systemPrompt(loaded.profile(name));
  };
  expect(systemPrompt('plain')).toBe(DEFAULT_SYSTEM_PROMPT);
  put(join(home, '.config/resector/system.md'), 'global prompt\n');
  expect(systemPrompt('plain')).toBe('global prompt\n');
  put(join(cwd, '.resector/system.md'), 'old place');
  expect(systemPrompt('plain')).toBe('global prompt\n');
  put(join(paths.projectHome.config, 'system.md'), 'project prompt');
  expect(systemPrompt('plain')).toBe('project prompt');
  expect(() => systemPrompt('own')).toThrow(`system prompt of profile "own" not found: ${join(home, '.config/resector/own.md')}`);
  put(join(home, '.config/resector/own.md'), 'own prompt');
  expect(systemPrompt('own')).toBe('own prompt');
});

test('the default compaction instruction comes from compaction.md (Project Home before global), else the shipped one', () => {
  const paths = configPaths({ home, cwd, env: {} });
  put(paths.global, '{}');
  expect(loadConfig(paths)!.compactionInstruction()).toBe(DEFAULT_INSTRUCTION);
  put(join(home, '.config/resector/compaction.md'), 'keep errors\n');
  expect(loadConfig(paths)!.compactionInstruction()).toBe('keep errors');
  put(join(cwd, '.resector/compaction.md'), 'old place');
  expect(loadConfig(paths)!.compactionInstruction()).toBe('keep errors');
  put(join(paths.projectHome.config, 'compaction.md'), 'keep paths');
  expect(loadConfig(paths)!.compactionInstruction()).toBe('keep paths');
});

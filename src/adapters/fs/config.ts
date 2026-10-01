// Where resector's files are (global config, policies/, the Project Home of ADR 0004), and reading the config files.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_INSTRUCTION } from '../../core/compaction/compaction';
import { initialConfig, readConfig, type BackendKind, type ConfigFile, type ModelProfile } from '../../core/config/config';
import { DEFAULT_SYSTEM_PROMPT } from '../../core/config/system-prompt';
import { mainCheckout } from '../git/git';

// projectHome: what the user edits for the Project (config) and what resector writes for it (data).
export type ConfigPaths = { global: string; project: string; policies: string; projectHome: { config: string; data: string } };

export function configPaths({ home, cwd, env }: { home: string; cwd: string; env: Record<string, string | undefined> }): ConfigPaths {
  // XDG values count only if absolute, as the spec says.
  const xdg = (name: string, fallback: string) => join(isAbsolute(env[name] ?? '') ? env[name]! : join(home, fallback), 'resector');
  const config = xdg('XDG_CONFIG_HOME', '.config');
  const key = projectKey(cwd);
  return {
    global: env.RESECTOR_CONFIG ?? join(config, 'config.jsonc'),
    project: join(cwd, '.resector/config.jsonc'),
    policies: join(config, 'policies'),
    projectHome: { config: join(config, 'projects', key), data: join(xdg('XDG_DATA_HOME', '.local/share'), 'projects', key) },
  };
}

const realpath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

// The main checkout's realpath, every non-alphanumeric character a `-`: the same from every subdirectory and
// worktree. Without git, the start directory.
export function projectKey(cwd: string): string {
  const start = realpath(cwd);
  return realpath(mainCheckout(start) ?? start).replace(/[^a-zA-Z0-9]/g, '-');
}

// Null when no config file exists yet (first start).
export function loadConfig(paths: ConfigPaths) {
  const files: ConfigFile[] = [paths.global, paths.project]
    .filter(path => existsSync(path))
    .map(path => ({ source: path, text: readFileSync(path, 'utf8'), project: path === paths.project }));
  if (!files.length) return null;
  const config = readConfig(files);
  // Profile file, else system.md next to the project config, else next to the global one, else shipped.
  const beside = (name: string) => [paths.project, paths.global].map(p => join(dirname(p), name)).find(p => existsSync(p));
  const systemPrompt = ({ name, systemPrompt: own }: ModelProfile) => {
    if (own && !existsSync(own)) throw new Error(`system prompt of profile "${name}" not found: ${own}`);
    const path = own ?? beside('system.md');
    return path ? readFileSync(path, 'utf8') : DEFAULT_SYSTEM_PROMPT;
  };
  // Compaction.md next to the project config, else next to the global one, else shipped. One line in the input.
  const compactionInstruction = () => {
    const path = beside('compaction.md');
    return path ? readFileSync(path, 'utf8').trim() : DEFAULT_INSTRUCTION;
  };
  return { ...config, systemPrompt, compactionInstruction };
}

// First start: the chosen model becomes the global config (the only config Resector ever writes).
export function writeInitialConfig(paths: ConfigPaths, model: { backend: BackendKind; endpoint: string; model: string }) {
  mkdirSync(dirname(paths.global), { recursive: true });
  writeFileSync(paths.global, initialConfig(model));
}

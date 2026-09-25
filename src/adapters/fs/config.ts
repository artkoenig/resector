// Reads the config files from disk (FR-42): global, then project; RESECTOR_CONFIG replaces the global path.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initialConfig, readConfig, type BackendKind, type ConfigFile, type ModelProfile } from '../../core/config/config';
import { DEFAULT_SYSTEM_PROMPT } from '../../core/config/system-prompt';

export type ConfigPaths = { global: string; project: string };

export function configPaths({ home, cwd, env }: { home: string; cwd: string; env: Record<string, string | undefined> }): ConfigPaths {
  return {
    global: env.RESECTOR_CONFIG ?? join(home, '.config/resector/config.jsonc'),
    project: join(cwd, '.resector/config.jsonc'),
  };
}

// Null when no config file exists yet (first start, FR-45).
export function loadConfig(paths: ConfigPaths) {
  const files: ConfigFile[] = [paths.global, paths.project]
    .filter(path => existsSync(path))
    .map(path => ({ source: path, text: readFileSync(path, 'utf8') }));
  if (!files.length) return null;
  const config = readConfig(files);
  // FR-31: profile file, else system.md next to the project config, else next to the global one, else shipped.
  const systemPrompt = ({ name, systemPrompt: own }: ModelProfile) => {
    if (own && !existsSync(own)) throw new Error(`system prompt of profile "${name}" not found: ${own}`);
    const path = own ?? [paths.project, paths.global].map(p => join(dirname(p), 'system.md')).find(p => existsSync(p));
    return path ? readFileSync(path, 'utf8') : DEFAULT_SYSTEM_PROMPT;
  };
  return { ...config, systemPrompt };
}

// First start: the chosen model becomes the global config (the only config Resector ever writes, FR-44).
export function writeInitialConfig(paths: ConfigPaths, model: { backend: BackendKind; endpoint: string; model: string }) {
  mkdirSync(dirname(paths.global), { recursive: true });
  writeFileSync(paths.global, initialConfig(model));
}

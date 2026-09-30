// Reads the config files from disk: global, then project; RESECTOR_CONFIG replaces the global path.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_INSTRUCTION } from '../../core/compaction/compaction';
import { initialConfig, readConfig, type BackendKind, type ConfigFile, type ModelProfile } from '../../core/config/config';
import { DEFAULT_SYSTEM_PROMPT } from '../../core/config/system-prompt';

export type ConfigPaths = { global: string; project: string };

export function configPaths({ home, cwd, env }: { home: string; cwd: string; env: Record<string, string | undefined> }): ConfigPaths {
  return {
    global: env.RESECTOR_CONFIG ?? join(home, '.config/resector/config.jsonc'),
    project: join(cwd, '.resector/config.jsonc'),
  };
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

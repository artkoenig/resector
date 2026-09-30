// Configuration (PRD §Configuration, architecture §6): JSONC files, deep merged, validated, Model Profiles resolved.
import { dirname, isAbsolute, join } from 'node:path';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { permissionRules, type Permissions } from '../approval/approval';


const BackendKindSchema = z.enum(['llamacpp', 'ollama', 'lmstudio', 'omlx']);
export type BackendKind = z.infer<typeof BackendKindSchema>;

// Where each backend listens by default; also the ports scanned at first start (FR-45). LM Studio and oMLX share 1234.
export const DEFAULT_ENDPOINTS: Record<BackendKind, string> = {
  llamacpp: 'http://localhost:8080',
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  omlx: 'http://localhost:1234',
};


const ProfileSchema = z.strictObject({
  backend: BackendKindSchema,
  endpoint: z.string().optional().describe('Server URL; default per backend (8080, 11434, 1234 on localhost)'),
  model: z.string().optional().describe('Model name as the backend knows it'),
  window: z.number().int().positive().optional().describe('Context window in tokens; auto-detected when absent'),
  tokenizer: z.string().optional().describe('Tokenizer path; auto-detected when absent'),
  toolProtocol: z.enum(['native', 'text-xml']).default('native'),
  resultFormat: z.enum(['native', 'toon']).default('native'),
  sampling: z.record(z.string(), z.number()).default({}).describe('Sampling parameters sent with every request, e.g. temperature'),
  thinking: z.string().default('off').describe('Reasoning at session start: off, on (enable_thinking) or an effort level (reasoning_effort) the chat template accepts; `/thinking` switches it'),
  compactionProfile: z.string().optional().describe('Model Profile used for Compaction; default: this one'),
  systemPrompt: z.string().optional().describe('System prompt file, relative to this config file'),
});

const PermissionSchema = z.record(z.string(), z.enum(['allow', 'ask', 'deny']));

const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  profiles: z.record(z.string(), ProfileSchema).default({}),
  defaultProfile: z.string().optional().describe('Model Profile for new sessions'),
  defaultPolicy: z.string().optional().describe('Context Policy switched on for new sessions; /policy switches it'),
  permission: PermissionSchema.optional().describe('bash command pattern → decision; project config may only tighten'),
  keybindings: z.record(z.string(), z.string()).optional().describe('Action → key'),
  bash: z.strictObject({ timeout: z.number().positive().optional().describe('Seconds (default 120)') }).optional(),
});

export const SCHEMA_URL = 'https://raw.githubusercontent.com/artkoenig/resector/main/config.schema.json';

// Written to config.schema.json (`bun run schema`), referenced by `$schema` in config files.
export const configJsonSchema = () => z.toJSONSchema(ConfigSchema, { io: 'input' });

export type Config = z.infer<typeof ConfigSchema>;
export type ModelProfile = z.infer<typeof ProfileSchema> & { name: string; endpoint: string };
// project: the project config, which may only tighten permissions (FR-25).
export type ConfigFile = { source: string; text: string; project?: boolean };

export function readConfig(files: ConfigFile[]) {
  const parsed = files.map(file => ({ ...file, json: parseFile(file) }));
  const result = ConfigSchema.safeParse(parsed.map(f => f.json).reduce(merge, {}));
  if (!result.success) throw new Error(`invalid config: ${result.error.issues.map(describe).join('; ')}`);
  const config = result.data;
  // Rules keep their file: global ones first, then the project's without its allows (FR-25).
  const permissions = (project: boolean) =>
    parsed.filter(f => (f.project ?? false) === project).reduce<Permissions>((all, f) => ({ ...all, ...permissionOf(f.source, f.json) }), {});
  return {
    config,
    permissions: permissionRules(permissions(false), permissions(true)),
    profile(name = config.defaultProfile): ModelProfile {
      if (name === undefined) throw new Error('no defaultProfile in config');
      const profile = config.profiles[name];
      if (!profile) throw new Error(`Model Profile "${name}" not in config (profiles: ${Object.keys(config.profiles).join(', ')})`);
      return { name, ...profile, endpoint: profile.endpoint ?? DEFAULT_ENDPOINTS[profile.backend] };
    },
  };
}

// FR-45: the model chosen at first start becomes the default Model Profile, named after the model file.
export function initialConfig({ backend, endpoint, model }: { backend: BackendKind; endpoint: string; model: string }): string {
  const name = model.replace(/.*\//, '').replace(/\.gguf$/, '').replace(/:/g, '-');
  const config = { $schema: SCHEMA_URL, profiles: { [name]: { backend, endpoint, model } }, defaultProfile: name };
  return JSON.stringify(config, null, 2) + '\n';
}

type Json = Record<string, unknown>;

function parseFile({ source, text }: ConfigFile): Json {
  const errors: ParseError[] = [];
  const json = parse(text, errors, { allowTrailingComma: true });
  const [error] = errors;
  if (error) {
    const lines = text.slice(0, error.offset).split('\n');
    throw new Error(`${source}:${lines.length}:${lines.at(-1)!.length + 1}: ${printParseErrorCode(error.error)}`);
  }
  return resolvePaths(json, dirname(source));
}

// Paths in a config file are relative to that file, so they must be anchored before merging.
function resolvePaths(json: Json, dir: string): Json {
  const profiles = isObject(json.profiles) ? json.profiles : {};
  for (const profile of Object.values(profiles).filter(isObject)) {
    const path = profile.systemPrompt;
    if (typeof path === 'string' && !isAbsolute(path)) profile.systemPrompt = join(dir, path);
  }
  return json;
}

// A file's own permission rules; one overridden by a later file is checked here.
function permissionOf(source: string, json: Json): Permissions {
  const result = PermissionSchema.optional().safeParse(json.permission);
  if (!result.success) throw new Error(`invalid config: ${source}: ${result.error.issues.map(i => describe({ ...i, path: ['permission', ...i.path] })).join('; ')}`);
  return result.data ?? {};
}

const describe = (issue: z.core.$ZodIssue) => (issue.path.length ? `${issue.path.join('.')}: ` : '') + issue.message;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Objects merge key by key; anything else (arrays included) is replaced by the later file.
// Permission rules are read per file, so project loosening can be ignored (FR-25).
function merge(base: Json, override: Json): Json {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isObject(current) && isObject(value) ? merge(current, value) : value;
  }
  return result;
}

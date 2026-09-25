import { expect, test } from 'bun:test';
import { configJsonSchema, initialConfig, readConfig, SCHEMA_URL } from './config';

test('a JSONC config with comments and trailing commas resolves its default Model Profile', () => {
  const config = readConfig([
    {
      source: 'global',
      text: `{
        // local llama.cpp
        "$schema": "https://example.com/config.schema.json",
        "profiles": { "qwen": { "backend": "llamacpp", }, },
        "defaultProfile": "qwen",
      }`,
    },
  ]);
  expect(config.profile()).toEqual({
    name: 'qwen',
    backend: 'llamacpp',
    endpoint: 'http://localhost:8080',
    toolProtocol: 'native',
    resultFormat: 'native',
    sampling: {},
    thinking: 'off',
  });
});

test('the project config is deep merged over the global one', () => {
  const { profile } = readConfig([
    {
      source: 'global',
      text: `{
        "profiles": {
          "qwen": { "backend": "llamacpp", "window": 8192, "sampling": { "temperature": 0.7, "top_p": 0.8 } },
          "gemma": { "backend": "ollama", "model": "gemma3:4b" }
        },
        "defaultProfile": "gemma"
      }`,
    },
    { source: 'project', text: '{ "profiles": { "qwen": { "sampling": { "temperature": 0.2 } } }, "defaultProfile": "qwen" }' },
  ]);
  expect(profile()).toMatchObject({ name: 'qwen', window: 8192, sampling: { temperature: 0.2, top_p: 0.8 } });
  expect(profile('gemma')).toMatchObject({ backend: 'ollama', model: 'gemma3:4b', endpoint: 'http://localhost:11434' });
});

test('each backend has its default local endpoint', () => {
  const { profile } = readConfig([{ source: 'global', text: '{ "profiles": { "l": { "backend": "lmstudio" } } }' }]);
  expect(profile('l').endpoint).toBe('http://localhost:1234');
});

test('a later file replaces values of another type instead of merging into them', () => {
  const files = [
    { source: 'global', text: '{ "keybindings": { "send": "ctrl+s" } }' },
    { source: 'project', text: '{ "keybindings": "none" }' },
  ];
  expect(() => readConfig(files)).toThrow('invalid config: keybindings: Invalid input: expected record, received string');
});

test('a profile that is not an object is a validation error', () => {
  expect(() => readConfig([{ source: 'global', text: '{ "profiles": { "a": null, "b": 3 } }' }])).toThrow(
    'invalid config: profiles.a: Invalid input: expected object, received null; profiles.b: Invalid input: expected object, received number',
  );
});

test('a JSONC syntax error names the file, line and column', () => {
  expect(() => readConfig([{ source: '/home/me/config.jsonc', text: '{\n  "profiles": {}\n  "defaultProfile": "x"\n}' }])).toThrow(
    '/home/me/config.jsonc:3:3: CommaExpected',
  );
});

test('an invalid config names every offending key', () => {
  const invalid = [{ source: 'global', text: '{ "profiles": { "qwen": { "backend": "vllm", "window": -1 } }, "colour": "red" }' }];
  expect(() => readConfig(invalid)).toThrow(
    'invalid config: profiles.qwen.backend: Invalid option: expected one of "llamacpp"|"ollama"|"lmstudio"; ' +
      'profiles.qwen.window: Too small: expected number to be >0; Unrecognized key: "colour"',
  );
});

test('a missing or unknown Model Profile is an error', () => {
  const text = '{ "profiles": { "qwen": { "backend": "llamacpp" }, "phi": { "backend": "llamacpp" } } }';
  const { profile } = readConfig([{ source: 'global', text }]);
  expect(() => profile()).toThrow('no defaultProfile in config');
  expect(() => profile('gemma')).toThrow('Model Profile "gemma" not in config (profiles: qwen, phi)');
});

test('a profile systemPrompt path is relative to the config file declaring it', () => {
  const { profile } = readConfig([
    { source: '/home/me/.config/resector/config.jsonc', text: '{ "profiles": { "a": { "backend": "llamacpp", "systemPrompt": "prompts/a.md" } } }' },
    { source: '/work/app/.resector/config.jsonc', text: '{ "profiles": { "b": { "backend": "llamacpp", "systemPrompt": "b.md" }, "c": { "backend": "llamacpp", "systemPrompt": "/etc/c.md" } } }' },
  ]);
  expect(profile('a').systemPrompt).toBe('/home/me/.config/resector/prompts/a.md');
  expect(profile('b').systemPrompt).toBe('/work/app/.resector/b.md');
  expect(profile('c').systemPrompt).toBe('/etc/c.md');
});

test('permission rules, keybindings and the bash timeout are read from config', () => {
  const { config } = readConfig([
    { source: 'global', text: '{ "permission": { "git push *": "ask", "rm *": "deny" }, "keybindings": { "send": "ctrl+s" }, "bash": { "timeout": 60 } }' },
  ]);
  expect(config).toEqual({
    profiles: {},
    permission: { 'git push *': 'ask', 'rm *': 'deny' },
    keybindings: { send: 'ctrl+s' },
    bash: { timeout: 60 },
  });
  expect(() => readConfig([{ source: 'global', text: '{ "permission": { "rm *": "never" }, "bash": { "timeout": 0 } }' }])).toThrow(
    'invalid config: permission.rm *: Invalid option: expected one of "allow"|"ask"|"deny"; bash.timeout: Too small: expected number to be >0',
  );
});

test('the published JSON Schema matches the config schema', async () => {
  expect(await Bun.file(`${import.meta.dir}/../../../config.schema.json`).json()).toEqual(configJsonSchema());
});

test('the first-start config holds the chosen model as the default Model Profile', () => {
  const text = initialConfig({ backend: 'ollama', endpoint: 'http://localhost:11434', model: 'gemma3:4b' });
  expect(SCHEMA_URL).toEndWith('/config.schema.json');
  expect(JSON.parse(text).$schema).toBe(SCHEMA_URL);
  expect(text).toEndWith('}\n');
  expect(readConfig([{ source: 'global', text }]).profile()).toMatchObject({
    name: 'gemma3-4b',
    backend: 'ollama',
    endpoint: 'http://localhost:11434',
    model: 'gemma3:4b',
  });
  const name = (model: string) => readConfig([{ source: 'global', text: initialConfig({ backend: 'llamacpp', endpoint: 'x', model }) }]).profile().name;
  expect(name('models/Qwen3-8B-Q4_K_M.gguf')).toBe('Qwen3-8B-Q4_K_M');
  expect(name('my.gguf-v2.gguf')).toBe('my.gguf-v2');
});

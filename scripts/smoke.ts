// Smoke test for a compiled release binary (NFR-5): prints the version, and renders the Gate
// in a pseudo-terminal against the fake backend — proof the embedded OpenTUI native library loads.
//   bun scripts/smoke.ts <binary> <version>
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeLlamaCpp } from '../test/fake-llamacpp';

const [binary, version] = process.argv.slice(2);
if (!binary || !version) throw new Error('usage: bun scripts/smoke.ts <binary> <version>');
const bin = resolve(binary);

const out = (await Bun.$`${bin} --version`.text()).trim();
if (out !== `resector ${version}`) throw new Error(`--version printed "${out}", expected "resector ${version}"`);
console.log(out);

// The Gate header shows the Model Profile of the config written here.
const EXPECTED = 'probe';
const fake = startFakeLlamaCpp();
const home = mkdtempSync(join(tmpdir(), 'resector-smoke-'));
const config = join(home, 'config.jsonc');
writeFileSync(config, JSON.stringify({ profiles: { probe: { backend: 'llamacpp', endpoint: fake.url } }, defaultProfile: 'probe' }));
let screen = '';
const rendered = Promise.withResolvers<void>();
const proc = Bun.spawn([bin], {
  cwd: home,
  env: { ...process.env, HOME: home, RESECTOR_CONFIG: config },
  terminal: {
    cols: 100,
    rows: 30,
    data: (_, data) => {
      screen += new TextDecoder().decode(data);
      if (screen.includes(EXPECTED)) rendered.resolve();
    },
  },
});
const timeout = setTimeout(() => rendered.reject(new Error(`no Gate frame within 15 s:\n${screen}`)), 15_000);
proc.exited.then(code => rendered.reject(new Error(`exited with ${code} before rendering:\n${screen}`)));
try {
  await rendered.promise;
  console.log('Gate rendered');
} finally {
  clearTimeout(timeout);
  proc.kill();
  fake.stop();
}
process.exit(0);

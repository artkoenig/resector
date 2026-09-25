// Compiles single-file binaries (NFR-5) and packs them as release assets in dist/.
//   bun scripts/build.ts [--tag v1.2.3] [--target linux-x64 ...]
// Cross-compiling embeds OpenTUI's native library only if every platform's
// @opentui/core-* package is installed: run `bun install --os='*' --cpu='*'` first.
import { $ } from 'bun';
import solid from '@opentui/solid/bun-plugin';
import { parseArgs } from 'node:util';
import pkg from '../package.json';
import { TARGETS, assetName, versionFromTag, type Target } from './release';

const { values } = parseArgs({
  options: { tag: { type: 'string' }, target: { type: 'string', multiple: true } },
});
const version = values.tag ? versionFromTag(values.tag, pkg.version) : pkg.version;
const targets = (values.target ?? TARGETS) as Target[];
for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t}`);

await $`rm -rf dist`;
const sums: string[] = [];
for (const target of targets) {
  const dir = `dist/${target}`;
  const build = await Bun.build({
    entrypoints: ['src/main.ts'],
    plugins: [solid], // Solid JSX transform; bunfig's runtime preload does not reach the bundler
    minify: true,
    // Resector runs inside users' projects: their bunfig.toml and .env must not configure it.
    compile: { target: `bun-${target}`, outfile: `${dir}/resector`, autoloadBunfig: false, autoloadDotenv: false },
  });
  if (!build.success) throw new AggregateError(build.logs, `build failed for ${target}`);
  await $`cp LICENSE ${dir}/`;
  const asset = assetName(version, target);
  await $`tar -czf dist/${asset} -C ${dir} resector LICENSE`;
  const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(`dist/${asset}`).bytes()).digest('hex');
  sums.push(`${hash}  ${asset}\n`);
}
await Bun.write('dist/SHA256SUMS', sums.join(''));
console.log(sums.join(''));

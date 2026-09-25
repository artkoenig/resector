// Compiles single-file binaries (NFR-5) and packs them as release assets in dist/.
//   bun scripts/build.ts [--tag v1.2.3] [--target linux-x64 ...]
// Cross-compiling embeds OpenTUI's native library only if every platform's
// @opentui/core-* package is installed: run `bun install --os='*' --cpu='*'` first.
import { $ } from 'bun';
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
  await $`bun build --compile --minify --target=bun-${target} src/main.ts --outfile ${dir}/resector`;
  await $`cp LICENSE ${dir}/`;
  const asset = assetName(version, target);
  await $`tar -czf dist/${asset} -C ${dir} resector LICENSE`;
  const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(`dist/${asset}`).bytes()).digest('hex');
  sums.push(`${hash}  ${asset}\n`);
}
await Bun.write('dist/SHA256SUMS', sums.join(''));
console.log(sums.join(''));

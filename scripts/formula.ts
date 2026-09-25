// Renders the Homebrew formula for a release from its SHA256SUMS.
//   bun scripts/formula.ts --tag v1.2.3 [--sums dist/SHA256SUMS] [--repo owner/name] > resector.rb
import { parseArgs } from 'node:util';
import pkg from '../package.json';
import { parseChecksums, renderFormula, versionFromTag } from './release';

const { values } = parseArgs({
  options: {
    tag: { type: 'string', default: `v${pkg.version}` },
    sums: { type: 'string', default: 'dist/SHA256SUMS' },
    repo: { type: 'string', default: 'artkoenig/resector' },
  },
});
const version = versionFromTag(values.tag, pkg.version);
const checksums = parseChecksums(await Bun.file(values.sums).text());
process.stdout.write(renderFormula({ version, repo: values.repo, checksums }));

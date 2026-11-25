// Prints the Homebrew formula of a release.
//   bun scripts/formula.ts v1.2.3 SHA256SUMS > resector.rb
import pkg from '../package.json';
import { formula, versionFromTag } from './release';

const [tag, sums] = process.argv.slice(2);
if (!tag || !sums) throw new Error('usage: bun scripts/formula.ts <tag> <SHA256SUMS>');
process.stdout.write(formula(versionFromTag(tag, pkg.version), await Bun.file(sums).text()));

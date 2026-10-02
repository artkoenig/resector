// Release helpers (NFR-5): compile targets, tag check, asset naming.
// Pure; scripts/build.ts does the I/O.

export const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const;
export type Target = (typeof TARGETS)[number];

export function versionFromTag(tag: string, pkgVersion: string): string {
  if (!tag.startsWith('v')) throw new Error(`tag "${tag}" must look like v<version>`);
  if (tag.slice(1) !== pkgVersion)
    throw new Error(`tag ${tag} does not match package.json version ${pkgVersion}`);
  return pkgVersion;
}

export const assetName = (version: string, target: Target) =>
  `resector-v${version}-${target}.tar.gz`;

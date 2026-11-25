import { expect, test } from 'bun:test';
import { TARGETS, assetName, formula, versionFromTag } from './release';

test('targets are the four NFR-5 platforms', () => {
  expect(TARGETS).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']);
});

test('a tag matching the package version yields the version', () => {
  expect(versionFromTag('v1.2.3', '1.2.3')).toBe('1.2.3');
});

test('a tag without the v prefix is rejected', () => {
  expect(() => versionFromTag('1.2.3', '1.2.3')).toThrow('tag "1.2.3" must look like v<version>');
});

test('a tag that disagrees with package.json is rejected', () => {
  expect(() => versionFromTag('v1.2.4', '1.2.3'))
    .toThrow('tag v1.2.4 does not match package.json version 1.2.3');
});

test('asset names carry version and target', () => {
  expect(assetName('1.2.3', 'darwin-arm64')).toBe('resector-v1.2.3-darwin-arm64.tar.gz');
});

const sums = TARGETS.map((t, i) => `${String(i).repeat(64)}  ${assetName('1.2.3', t)}\n`);

test('the formula pairs every target with its own checksum', () => {
  const rb = formula('1.2.3', sums.join(''));
  TARGETS.forEach((t, i) =>
    expect(rb).toContain(`/releases/download/v1.2.3/resector-v1.2.3-${t}.tar.gz"\n      sha256 "${String(i).repeat(64)}"`));
});

test('a target without a checksum is rejected', () => {
  expect(() => formula('1.2.3', sums.slice(1).join('')))
    .toThrow('no checksum for resector-v1.2.3-darwin-arm64.tar.gz in SHA256SUMS');
});

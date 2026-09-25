# Releasing

Distribution per NFR-5: single binaries from `bun build --compile` for darwin-arm64/x64 and linux-x64/arm64, on GitHub Releases and the Homebrew tap `artkoenig/homebrew-tap`.

1. Bump `version` in `package.json` and merge to `main`.
2. Tag and push: `git tag v<version> && git push origin v<version>`. The tag must match `package.json`, otherwise the build fails.
3. `.github/workflows/release.yml` then builds all targets, smoke-tests `resector --version` on a native runner per target, creates the GitHub Release (tarballs, `SHA256SUMS`, `resector.rb`) and commits `Formula/resector.rb` to the tap.

Users install with `brew install artkoenig/tap/resector` or by unpacking a release tarball. Update via `brew upgrade`; there is no auto-update.

## One-time setup

- Create the public repo `artkoenig/homebrew-tap`.
- Add a repo secret `HOMEBREW_TAP_TOKEN` with contents write access to the tap. Without it the tap step only warns; the formula is still attached to the release.

## Local build

```sh
bun install --os='*' --cpu='*'   # every platform's OpenTUI native library, needed to cross-compile
bun scripts/build.ts             # all targets → dist/; --target linux-x64 for one
bun scripts/formula.ts > dist/resector.rb
```

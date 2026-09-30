# Releasing

Distribution: single binaries from `bun build --compile` for darwin-arm64/x64 and linux-x64/arm64, on GitHub Releases and the Homebrew tap `artkoenig/homebrew-tap`.

1. Optionally run the live suite against a local backend (`bun test:live`).
2. Bump `version` in `package.json` and merge to `main`.
3. Tag and push: `git tag v<version> && git push origin v<version>`. The tag must match `package.json`, otherwise the build fails.
4. `.github/workflows/release.yml` runs the full gate (`bun run gate`), builds all targets, smoke-tests each binary on a native runner (`scripts/smoke.ts`: `--version`, then the Gate rendered in a PTY against the fake backend), creates the GitHub Release (tarballs, `SHA256SUMS`, `resector.rb`) and commits `Formula/resector.rb` to the tap.

Users install with `brew install artkoenig/tap/resector` or by unpacking a release tarball. Update via `brew upgrade`; there is no auto-update.

## One-time setup

- Create the public repo `artkoenig/homebrew-tap`.
- The repo must be public (planned for v1): Homebrew downloads release assets anonymously, and the `ubuntu-24.04-arm` smoke runner may be unavailable to private repos.
- Add a repo secret `HOMEBREW_TAP_TOKEN` with contents write access to the tap. Without it the tap step only warns; the formula is still attached to the release.

## Local build

```sh
bun install --os='*' --cpu='*'   # every platform's OpenTUI native library, needed to cross-compile
bun scripts/build.ts             # all targets → dist/; --target linux-x64 for one
bun scripts/formula.ts > dist/resector.rb
bun scripts/smoke.ts dist/linux-x64/resector <version>   # binary for this machine
```

## Development install

`scripts/install-dev.sh [bin-dir]` (default `~/.local/bin`) writes a `resector` command that runs this checkout's source with Bun, so a `git pull` takes effect without a build. It runs `bun install` itself whenever `bun.lock` changed.

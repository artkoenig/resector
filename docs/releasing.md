# Releasing

Distribution: single binaries from `bun build --compile` for darwin-arm64/x64 and linux-x64/arm64, on GitHub Releases, and through the Homebrew tap [`artkoenig/homebrew-tap`](https://github.com/artkoenig/homebrew-tap), whose formula installs those binaries (homebrew-core needs builds from source and notability).

1. Bump `version` in `package.json` and merge to `main`.
2. Tag and push: `git tag v<version> && git push origin v<version>`. The tag must match `package.json`, otherwise the build fails.
3. `.github/workflows/release.yml` runs the full gate (`bun run gate`), builds all targets, smoke-tests each binary on a native runner (`scripts/smoke.ts`: `--version`, then the Gate rendered in a PTY against the fake backend), and creates the GitHub Release (tarballs, `SHA256SUMS`). Then it writes the formula (`scripts/formula.ts`) to the tap, with the tap's deploy key in the secret `HOMEBREW_TAP_DEPLOY_KEY`.

Users install with `brew install artkoenig/tap/resector` (`brew upgrade` updates) or by unpacking a release tarball onto their `PATH`; there is no auto-update.

## Local build

```sh
bun install --os='*' --cpu='*' --libc='*'   # every platform's OpenTUI native library, needed to cross-compile
bun scripts/build.ts             # all targets → dist/; --target linux-x64 for one
bun scripts/smoke.ts dist/linux-x64/resector <version>   # binary for this machine
```

## Development install

`scripts/install-dev.sh [bin-dir]` (default `~/.local/bin`) writes a `resector` command that runs this checkout's source with Bun, so a `git pull` takes effect without a build. It runs `bun install` itself whenever `bun.lock` changed.

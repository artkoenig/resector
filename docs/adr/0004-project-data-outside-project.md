# Project data lives outside the Project

resector never writes into the Project; only the model's Tool Calls do. Everything resector keeps per Project lives in a Project Home outside it. As a result nothing has to be checked in or added to `.gitignore`, and a cloned repo cannot loosen the user's Permission Rules. The Project Home has two roots, following XDG on macOS too:

- `$XDG_CONFIG_HOME/resector/projects/<key>/` holds what the user edits: `config.jsonc`, `system.md`, `compaction.md`, `AGENTS.md`/`CLAUDE.md`.
- `$XDG_DATA_HOME/resector/projects/<key>/` holds what resector writes: `sessions/`, `worktrees/`.

The roots are split because `~/.config` is often versioned as dotfiles, and conversations and checkouts don't belong there. `<key>` is the realpath of the main checkout (from `git rev-parse --git-common-dir`; without git, the start directory) with every non-alphanumeric character replaced by `-`, as Claude Code does it. So all worktrees of a repo share one Project Home, and the user can still recognize it on disk. Team instructions (root `AGENTS.md`/`CLAUDE.md` in the checkout) are still read; `.resector/` in the Project is not read any more.

## Considered Options

- **Project key**:
  - The cwd path splits worktrees apart.
  - A hash of the origin URL merges clones that were made apart on purpose.
  - A basename collides.
  - Basename plus hash is hard to recognize.
- **One root under `~/.config`**: it mixes conversations and checkouts into dotfiles.
- **`.resector/` in the repo**: it needs `.gitignore`, and project config from a foreign repo could only tighten. Now the project config is personal, so its `allow` rules count.

## Consequences

- A moved or renamed repo gets a new Project Home. Old data is moved by hand; there is no migration.
- Session Worktrees outside the repo don't find the main checkout's `node_modules` or configs through parent directories.
- `RESECTOR_CONFIG` replaces only the global config file. Project Homes and `policies/` no longer derive from it.

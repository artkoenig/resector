# resector

TUI harness for local LLMs (Bun + TypeScript, UI with OpenTUI/Solid). No build step: Bun runs the TypeScript directly (`src/main.ts`).

## Commands

- `bun run typecheck` — tsc, ~1 s.
- `bun test` — all tests, ~30 s. `bun test <file>` for one file, `bun test <file> -t "<name part>"` for single tests.
- UI tests render real frames and wait on a fake backend; a rare timeout is flaky — rerun that file once before debugging.

## Layout

- `src/core/` — domain logic, no I/O. One folder per concept (`approval`, `cache`, `compaction`, `config`, `context`, `log`, `notes`, `policy`, `render`, `session`, `tokens`, `toolcall`), `backend.ts` is the backend port.
- `src/adapters/` — I/O: model servers (`backend/`), bash runner, file system, git, session store, clipboard, editor, search.
- `src/ui/` — the terminal UI:
  - `gate/` — state and actions of the main screen (the Review Gate): feature slices over a shared `kernel.ts`, composed in `index.ts`; slash commands in `commands.ts`; its ports in `types.ts`, its texts (titles, token numbers, errors) in `text.ts`. Imports neither adapters nor views (`bun run depcruise`).
  - `app.tsx` — composition of the main screen; its parts: `table.tsx`, `header.tsx`, `prompt.tsx`, `suggestions.tsx`, `dock-view.tsx`, `preview.tsx`; key maps in `keys.ts`, key hints in `hints.ts`.
  - `parts.tsx` (header, prompt band, footer), `format.ts` (view helpers: flags, cells), `launch.tsx`/`start.tsx` (startup), `setup.tsx`, `sessions.tsx`, `dock.ts` (Question dock), `theme.ts`.
- `test/` — shared test support: fake model servers (`fake-llamacpp.ts`, `fake-omlx.ts`), `frames.ts` (`frameMatching`), `requests.ts`, golden fixtures.
- Every module has its tests next to it: `x.ts` → `x.test.ts`. The first comment line of each file says what it is.

## Tests

- UI tests are split by feature (`src/ui/app.<feature>.test.tsx`, `launch.test.tsx`, `launch.sessions.test.tsx`). Shared helpers (`start`, `write`, `press`, `escape`, …) live in `app.harness.tsx` / `launch.harness.tsx`; each test file calls `useHarness()`. Helpers used by one file only stay near its tests. Copy the pattern of a neighbouring test instead of studying the helpers.
- When behaviour changes, change the tests that assert the old behaviour; keep test names describing the behaviour.
- Do not work out expected UI text from the code. Write the test with your best guess and run it: frames are 80×20, long texts wrap, and a `frameMatching` that finds nothing fails with the last frame printed; take the actual text from there.
- The fake servers answer only with what the test passes to `start()`; for everything else the app uses its defaults.

## Conventions

- Code, identifiers and comments in English; comments are short and say why.
- Match the style of the surrounding code; no new dependencies.

## Agent skills

### Issue tracker

GitHub Issues in `artkoenig/resector` via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.

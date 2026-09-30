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
  - `gate.ts` — state and actions of the main screen (the Review Gate); slash commands are defined here.
  - `app.tsx` — rendering of the main screen and its key bindings.
  - `parts.tsx` (header, prompt band, footer), `format.ts` (display helpers), `launch.tsx`/`start.tsx` (startup), `setup.tsx`, `sessions.tsx`, `dock.ts` (Question dock), `theme.ts`.
- `test/` — shared test support: fake model servers (`fake-llamacpp.ts`, `fake-omlx.ts`), `frames.ts` (`frameMatching`), `requests.ts`, golden fixtures.
- Every module has its tests next to it: `x.ts` → `x.test.ts`. The first comment line of each file says what it is.

## Tests

- UI tests (`src/ui/app.test.tsx`, `launch.test.tsx`) define their helpers at the top of the file and near the tests that use them (`start`, `write`, `press`, `escape`, …). Copy the pattern of a neighbouring test instead of studying the helpers.
- When behaviour changes, change the tests that assert the old behaviour; keep test names describing the behaviour.
- Do not work out expected UI text from the code. Write the test with your best guess and run it: frames are 80×20, long texts wrap, and a `frameMatching` that finds nothing fails with the last frame printed; take the actual text from there.
- The fake servers answer only with what the test passes to `start()`; for everything else the app uses its defaults.

## Conventions

- Code, identifiers and comments in English; comments are short and say why.
- Match the style of the surrounding code; no new dependencies.
- Requirement IDs like `FR-49` in comments refer to the product requirements; keep them when changing that code.

## Agent skills

### Issue tracker

GitHub Issues in `artkoenig/resector` via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.

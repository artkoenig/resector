# The Review Gate is an application layer below the views

The Review Gate's request cycle (send, Tool Loop, Tool Approval, Context Policy passes, Compaction, Context operations, slash commands) lived under `src/ui/gate/`, next to the views, and was tested only through rendered frames. It now lives in `src/gate/`: it imports only `core`, declares the ports it runs on (`Backend`, `Runner`, `Clipboard`, `Git`, …) and never imports views or adapters (`bun run depcruise` enforces it). The views (`src/ui/`) keep what is view state: the selection, the marks and the Kind Filters (`ui/selection.ts`); `ui/screen.ts` composes both into the main screen.

## Consequences

- The Gate acts on the user's selection and moves it, so it drives the view through a port, `View` (the rows shown, the selected and marked blocks, follow/release/keep). The view implements it; the Gate gets it from a factory, since the selection is built over the Gate's kernel.
- The Gate keeps solid-js signals as its reactive state: the views read them directly, and the workflow runs unchanged. The Gate therefore needs a reactive root, but no renderer: its tests (`src/gate/*.test.ts`) run against fake ports and a stub view in milliseconds.
- A port belongs to the Gate, which calls it; core only holds the data crossing it (`ChatResult`, `RunResult`). Adapters import the ports they implement from `gate/ports.ts` and nothing else of the Gate; the composition root (`ui/launch.tsx`, `ui/start.tsx`) wires them in.

## Considered Options

- Keep the Gate under `ui/`, enforced only by rules: no move, but the layer stays invisible in the layout.
- A Gate without solid-js (plain state and events, the views subscribe): framework-free, but rewrites every slice and every view's reads for no behaviour gained.
- The Gate announcing focus as events instead of calling the view: a narrower port, but the edits act on the selection and marks anyway; the `View` port can shrink towards it later.

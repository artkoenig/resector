# Resector v1 – Architecture

Requirements: [v1-prd.md](v1-prd.md). Glossary: [CONTEXT.md](../../CONTEXT.md).

## 1. Stack

- TypeScript on Bun; TUI with OpenTUI + SolidJS (same stack as opencode, whose TUI code is a reference).
- One process: TUI and agent loop together, strict module boundary **Core ↛ UI** (enforced by dependency-cruiser). Client/server remains possible later.
- Libraries: `@huggingface/transformers` / `@huggingface/gguf` (tokenizers), LM Studio SDK, tree-sitter-bash (wasm).
- Risk: OpenTUI is pre-1.0 and Bun-only; fallback is Go + Bubble Tea v2.

## 2. Modules

```
src/
  core/                    pure, fully mutation-tested
    log/                   Session Log events, JSONL codec, fold → Context
    context/               Context Blocks, Revisions, pins, Tool Pairs, restore
    render/                Context → request per Tool Protocol (native, text-xml)
    tokens/                Tokenizer interface, per-block split, drift
    cache/                 prefix diff → invalidation point, cost estimate
    compaction/            compaction request + proposal state machine
    approval/              permission rules, bash command splitting, evaluation
    toolcall/              parse tool calls (native + text-xml), malformed detection, split thinking
    config/                JSONC load, merge, schema, permission tightening
  adapters/                I/O at the edge
    backend/               llamacpp | ollama | lmstudio (chat, tokenize, props)
    bash/                  process runner (timeout, kill, stdin /dev/null)
    fs/                    @file read, environment probe, AGENTS.md
    store/                 session files, lock files, session index
  ui/                      OpenTUI + Solid views: Gate, preview, input, /sessions
  main.ts                  CLI (`resector`, `-c [id]`, `--version`, `--export-fixture`)
```

Core has no I/O; adapters are injected. UI depends on Core, never the reverse.

## 3. Session Log & Context

- File: `~/.local/share/resector/sessions/<project-hash>/<id>.jsonl`, one event per line, plus `<id>.lock`.
- Events: `SessionCreated{profile, protocol}`, `BlockAdded{id, kind, origin: user|model|tool|file|environment|compaction, content}`, `Edit{id, revision, content}`, `Move{id, after}`, `Pin{id, top|bottom}`, `Unpin`, `Remove`, `Restore`, `Compact{sources, instruction, noteId}`, `ToggleTool`, `Rename{id|session, title}`, `ProfileSwitched`, `AllowRuleAdded{pattern}`, `RequestSent{hash, tokens}`, `ResponseReceived{usage, cached}`, `Undo{eventId}`.
- **Context = fold(events)**. Undo is a counter-event; nothing is deleted within a session. Deleting a session removes its file.
- Block storage is protocol-neutral: Tool Call = `{name, args}`, Tool Result = text. Thinking, Assistant text and each Tool Call are separate blocks; the renderer merges them into one message.
- Only a Tool Call in state *pending approval* accepts `Edit`.
- Responses are appended when complete or aborted (`cut off`); in-flight streams are never persisted.

## 4. Request pipeline (per Review Gate)

```
fold(log) → Context
  → resolve pending @file refs (read, snapshot as Note; missing → abort)
  → refresh environment Note (new Revision only if changed)
  → render(Context, profile.toolProtocol) → messages (+ tools field for native)
  → tokenize via backend template → per-block tokens + Template overhead
  → cache diff vs last sent prompt → invalidation point, ≈ seconds (promptTokPerSec)
  → Gate: user edits … Enter
  → budget check (Context < window − drift) → send with max_tokens = window − Context, pinned id_slot
  → stream → append Assistant / Tool Call blocks
  → per Tool Call: parse → approval → run bash → Tool Result
  → back to Gate
```

### Rendering

- `native`: Assistant text + Tool Calls → one assistant message with `tool_calls`; each Tool Result → `tool` message; Tools Block → `tools` field.
- `text-xml`: calls as `<function=…><parameter=…>` (Qwen3-Coder syntax) in assistant text; results as user message `<tool_response>…</tool_response>`; Tools Block as compact signatures appended to the system message (own row at the Gate, tokens via prefix difference).
- Thinking: parsed from `reasoning_content` (llama.cpp `--reasoning-format`, Ollama `thinking`) or `<think>…</think>` in the stream; rendered back as `reasoning_content` of its assistant message where the backend accepts it, else inline `<think>`. The chat template may drop it; the token split then yields 0 → `✂ template`.
- Profile `thinking` maps to the backend: `chat_template_kwargs.enable_thinking` (on/off), `reasoning_effort` (low/medium/high).
- Moved Tool Pair = user-role Note `[Tool bash: <cmd>]` + result, never tool syntax. Pin bottom = user-role Note at the end.
- Tool results use the tool's native text; `resultFormat: toon` renders uniform rows as TOON-style tables. Model output stays JSON.

### Token counting

| Backend | Method | Exact |
|---|---|---|
| llama.cpp | `/apply-template` + `/tokenize` (`with_pieces`), `/v1/chat/completions/input_tokens`; requires `--jinja`; window from `/props` (per slot) | yes |
| Ollama | `_debug_render_only` + local tokenizer on the same GGUF; window from `/api/ps`; native `/api/chat` with `truncate:false`, `num_ctx` | no → drift |
| LM Studio | SDK `applyPromptTemplate` + `countTokens`; tool overhead measured once with `max_tokens:1`; window from `/api/v1/models` | no → drift |

Per-block split via offset mapping / prefix differences; remainder = `Template` row. After each response: drift = `usage.prompt_tokens` − pre-count; last drift is subtracted from the window for inexact backends.

### Prefix cache

- Invalidation point = first differing token between the new rendered prompt and the last sent one. Cost ≈ tokens after it / `promptTokPerSec` (measured).
- One pinned `id_slot` per session, `--cache-reuse` off. Verified against `timings.cache_n` / `prompt_eval_cached_count`.
- Compaction requests on the same model/slot leave the session cache cold (shown in status).

## 5. Tool Approval

- Rules from config (global `allow|ask|deny`, project only `ask|deny`) + session `AllowRuleAdded` events; last match wins; default `ask`; built-in read-only allow list.
- tree-sitter-bash splits compound commands; each sub-command evaluated; parse failure → `ask`; path arguments leaving the project root → `ask`.
- "Allow for session" stores `<prefix> *` derived via an arity table (e.g. `git checkout *`, `bun test *`).
- Runner: `bash -c`, cwd = project root, stdin `/dev/null`, timeout (default 120 s), kill on `Esc`.

## 6. Configuration

- JSONC + `$schema`; global `~/.config/resector/config.jsonc`, project `.resector/config.jsonc`, deep merge; `RESECTOR_CONFIG` overrides the path. `system.md`, `compaction.md` next to config; per-profile `systemPrompt` path.
- Read at start and on `/reload`. Never written by runtime changes, except the first-start port scan writing the chosen profile.
- Session log stores only the profile name; values come from current config, session overrides from the log on top.

## 7. Testing

- Core unit tests (`bun test`): fold, rendering per protocol, cache invalidation, token split, tool-call parsing, approval evaluation.
- Golden tests: Session Log fixtures (JSONL, exported via `resector --export-fixture`) → Context snapshot + rendered request payload.
- Fake backend: scriptable OpenAI-compatible Bun HTTP server (streaming, tool calls, malformed calls, `length` cut-off) for tool-loop integration tests incl. `Esc` and `max_tokens`.
- TUI: few text-frame snapshots via OpenTUI test renderer (Gate, compaction review, `/sessions`, budget overflow).
- Live suite `bun test:live` (opt-in, before release) against local llama.cpp with a small model: drift, cache, templates.
- Gates: `bun test --coverage` (LCOV) → `crap-ts --fail-above 8`; Stryker (community Bun runner `@hughescr/stryker-bun-runner`, fallback Jest runner) 100 % on `src/core`, incremental on PRs, full nightly/pre-release; dependency-cruiser; jscpd report. `bun run gate` runs all locally.
- CI: GitHub Actions, macOS + Linux.

## 8. Distribution

`bun build --compile` → darwin-arm64/x64, linux-x64/arm64 on GitHub Releases + Homebrew tap. Risk: OpenTUI native library inside the compiled binary (opencode does it). No auto-update.

## 9. Known risks & open facts

- OpenTUI pre-1.0 / Bun-only.
- No official Stryker Bun runner.
- Ollama `_debug_render_only` is undocumented and may change.
- LM Studio: slot splitting and whether `applyPromptTemplate` accepts tools are unverified.
- Cache prediction is approximate for SWA/recurrent models and templates that rewrite earlier turns.

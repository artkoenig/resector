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
    session/               new session, session summary (title, blocks, tokens)
    context/               Context Blocks, Revisions, pins, Tool Pairs, undo
    render/                Context → request per Tool Protocol (native, text-xml)
    tokens/                Tokenizer interface, per-block split, drift
    cache/                 prefix diff → invalidation point → rows ●/○
    compaction/            compaction request + proposal state machine
    notes/                 @path references and snapshots, environment Note text and refresh
    approval/              permission rules, evaluation of split commands, session rules
    toolcall/              parse tool calls (native + text-xml), malformed detection, split thinking
    config/                JSONC load, merge, schema, permission tightening
  adapters/                I/O at the edge
    backend/               llamacpp | ollama | lmstudio | omlx (chat, tokenize, props)
    bash/                  process runner (timeout, kill, stdin /dev/null), command splitting (tree-sitter-bash)
    editor/                $EDITOR on a temporary file, or on a project file (`e` on an @path reference); suspends the TUI
    clipboard/             copy on select: OSC 52 + pbcopy / wl-copy / xclip
    fs/                    @path read, environment probe, AGENTS.md
    store/                 session files, lock files, session index
  ui/                      OpenTUI + Solid views: Gate, preview, input, /sessions
  main.ts                  CLI (`resector`, `-c [id]`, `--version`, `--export-fixture`)
```

Core has no I/O; adapters are injected. UI depends on Core, never the reverse.

## 3. Session Log & Context

- File: `~/.local/share/resector/sessions/<project-hash>/<id>.jsonl`, one event per line, plus `<id>.lock`.
- Events: `SessionCreated{profile, protocol}`, `BlockAdded{id, kind, origin: config|user|model|tool|file|environment|compaction, content, cutOff?, call?, stopped?: killed|timeout, file?, pin?}` (`call`: a Tool Result's Tool Call; `file`: the file a Note was read from, as referenced: `path[:a-b]`; `pin`: added pinned, e.g. environment Note and project instructions at session creation), `FileReferenced{id, file}` (an `@path` row, unread), `FileRead{id, content}` (its snapshot on send), `Edit{id, revision, content, harness?}` (`harness`: the environment Note refreshed, not undoable), `Move{id, after}`, `Pin{id, top|bottom}`, `Unpin`, `Remove` (a Tool Pair as a whole), `PairToNote{id, call}` (moving/pinning a Tool Pair: Note `id` replaces it after the calls and results of its answer), `Compact{sources, instruction, noteId, content}`, `Rename{id, title}` (block display title; no longer created, still read from older logs), `SessionRenamed{title}`, `ProfileFallback{profile}`, `AllowRuleAdded{pattern}`, `RequestSent{hash, tokens}`, `ResponseReceived{usage, cached}`, `Undo{eventId}`.
- **Context = fold(events)**. Undo is a counter-event; nothing is deleted within a session. Deleting a session removes its file.
- Block storage is protocol-neutral: Tool Call = its bash command (the only tool), Tool Result = text (output, then `[exit N]`, `[killed]` or `[timeout after N s]`), Tools Block = tool definitions as JSON. Thinking, Assistant text and each Tool Call are separate blocks; the renderer merges them into one message. Tool Results follow all Tool Calls of their answer, in call order. A Tool Call without Tool Result awaits approval.
- Every block but the Tools Block accepts `Edit`; of the Tool Calls only one *pending approval* (FR-8).
- Responses are appended when complete or aborted (`cut off`); in-flight streams are never persisted.

## 4. Request pipeline (per Review Gate)

```
fold(log) → Context
  → resolve pending @path refs (read, snapshot as Note; missing → abort)
  → refresh environment Note (new Revision only if changed)
  → render(Context, profile.toolProtocol) → messages (+ tools field for native)
  → tokenize via backend template → per-block tokens + Template overhead
  → cache diff vs last sent prompt → invalidation point (rows ●/○)
  → Gate: user edits … Enter
  → budget check (Context < window − drift) → send with max_tokens = window − Context, pinned id_slot
  → stream → append Assistant / Tool Call blocks
  → per Tool Call: parse → approval → run bash → Tool Result
  → back to Gate
```

### Rendering

- `native`: Assistant text + Tool Calls → one assistant message with `tool_calls` (ids `call_<n>` by position in the message, as a server numbers its answer, so the answer and its next rendering are the same tokens); each Tool Result → `tool` message; Tools Block → `tools` field. Per-block tokens come from rendering the first 1, 2, … blocks.
- `text-xml`: calls as `<function=…><parameter=…>` (Qwen3-Coder syntax) in assistant text; results as user message `<tool_response>…</tool_response>`; Tools Block as compact signatures appended to the system message (own row at the Gate, tokens via prefix difference).
- Thinking: parsed from `reasoning_content` (llama.cpp `--reasoning-format`, Ollama `thinking`) or `<think>…</think>` in the stream; rendered back as `reasoning_content` of its assistant message where the backend accepts it, else inline `<think>`. The chat template may drop it; the token split then yields 0 → `✂ template`.
- Thinking (the Gate's, else the profile's) maps to the backend: `chat_template_kwargs.enable_thinking` (off: false, else true), plus an effort as `reasoning_effort` and `chat_template_kwargs.reasoning_effort`. It travels with the request, so the counted chat template renders with it too. The modes offered come from the chat template's Jinja source (`core/render/template.ts`).
- Moved Tool Pair = user-role Note `[Tool bash: <cmd>]` + result, never tool syntax. Pin bottom = user-role Note at the end.
- Tool results use the tool's native text; `resultFormat: toon` renders uniform rows as TOON-style tables. Model output stays JSON.

### Token counting

| Backend | Method | Exact |
|---|---|---|
| llama.cpp | `/apply-template` + `/tokenize` (`with_pieces`), `/v1/chat/completions/input_tokens`; requires `--jinja`; window from `/props` (per slot) | yes |
| Ollama | `_debug_render_only` + local tokenizer on the same GGUF; window from `/api/ps`; native `/api/chat` with `truncate:false`, `num_ctx` | no → drift |
| LM Studio | SDK `applyPromptTemplate` + `countTokens`; tool overhead measured once with `max_tokens:1`; window from `/api/v1/models` | no → drift |
| oMLX | `/v1/messages/count_tokens` (Anthropic format: System → `system`, rest → `messages`; chat template + generation prompt applied, `tools` accepted); window from `max_model_len` in `/v1/models`; OpenAI-compatible `/v1/chat/completions`, cached tokens from `usage.prompt_tokens_details` | yes (tool overhead not counted until tool definitions are sent → drift) |

Per-block split via offset mapping / prefix differences; remainder = `Template` row. After each response: drift = `usage.prompt_tokens` − pre-count; last drift is subtracted from the window for inexact backends.

### Prefix cache

- Invalidation point = first differing token between the new rendered prompt and the last sent one plus its answer. A row is `●` if all its tokens lie before it, else `○`; the answer counts with its end of turn. No prefill time estimate.
- llama.cpp: token ids via `/tokenize`; one pinned `id_slot` per session (`hash(session id) mod total_slots`), `n_cache_reuse: 0` per request; the server always evaluates the last prompt token. The prediction starts cold for each connection (new, resumed, `/reload`).
- oMLX: no token ids; its cache probe `/admin/api/cache/probe` predicts hits in whole cache blocks. It sees a request's blocks only shortly after the answer, so the unchanged messages of the last request also count, rounded down to whole blocks. Without the probe (e.g. admin API key required): message-level comparison with the last request and its answer (approximate).
- Verified against `timings.cache_n` / `usage.prompt_tokens_details.cached_tokens`: a server reusing fewer tokens than predicted is warned about (FR-41); SWA/recurrent models are not detectable via the API.
- Compaction requests on the same model/slot leave the session cache cold (shown in status).

## 5. Tool Approval

- Rules from config (global `allow|ask|deny`, project only `ask|deny`) + session `AllowRuleAdded` events; last match wins; default `ask`; built-in read-only allow list.
- tree-sitter-bash splits compound commands; each sub-command evaluated; parse failure → `ask`; path arguments (incl. redirect targets) leaving the project root, or not literal (`$VAR`, `$(…)`), → `ask`; a built-in read-only command writing files (redirect, or options like `find -delete`, `sed -i`) → `ask`.
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
- Gates: `bun test --coverage` (LCOV) → `scripts/crap.ts` (complexity from the TypeScript 5.9 AST, line coverage from LCOV; fails above 8 — `crap-ts` needs Istanbul `fnMap`, which Bun does not emit); Stryker (community Bun runner `@hughescr/stryker-bun-runner`, fallback Jest runner) 100 % on `src/core`, incremental on PRs, full nightly/pre-release; dependency-cruiser; jscpd report. `bun run gate` runs all locally.
- CI: GitHub Actions, macOS + Linux.

## 8. Distribution

`bun build --compile` → darwin-arm64/x64, linux-x64/arm64 on GitHub Releases + Homebrew tap. Risk: OpenTUI native library inside the compiled binary (opencode does it). No auto-update.

## 9. Known risks & open facts

- OpenTUI pre-1.0 / Bun-only.
- No official Stryker Bun runner.
- Ollama `_debug_render_only` is undocumented and may change.
- LM Studio: slot splitting and whether `applyPromptTemplate` accepts tools are unverified.
- oMLX shares port 1234 with LM Studio; first start tells them apart by `owned_by: "omlx"` in `/v1/models`. On a chat template error oMLX counts a plain concatenation instead (silent drift).
- Cache prediction is approximate for SWA/recurrent models and templates that rewrite earlier turns.

# Resector v1 – Product Requirements

Glossary: [CONTEXT.md](../../CONTEXT.md). Terms in **bold** are defined there. Architecture: [v1-architecture.md](v1-architecture.md). Decision trail: [.wayfinder/context-harness-v1/map.md](../../.wayfinder/context-harness-v1/map.md).

## 1. Problem

Local LLMs (7B–30B, 8k–32k window) degrade fast when the context fills with noise, and existing coding agents hide what they send. Users can neither see nor steer the Context, pay prefill time for invalidated caches blindly, and lose control to auto-compaction.

## 2. Product

A text-based (TUI) coding agent whose core is the **Review Gate**: a pause before *every* request to the model — including follow-up requests in the tool loop — where the user sees each **Context Block** with its exact token count and cache effect, and can send, edit, move, pin, remove or compact it. UX model: opencode. UI language: English.

## 3. Users & scope

- One developer, one machine, local OpenAI-compatible backends: llama.cpp server, Ollama, LM Studio.
- Platforms: macOS and Linux (arm64, x64). No Windows.
- **Out of scope v1:** automatic placement rules / auto-compaction, MCP, LSP, web tools, cloud-provider optimisation, bash sandboxing, forking sessions, file snapshots/restore, auto-update, tools other than `bash`.

## 4. Functional requirements

### 4.1 Screen & modes

- **FR-1** One screen. Header line · block table · preview of selected block · input line · status line. No separate chat screen; the block table *is* the conversation.
- **FR-2** Header: Model Profile name · Context bar · tokens / window. The bar shows one segment per block in Context order (plus Template), width proportional to tokens, coloured by kind; the selected block's segment is highlighted; free space is shaded. Over the window the bar is scaled to the Context and marks the window edge. Tokens yellow ≥ 90 %, red with `over by X` above the window. With inexact tokenizer: `±X` drift. Nothing else (no backend, protocol, state tag, cache summary or per-kind totals); cache state is visible per row (FR-3).
- **FR-3** Table columns: `# · Kind · Title · Tokens · Cache ●/○ · Flags`. Kinds written out (System, Tools, User, Thinking, Assistant, Tool Call, Tool Result, Note). Last row `Template` (BOS, generation prompt overhead), not selectable. Sum of all rows = exact request size.
- **FR-4** Title is a display label only, never sent. Default = first non-empty line of content; origin titles: `System prompt`, tool names, the call, `→ <call>`, `@file <path>`, `⇄ <call>`, `◇ N blocks compacted`. `r` renames (empty = reset); rename is a log event without Context/cache effect.
- **FR-5** Flags show only changes since the last request and reset after sending: `✎n` new Revision, `⤒`/`⤓` pin set/changed, `⇄` moved by user. Status flags persist: `✂ template` (FR-48), `⚠ cut off`, `⚠ malformed`, `? approve`, `⚠ killed`, `⚠ timeout`.
- **FR-6** Two modes, `Tab` toggles. **Context mode** (default): list focused; `Enter` sends the Context. **Input mode**: `Enter` with text adds a User block and returns to Context mode *without sending*; `Tab`/`Esc` return without adding; `⌥⌫` deletes a word. Typing `/` shows command suggestions above the input (name, argument, description), filtered while typing: `↑↓` choose, `Tab` complete, `Enter` run. v1 commands: `/sessions`, `/rename`, `/reload`.
- **FR-7** Streaming: the answer appears live as a new row (spinner in Tokens column); afterwards back to the Gate. `Esc` aborts; the partial answer is kept with `⚠ cut off`.

### 4.2 Context operations (Context mode)

| Key | Action |
|---|---|
| `↑` `↓` | select |
| `⌥↑` `⌥↓` | move block |
| `e` | edit block in `$EDITOR` (new Revision) |
| `r` | rename |
| `d` | remove (struck through until sent, then hidden; undoable) |
| `p` | pin cycle: top → bottom → off |
| `Space` | mark / unmark (selection stays) |
| `c` | compact marked blocks (or current) |
| `u` | undo |
| `q` | quit |

- **FR-8** Editable: all kinds except Tools Block and executed Tool Calls. A Tool Call awaiting approval is editable (FR-22). Edit keeps the kind.
- **FR-9** Tool Pair: removed/compacted only as a whole; editing the result in place keeps the pair; moving or pinning it asks for confirmation (same key again) and turns it into a Note `[Tool bash: <cmd>]` + result.
- **FR-10** Pin top = right after System + Tools Block (+ environment/project Notes); pin bottom = very end, sent as user-role Note. Pinned blocks keep their order and can be reordered among themselves.
- **FR-11** *Dropped:* no trash view; removed blocks come back only via undo (`u`).
- **FR-12** The Tools Block (`bash`) is always sent and never edited; no tool toggle.

### 4.3 Compaction

- **FR-13** `c` turns the input line into `instruction >` with a header `◇ Compact N blocks (X tok) · <model> · request Y / window`. The default instruction (config `compaction.md`) shows as a grey hint; empty `Enter` uses it, `Tab` copies it for editing.
- **FR-14** The request contains only the selected blocks + instruction. If it does not fit the Compaction profile's window → blocked with hint; no chunking.
- **FR-15** Proposal streams as `◇ proposal · attempt k` at the first source's position; sources show `◇ proposed`; status line shows tokens before → after (−%), Context after / window, cache effect. Gate locked during review: `Enter` accept, `x`/`Esc` discard, `i` change instruction → new run from the sources, `e` edit proposal in `$EDITOR`.
- **FR-16** Accept: one Note `◇ N blocks compacted` (origin: sources + instruction); sources disappear immediately; `u` restores them.
- **FR-17** Compaction uses `compactionProfile` of the Model Profile, else the session model.

### 4.4 Budget

- **FR-18** No answer reserve. Every request sends `max_tokens = window − Context`. Sending is blocked only if Context ≥ window (minus last measured drift for inexact tokenizers). No suggestions, no largest-block list.
- **FR-19** `finish_reason=length` → Assistant block `⚠ cut off`, stays in the Context; a cut-off Tool Call is not executed. No auto-continue. Cut off during thinking → Thinking block `⚠ cut off`, no Assistant block.
- **FR-20** No automatic truncation of tool output, neither in the Context nor in the preview (preview scrolls). Over-budget results are resolved by the user with `e`, `d`, `c`.

### 4.5 Tool execution & Tool Approval

- **FR-21** Only tool: `bash`. Timeout 120 s (configurable); stdin `/dev/null`; `Esc` kills a running command → partial output + `⚠ killed`; timeout → `⚠ timeout`.
- **FR-22** Permission rules `{pattern: allow|ask|deny}`, last match wins, default `ask`. Built-in `allow`: `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `sed -n`, `git status|diff|log|show`. Compound commands (`&&`, `;`, `|`, `$(…)`) are split with tree-sitter-bash; every sub-command must be allowed; unparseable → `ask`. Arguments pointing outside the project (absolute paths, `..`) → `ask`.
- **FR-23** Allowed call runs immediately; the Gate then shows the result; `Enter` sends. `ask` → the Tool Call row shows `? approve` and sending is blocked. On the selected pending row: `y` run once, `a` allow for session (prefix + ` *`, shown before saving), `n` reject → result `rejected by user`, `e` edit command → new Revision, re-evaluated. Approval never auto-sends. `deny` → result `denied by rule`.
- **FR-24** Several calls in one answer are approved one by one in order; results keep call order.
- **FR-25** "Allow for session" is a Session Log event (survives resume). Permanent rules only via config. Project config may only tighten (`ask`/`deny`); project `allow` entries are ignored with a Gate hint.
- **FR-26** Malformed tool call (parse error) stays an Assistant block `⚠ malformed`, is not executed; user edits/removes it or sends, which appends an error Note.

### 4.6 Files & Notes

- **FR-27** `@file <path>[:a-b]` in the input adds a file reference row. Before sending, `e` on it opens the file itself in `$EDITOR`. On send the file (or line range) is read and becomes a Note with origin `@file <path>`; from then on a plain snapshot, never tracked, refreshed or marked stale. Missing file at send → sending aborts with `file not found: <path>`.
- **FR-28** Environment Note (origin `environment`, pinned top): cwd, OS/shell, date (no time), git branch. Regenerated before each request; replaced only when changed (new Revision, `✎`).
- **FR-29** Project instructions (`AGENTS.md`, else `CLAUDE.md`) are read once when a session is created → Note (origin file), pinned top. Snapshot like `@file`; not re-read on resume.

### 4.7 System prompt

- **FR-30** Shipped default ≤ ~400 tokens, English: role (local coding agent), style "Be extremely concise. Sacrifice grammar for the sake of concision.", bash conventions (`sed -n 'a,bp'`, `grep -n`, `rg`, `find`/`ls`, `| head`/`| tail`, heredoc for new files, `sed -i` for small edits, whole-file heredoc only for small files, no `patch`). No few-shot examples. No environment inside.
- **FR-31** Overridable globally (`system.md`) and per Model Profile (`systemPrompt` path). Editing at the Gate is session-local.

### 4.8 Sessions

- **FR-32** `resector` starts a new session; `resector -c [id]` resumes the last or a given one. No forking.
- **FR-33** `/sessions`: full-screen table of the current project's sessions, newest first. Columns: marker (● current, ⊘ locked), title, updated, Model Profile (⚠ if missing from config), Context tokens / window (yellow > 90 %), blocks. Below: preview of the last blocks. Keys: `↑↓`, `Enter` open, `r` rename, `d` delete → `Delete …? y / N`, `n` new, `/` filter, `Esc` back. Deleting the current session switches to the newest other one or a new empty session.
- **FR-34** Title = first User message (shortened); `r`/`/rename`, empty resets.
- **FR-35** Resume = replay of the Session Log, then Gate. Cold cache shown as info `cold cache: X tok, ~Ys prefill`. Missing profile → `defaultProfile` + hint, re-render.
- **FR-36** A session is locked by one process; a second instance refuses to open or delete it.
- **FR-37** An answer is written to the log only when complete (or aborted with `⚠ cut off`); a crash loses the in-flight answer and resume lands at the Gate before that request.

### 4.9 Model Profiles & protocols

- **FR-38** Model Profile fields: `name`, `backend` (`llamacpp`|`ollama`|`lmstudio`), `endpoint`, `model`, `window` (auto, overridable), `tokenizer` (auto, override path), `toolProtocol` (`native`|`text-xml`), `resultFormat` (`native`|`toon`), `sampling`, `thinking`, `compactionProfile`, `systemPrompt`; measured `promptTokPerSec` stored for cache estimates.
- **FR-39** *Dropped:* no profile switch within a session; the Model Profile (and thus the Tool Protocol) is fixed at session creation, except the resume fallback of FR-35.
- **FR-40** llamacpp backend: check `--jinja` at startup; error with hint if missing.
- **FR-41** After each response, compare pre-count with `usage.prompt_tokens` and reported cached tokens; show drift in the status line.

### 4.10 Configuration

- **FR-42** JSONC with `$schema`. Global `~/.config/resector/config.jsonc`, project `.resector/config.jsonc`, deep merge (project wins, except permission loosening, FR-25); `RESECTOR_CONFIG` overrides the path. Long texts as files next to the config: `system.md`, `compaction.md`.
- **FR-43** Keys: `profiles`, `defaultProfile`, `permission`, `keybindings` (action → key), `bash.timeout`.
- **FR-44** Runtime changes (system prompt edit, session allow rules) are Session Log events, never written back to config. `/reload` re-reads config; no hot reload.
- **FR-45** First start without config: scan 8080 (llama.cpp), 11434 (Ollama), 1234 (LM Studio), offer found models, write choice to the global config.

### 4.11 Thinking

- **FR-46** Model reasoning (`reasoning_content` or `<think>…</think>`) becomes its own Thinking block before the Assistant block of the same answer; own row, own token count; edited, moved, removed and compacted like any block.
- **FR-47** Thinking blocks stay in the Context and are sent with every request until the user removes them.
- **FR-48** If the model's chat template drops a Thinking block (e.g. Qwen3 strips thinking before the last user message), its token count is what actually gets rendered (0), the row is dimmed and flagged `✂ template`. Resector does not bypass the template. Exact on llama.cpp, best effort on Ollama/LM Studio.
- **FR-49** Thinking is set per Model Profile only: `thinking: off | on | low | medium | high`, restricted to what the model supports (e.g. Qwen3 on/off, gpt-oss low/medium/high). No runtime switch; start a new session with another profile.
- **FR-50** While the model thinks, the status line shows `thinking` and the preview streams the thinking dimmed.

## 5. Non-functional requirements

- **NFR-1** Token counts are exact on llama.cpp; Ollama/LM Studio best effort with visible drift.
- **NFR-2** Cache invalidation prediction is exact for plain-attention models on llama.cpp; approximate (and labelled so) for SWA/recurrent models.
- **NFR-3** Nothing inside a session is ever deleted: every operation is an append-only event; undo is a counter-event.
- **NFR-4** Quality gates (block merge): CRAP ≤ 8 per function (all code); mutation score 100 % incl. NoCoverage for Core, suppressions only with reason comment; dependency-cruiser: Core never imports UI. jscpd reports duplication (non-blocking).
- **NFR-5** Distribution: single binaries via `bun build --compile` (darwin-arm64/x64, linux-x64/arm64), GitHub Releases + Homebrew tap. `resector --version`. MIT licence; repo public at v1 release.

## 6. Resolved contradictions

Where earlier decisions conflicted, the later or more specific one wins:

| Conflict | Resolution |
|---|---|
| Tool Calls not editable (block model) vs. `e` before execution (Tool Approval) | Editable only while awaiting approval; executed calls stay immutable. |
| Flags `📌` `◇` (block model) vs. `⤒ ⤓`, no `◇` (Compaction flow) | `⤒ ⤓ ⇄ ✎n`; compaction visible via title. |
| `Enter` opens detail (block model) vs. `Enter` sends (Gate UI) | `Enter` sends; the preview pane shows details. |
| Protocol fixed per session (tool protocols research) vs. switchable (Model Profile) | Fixed per session; profile switch dropped (complete prototype). `text-json` deferred. |
| Removed blocks always visible (Gate UI) vs. until sent (Compaction flow) | Struck through until sent. |
| `n` = new Note vs. `n` = reject | `n` only rejects (on a selected `? approve` row); free-text Notes dropped (complete prototype). |
| Changed AGENTS.md on resume → stale-content ticket vs. no staleness at all | Read once at session creation; snapshot. |
| read/edit/grep/glob tools (charting) vs. only `bash` | Only `bash`. |

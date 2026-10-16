# How comparable CLI agents shape their headless mode

Research for [#107](https://github.com/artkoenig/resector/issues/107) (part of #106), as input for resector's Headless Run (`resector -p "…"`). State as of 2026-10-16.

Sources: official docs, plus source code at the commit noted where the docs are silent.

- Claude Code: [headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference)
- Codex CLI: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [CLI reference](https://learn.chatgpt.com/docs/cli/reference), source `openai/codex@6ae8b8a` `codex-rs/exec/src/lib.rs`
- aider: [scripting](https://aider.chat/docs/scripting.html), [options](https://aider.chat/docs/config/options.html), source `Aider-AI/aider@5dc9490` `aider/main.py`, `aider/io.py`
- opencode: [CLI](https://opencode.ai/docs/cli/), [permissions](https://opencode.ai/docs/permissions/), source `anomalyco/opencode@37e3912` `packages/cli/src/run/{run,noninteractive,ui}.ts`
- Gemini CLI: [headless](https://geminicli.com/docs/cli/headless/), [CLI reference](https://geminicli.com/docs/cli/cli-reference/), [configuration](https://geminicli.com/docs/reference/configuration/), source `google-gemini/gemini-cli@b25669d` (`packages/core/src/policy/`, `packages/cli/src/nonInteractiveCli.ts`, `packages/cli/src/config/config.ts`)

## Comparison

| | Claude Code | Codex CLI | aider | opencode | Gemini CLI |
|---|---|---|---|---|---|
| Entry | `-p`, `--print` (flag on the main command) | subcommand `codex exec` (alias `codex e`) | `-m`/`--message`/`--msg`, `-f`/`--message-file` | subcommand `opencode run [message..]` | `-p`/`--prompt`; also any non-TTY start |
| Prompt via arg | yes | yes (positional) | yes (flag value) | yes (positional words joined) | yes (flag value) |
| stdin | piped stdin read (cap 10 MB); with a prompt it is extra input | piped stdin = context when a prompt is given; prompt read from stdin if omitted, `-` explicit | not read | piped stdin appended to the message after a newline | piped stdin; `-p` text is appended to it |
| stdout (default) | final result text only | final agent message only | everything (Rich console: reply, diffs, tool output, errors) | assistant text (and `Thinking:` with `--thinking`) when stdout is not a TTY | model text as it streams |
| stderr | invalid-flag errors, warnings, "waiting for background work" | progress (commands, reasoning, tool calls) | nothing specific | tool/step lines, `permission requested … auto-rejecting`, errors; `--print-logs` | warnings, errors, `Cancelling...`, loop/stop messages |
| Machine format | `--output-format text\|json\|stream-json`; `--json-schema`; `--verbose`, `--include-partial-messages` | `--json` (JSONL events); `-o`/`--output-last-message <file>`; `--output-schema <file>` | none (`--no-pretty`, `--no-stream`) | `--format default\|json` (JSON events) | `-o`/`--output-format text\|json\|stream-json` |
| Show more kinds | `--verbose` (with stream-json), `--forward-subagent-text` | progress always on stderr | `--verbose` | `--thinking`, `--print-logs` | stream-json only |
| Tool approval without a human | unresolved prompt = deny; `--permission-prompts none` also tells the model not to retry | approval policy forced to `never` in exec; any approval request is rejected ("not supported in exec mode"); sandbox limits what runs | prompts answered by `--yes-always`; without it it would block on input | `ask` = reject with a message to the model ("cannot ask the user for permission … Continue without this action"), run continues | Policy Engine default decision `DENY` in non-interactive; `ASK_USER` becomes `DENY`; `ask_user` tool removed |
| Auto-approve | `--dangerously-skip-permissions` (= `--permission-mode bypassPermissions`); modes `acceptEdits`, `auto`, `dontAsk` | `--dangerously-bypass-approvals-and-sandbox`/`--yolo`; `--approve-for-me` (auto-review); `--sandbox workspace-write\|danger-full-access` (`--full-auto` removed) | `--yes-always` (still says no to shell commands: `explicit_yes_required`) | `--auto` (approves `ask`, keeps explicit `deny`) | `--approval-mode default\|auto_edit\|yolo\|plan`; `-y`/`--yolo` deprecated |
| Allow/deny lists | `--allowedTools`/`--allowed-tools`, `--disallowedTools`/`--disallowed-tools`; rule syntax `Bash(git diff *)`; `--tools` restricts the tool set | execpolicy `.rules` files (`--ignore-rules` skips); no per-run flag | none | config only: `permission` per tool, patterns `"git *": "allow"`, last match wins | `--allowed-tools` (deprecated) → Policy Engine TOML rules; settings `tools.allowed`, `tools.exclude`, `tools.core` |
| Turn limit | `--max-turns N` (print mode only), exits with error; also `--max-budget-usd` | none | none (internal: max 3 reflections) | none | setting `model.maxSessionTurns` (default -1), exit code 53 |
| Exit codes | 0 ok, non-zero on failure (in-run failures printed as result on stdout), 143 on SIGTERM | 1 on error or failed/interrupted turn | 0 even after a failed reply; 1 on setup errors (missing message file …) | 1 on error / rejected permission (v1 compat) / cancelled form; 130 on interrupt | 0 ok, 1 error, 42 input error, 53 turn limit |
| Continue | `-c`/`--continue` (latest in cwd), `-r`/`--resume <id\|name\|path>`, `--fork-session`, `--session-id <uuid>`, `--no-session-persistence` | `codex exec resume <id>` / `--last` (`--all` across dirs), `--ephemeral` | `--restore-chat-history` | `-c`/`--continue`, `-s`/`--session <id>`, `--fork` | `-r`/`--resume latest\|<index>`, `--session-id`, `--session-file`, `--list-sessions` |
| Config defaults | `settings.json` `permissions.allow/deny/defaultMode`; `--settings <file\|json>`; `--bare` skips discovery | `config.toml` (`approval_policy`, `sandbox_mode`); `-p`/`--profile`; `-c key=value` | `.aider.conf.yml`, `AIDER_*` env | `opencode.json` `permission`, per agent `agent.<name>.permission` | `settings.json`: `general.defaultApprovalMode` (yolo only via flag), `tools.*`, `model.maxSessionTurns` |

## Findings

- **Flag shape.** Two camps: a flag on the main command (`claude -p`, `gemini -p`, `aider -m`) or a subcommand (`codex exec`, `opencode run`). `-p` is the most common short form for "prompt and exit" (Claude, Gemini). Codex and opencode use `-p` for something else (`--profile`, `--password`).
- **stdout = answer.** Claude Code and Codex print only the final answer on stdout and keep progress off it; Codex puts progress on stderr. opencode and Gemini print all assistant text to stdout, tool lines to stderr. aider mixes everything on stdout. Every agent except aider has a JSON mode on stdout for machines.
- **No human → deny, keep going.** Claude Code, Codex, opencode and Gemini all turn an unanswered approval into a denial instead of hanging. opencode and Claude Code (`--permission-prompts none`) tell the model why, so it continues without the action; Gemini makes `DENY` the policy default. Question tools (`AskUserQuestion`, `ask_user`, `request_user_input`, opencode's question form) are removed or cancelled.
- **Auto-approve naming.** Two styles: deliberately scary (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`) with a short alias (`--yolo`), or neutral (`--auto` in opencode, `--yes-always` in aider, `--approval-mode yolo` in Gemini). opencode's `--auto` keeps explicit denies; aider's `--yes-always` still refuses shell commands. A safe "yes" that still respects denies is the common pattern.
- **Allow/deny per run.** Only Claude Code has per-run allow/deny flags (`--allowedTools` / `--disallowedTools`, glob-style rule patterns like `Bash(git diff *)`). Gemini deprecated its `--allowed-tools` in favour of policy files; opencode and Codex use config files only. opencode's patterns (`"git *": "allow"`, last match wins) look like what resector would match against.
- **Turn limit.** Only Claude Code has a flag (`--max-turns`, error exit when hit). Gemini has a setting and a dedicated exit code (53). Codex, aider and opencode have none.
- **Exit codes.** Mostly 0/1; Gemini also has a distinct code for input errors (42) and the turn limit (53); 130/143 for signals.
- **Continue.** `-c`/`--continue` = latest session is shared by Claude Code and opencode; a specific session goes by `-r`/`--resume <id>` (Claude, Gemini) or `-s`/`--session <id>` (opencode). Codex uses `exec resume <id>|--last`.
- **Config defaults.** No agent has a separate "headless" config section. Defaults come from the normal permission/approval settings plus a per-run override (`--settings`, `--profile`, `-c key=value`). Gemini prevents yolo from being set in config at all (`general.defaultApprovalMode` cannot be `yolo`).

## Implications for resector (input, not a decision)

- `-p`/`--print` with a positional or flag prompt matches the two most similar tools; reading piped stdin as extra context is common to all except aider.
- stdout = final answer only, extra kinds on stderr: matches Claude Code / Codex.
- `ask` → deny with a note to the model and continue: matches opencode, Claude Code, Gemini.
- `--auto-approve` that still honours deny patterns: semantics of opencode `--auto`; aider shows the risk of approving shell blindly.
- `--allow/--deny <pattern>`: only Claude Code has per-run flags (`--allowedTools`/`--disallowedTools`); shorter names are fine since resector has no tool-name dimension in them.
- `--max-turns` with its own exit code: Claude Code's name, Gemini's distinct exit code idea.
- `-c <id>`: note that in Claude Code and opencode `-c` means "latest" with no argument, and an id goes to `-r`/`-s`. Using `-c <id>` deviates from that convention.
- A `headless` config section has no precedent; precedent is "normal settings + per-run overrides". Gemini's rule that yolo is flag-only is a precedent for keeping `--auto-approve` out of config.

# How other agent harnesses run background processes

Research for [#123](https://github.com/artkoenig/resector/issues/123) (part of #122): how coding-agent harnesses let the model start, observe and stop long-running processes such as a dev web server. State as of 2026-11-19.

Starting point in resector: `src/adapters/bash/runner.ts` spawns `bash -c` in its own process group with piped stdout/stderr and resolves on the child's `close` event. `close` fires only when every holder of the pipes has closed them, so `npm run dev &` keeps the call open (the backgrounded server inherits the pipes) until the timeout SIGKILLs the whole group, server included.

Sources: official docs, plus source code at the commit noted.

- Claude Code: [tools reference](https://code.claude.com/docs/en/tools-reference) (Bash, background commands, Monitor, TaskStop), [interactive mode: how backgrounding works](https://code.claude.com/docs/en/interactive-mode), [headless: background tasks at exit](https://code.claude.com/docs/en/headless), [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Codex CLI: source `openai/codex@5f8c36e`, `codex-rs/core/src/tools/handlers/shell_spec.rs`, `codex-rs/core/src/unified_exec/{mod,process,process_manager,output,stdin_approval}.rs`, `codex-rs/core/config.schema.json`, `codex-rs/tui/src/slash_command.rs`, `codex-rs/features/src/lib.rs`
- opencode: [tools docs](https://opencode.ai/docs/tools/), source `anomalyco/opencode@36bd410` (v2.3.0), `packages/core/src/tool/plugin/shell.ts`, `packages/core/src/shell.ts`, `packages/process-daemon/README.md`
- Gemini CLI: [shell tool docs](https://geminicli.com/docs/tools/shell/) (lag the source), source `google-gemini/gemini-cli@808199f`, `packages/core/src/tools/{shell.ts,shellBackgroundTools.ts,definitions/dynamic-declaration-helpers.ts}`, `packages/core/src/services/shellExecutionService.ts`, `packages/cli/src/config/settingsSchema.ts`
- aider: source `Aider-AI/aider@5dc9490`, `aider/run_cmd.py`, `aider/coders/base_coder.py`, `aider/coders/shell.py`
- Cline: source `cline/cline@20b0427`, `apps/vscode/src/sdk/vscode-run-commands-tool.ts`, `sdk/examples/plugins/background-terminal.ts`

## Comparison

| | Claude Code | Codex CLI | opencode | Gemini CLI | aider | Cline (VS Code) |
|---|---|---|---|---|---|---|
| Start | `Bash` with `run_in_background: true` | `exec_command` (always; no flag): waits `yield_time_ms`, returns a `session_id` if still running | `shell` with `background: true` | `run_shell_command` with `is_background: true` (+ `delay_ms`) | none: only foreground `/run` and suggested commands | `execute_command`; user clicks "Proceed While Running", or auto after 300 s |
| Foreground timeout | moves the command to the background instead of killing it (not `sleep …`) | n/a: every call yields at its deadline, the process keeps running | moves to the background (default 2 min) | inactivity timeout kills | none (blocks until EOF) | detaches at 300 s, keeps running |
| Start result | task ID + output file path, immediately; no startup output | output collected until `yield_time_ms` (default 10 s, 250–30 000 ms) or exit, plus `session_id`, `exit_code` if done, wall time | shell ID, PID, output file path, plus a fixed instruction not to poll | after `delay_ms` (default 200 ms): PID + output so far ("Initial output") | – | partial output + path of a log file |
| Where output goes | file (killed past 5 GB); read with `Read` | in-memory head+tail buffer per process (1 MiB); each poll returns output since the last one, capped by `max_output_tokens` (default 10 000) | file (`outputPath`), read with `read` | log file `background-<pid>.log` | – | log file (capped at 10 MB) |
| Observe | `Read` the output file; `Monitor` streams each new line as an event | `write_stdin` with empty `chars` = poll (waits 5 s–5 min for output) | `read` the file; completion notification | `read_background_output(pid, lines=100, delay_ms)`: tail of the log; `list_background_processes` | – | read the log file |
| Completion | notification with the outcome; head+tail only past 1 000 chars | `exit_code` on the next poll | synthetic session message with the output when it exits; model told "DO NOT poll" | setting `backgroundCompletionBehavior`: `silent` (default), `notify`, `inject` (output ≤ 5 000 chars) | – | – |
| Stop by the model | `TaskStop(id)` | `write_stdin` with `\u0003` (it is a PTY) | none dedicated; `kill <pid>` via `shell` | none dedicated; tool description teaches `kill -- -PGID` | – | – |
| Stop by the user | `/tasks` | `/ps` lists, `/stop` (`/clean`) stops all | job cancel in UI | Ctrl+K kills the active background shell, Ctrl+B shows it | Ctrl-C | VS Code terminal |
| Lifetime | killed with the session on exit (whole tree, also `setsid` children); no time limit interactively; unattended (`-p`, SDK, cloud) 30 min default, max 2 h; `-p` waits for it before exiting | all processes terminated at session shutdown and on `/stop`; at most 64, LRU-pruned (8 most recent protected, exited first) | owned by a separate PTY daemon (`opencode-pty`): survives a planned server restart (handoff), dies when the owner connection is lost; SIGTERM then SIGKILL after 3 s; exited ones kept for a while | detached process group; log files cleaned up later; exit behaviour not found in source | – | runs on in the VS Code terminal |
| Approval | same Bash permission rules as foreground | same exec approval and sandbox; later `write_stdin` input is reviewed against the launch permissions | same `shell` permission per parsed command | same shell confirmation/policy | each command confirmed (`explicit_yes_required`) | same as any command |

## Details worth keeping

**Claude Code.** Model API history: `BashOutput` and `KillShell` (the original pair) were replaced by a unified `TaskOutput` in 2.0.64; `TaskOutput` was deprecated in 2.1.83 and removed in 2.1.277, "Claude reads a background task's output file with Read instead" (CHANGELOG). `TaskStop` remains. Output of every Bash command is streamed to a working file; a finished command's result reads back up to 30 000 chars. Background tasks "are automatically cleaned up when Claude Code exits", including processes that detached from the task's shell (interactive-mode docs). Monitor watches have a deadline (5 min default, 30 max) and send each output line as an event, i.e. push rather than poll. A `cd` inside a backgrounded command does not carry over, and the result says so.

**Codex CLI.** "Unified exec" is the default (`unified_exec` feature: stable, enabled). There is no background flag: `exec_command` is described as "Runs a command in a PTY, returning output or a session ID for ongoing interaction." A dev server therefore starts with its first 10 s of output (enough to see "listening on :3000" or a crash), and the model polls with an empty `write_stdin`. Polls wait at least 5 s (`MIN_EMPTY_YIELD_TIME_MS`), up to `background_terminal_max_timeout` (default 300 000 ms), so polling is not a busy loop. Output is capped twice: a 1 MiB head/tail buffer per process, and `max_output_tokens` per returned chunk.

**opencode.** Output is always file-backed; the result keeps only a notice while running ("Output is streaming to: …"). The tool result embeds a strong instruction: "You will be notified automatically when the command finishes … DO NOT poll for completion". A foreground command that exceeds its timeout is moved to the background with "Do not start another copy while it is running." Background calls have no timeout unless one is given (docs).

**Gemini CLI.** The only harness here with an explicit readiness wait at start (`delay_ms`, "Useful to allow the process to start and generate initial output before returning"), returning "Command is running in background. PID: … Initial output: …". It also handles a plain `cmd &` inside a normal call: the command is wrapped in a subshell with `trap 'jobs -p > "$file"' EXIT`, and the result lists "Background PIDs". The tool description says each command "leads its own process group" and can be ended with `kill -- -PGID`. Source note relevant to resector (Bun): "Bun's child_process does not properly call setsid() for detached processes … They receive SIGHUP immediately. Disable detached mode in Bun" (`shellExecutionService.ts`).

**aider.** No background processes at all: suggested shell commands run in the foreground after confirmation, output is read until EOF, then the user is asked whether to add it to the chat. A dev server would block aider until Ctrl-C.

**Cline.** No model-facing background flag; the escape hatch is human-driven ("Proceed While Running") or a 300 s auto-detach, after which the model gets partial output and a log path to read. A separate example plugin (`background-terminal.ts`) shows the file-backed job pattern as an add-on.

## Patterns

1. **Background flag + output file + notification** (Claude Code, opencode, Gemini). Start returns immediately with an ID/PID and a path; the model reads the file with the ordinary read tool; the harness pushes a completion message. Cheap on context if the model reads only a tail. Without a readiness wait (Claude Code, opencode) the model does not see whether the server came up and must read the file once.
2. **Every command is a session with a yield deadline** (Codex). One shape for short and long commands; start returns startup output; polling returns only new output. Needs a second tool (`write_stdin`) and a per-chunk token cap.
3. **Human detach** (Cline) or **none** (aider).

Common to all that support it: the process is killed when the session ends; approval is the same as for a foreground command; a foreground timeout moves the command to the background rather than killing it (Claude Code, opencode, Cline).

## Fit for small local models with small context windows

- **Fewest tools, fewest parameters.** A boolean on the existing bash tool (`background: true`) is easier for a small model than a second tool with session IDs to carry. Codex's two-tool PTY protocol (session IDs, `chars`, yield times, Ctrl-C as `\u0003`) is the most demanding.
- **Short readiness wait with startup output in the start result** (Gemini's `delay_ms`, Codex's yield). One call then answers "did it start, which port, did it crash" without a follow-up read; bounded by a few seconds and a tail of lines, so it costs little context. Pure "return immediately" (Claude Code, opencode) forces an extra read round-trip.
- **Output to a file, read as a tail.** Bounded and reusing the existing read tool; never stream a server's log into the Context. Gemini's tail read (last N lines, 64 KB cap) is the cheapest observation shape; reading the whole file is not.
- **No polling instructions needed if the harness notifies on exit**, but for a server that never exits the notification only matters on crash; that is the useful case (a short notice with the last lines, like Claude Code's head+tail past 1 000 chars).
- **Stopping by PID/ID**: a small model can call `kill <pid>` through bash if the start result names the PID/process group (Gemini, opencode); a dedicated stop tool (Claude Code `TaskStop`) is clearer but one more tool in the Tools Block.
- **Always kill on session end** (all of them) and handle plain `cmd &`: either resolve when the shell exits rather than when the pipes close, or redirect/track background PIDs as Gemini does; otherwise a small model that writes `npm run dev &` hangs the turn, which is exactly resector's current failure.

Recommended shape for resector: a `background` boolean on the bash Tool Call; spawn with output to a per-process file; wait briefly (a few seconds, or until exit) and return the PID/ID, the file path and the last lines; read later with the existing read tool (tail); stop with `kill` on the reported process group or a minimal stop operation; kill all on exit; same approval as foreground. Independently, make plain `&` not hang (resolve on the shell's exit, not on pipe close).

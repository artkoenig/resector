# A Headless Run drives the Gate without the Review Gate

`resector -p <prompt>` runs one prompt from the shell or a script: the answer goes to stdout, nothing else. It uses the same Gate (ADR 0003) the TUI uses, but it never stops at the Review Gate. A Gate slice, `gate/headless.ts`, offers `run(input): Promise<Outcome>`; the outcome is one of answer, error, aborted or max-turns. The slice sends the prompt and keeps the Tool Loop going until the model answers without calls. A Hold does not stop it: the results of calls that did not run (rejected, denied, killed) go back to the model. It counts turns and ends the run at `--max-turns`. A turn is every request to the model, including the one a Context Policy sends on; Compaction requests never count.

Everything else stays as in the TUI. The Context Policy, the Permission Rules, Auto-approve and the Session Log work unchanged. Every Headless Run is a new Session, logged and resumable in the TUI (`/sessions`). There is no `-c`, no `--no-session` and no headless-only permission preset.

A person runs it, so the run asks that person. A Question or a Tool Call that the Permission Rules leave at `ask` is asked and answered at `/dev/tty` through a new port, since stdin may carry the prompt and stderr may go to a file. Without a terminal the Question is declined and `ask` turns into `deny` with the result text "no user to approve". The run goes on either way. Without config of its own, a run without a terminal can therefore only run what the rules allow, which by default means read-only commands.

The wiring that is not UI moves out of `ui/launch.tsx` into `src/compose/`: loading config and policies, opening or resuming a Session, the Session Worktree, the runner, the compactor and the lock. Both `ui/` and the new root `src/cli/run.ts` import it; `compose` never imports `ui`. The minimal `View` (rows = blocks sent, follow moves the selection) moves from `gate.harness.ts` into `gate/` for both the CLI and the tests.

## Interface

- **Call.** `-p, --prompt <text>`; piped stdin is appended to it. The other flags exist only together with `-p`; without it they are a usage error:
  - `-m, --model <profile>`
  - `--policy <name|off>`
  - `--thinking <off|on|level>`
  - `--tools <list|none>`
  - `--show <thinking,tools,notes,policy|all>`
  - `--max-turns <n>` (default 50)
  - `-w, --worktree`
  - `--auto-approve`

  There are no `--allow`/`--deny` flags.
- **Config.** A `headless` section in `config.jsonc`, global and per project, takes `profile`, `policy`, `thinking`, `tools`, `show`, `maxTurns` and `worktree`. Precedence: global → project → `headless` → flags. `permission` stays shared with the TUI; `autoApprove` exists only as a flag. Without any config the run fails with a hint.
- **Output.** stdout gets only the last answer, once the run has ended, because text before Tool Calls is final only after them. stderr gets the `--show` kinds as one prefixed line per event:
  - `∴` Thinking, streamed
  - `$` Tool Call
  - `│` Tool Result, cut to 3 lines plus `… N more lines`, then `└ exit N`
  - `◆` policy operation
  - `·` status

  After those, one closing status line with outcome, turns and tokens, also without `--show`. Color only when stderr is a TTY; the asking, at `/dev/tty`, is colored when that is one. Tool Approval shows each sub-command with its verdict and its reason and asks `y`/`a`/`n`. A Question numbers its options and takes a number or free text: empty means the Recommended Option, `-` skips the question.
- **Exit codes.**
  - 0: answer.
  - 1: error or max-turns. Errors include an unreachable backend, a missing File Reference, a Context that leaves no Budget, and a failed policy or Compaction. stdout stays empty and stderr shows the Gate's status text.
  - 2: usage.
  - 130: Ctrl‑C. It acts like Esc (abort the stream, kill the tool); a second Ctrl‑C exits at once. stdout stays empty.

  Denied calls are not a failure.

## Considered Options

- **A separate agent loop next to the Gate**: free of the Gate's signals and View, but it would duplicate Tool Approval, the policy passes and the Session Log, and the two would drift apart.
- **`ask` → `deny` always, with the Question tool off (as in `claude -p`)**: simpler, but the caller is a person at a terminal who can answer. Declining is kept for runs without a TTY.
- **Run flags for Permission Rules (`--allow`/`--deny`) or a built-in headless deny of git writes**: the existing rule sources already cover both; a second way to state rules would change which rule wins.
- **Streaming the answer to stdout**: you cannot tell final text from text before Tool Calls until the calls come; stdout would then mix in intermediate answers.
- **JSON/JSONL output, a REPL over stdin/stdout, TUI flags**: out of scope; the caller is a person.

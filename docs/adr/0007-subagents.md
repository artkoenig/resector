# A Subagent is a Headless Run started as a Background Process

A Session's model can hand work to a **Subagent**: a Headless Run (ADR 0005) it starts with the `subagent` tool. The
Subagent is a Background Process of that Session and nothing more. The tool only starts `resector -p` with the right
parameters and prepares the result; the parent's request cycle does not change.

## The tool

`subagent` is a tool in the catalog. `prompt` is its only required argument; `worktree` is optional. It starts a
real `resector -p` process through the Background registry, with Auto-approve and `--show tools`. Its Tool Result
comes at once: `[Subagent started: pid … · log … · stop: kill -- -<pid>]`, with worktree path and branch when there
are any. The parent's run goes on.

A `subagent` call is `ask` by default; a Permission Rule can allow it. The child runs with Auto-approve, so the start
is the one place the user agrees: they see the prompt and the `worktree` argument. Under Auto-approve, which is on
unless the config or `--no-auto-approve` switches it off, the start runs unasked like any other `ask`. A Headless Run
without a terminal and without Auto-approve starts Subagents only with a rule.

New Sessions have the tool in their Tools Block; `/tools` switches it. Existing Sessions get it through `/tools`.

We chose a tool over bash with a Skill. bash can pass `--auto-approve` and be allowed by a rule, but the prompt has
to be quoted for the shell, which is where a small local model fails first, and the result would come back only as a
log path. resector also writes no Skills (ADR 0004, 0006). Starting `resector -p` through bash stays possible; that
is not a Subagent.

We chose a process of its own over a second Gate in the parent's process: ADR 0005 stays as it is, and a crash of
the child does not reach the parent.

## Depth 1

A Subagent starts no Subagents. Its Tools Block never has the `subagent` tool, whatever `headless.tools` says, and a
marker in its environment makes `resector -p` refuse to start inside a Subagent, since the child could otherwise
call it through bash. A Subagent inherits nothing of the parent's Context.

## Life cycle

It is the one every Background Process has:

- Releasing the parent Session (close, switch, quit, the end of a Headless Run) stops its Subagents.
- The user kills one with `k` on its Tool Pair, the model with `kill -- -<pid>`. Interrupting the parent's request
  does not stop it.
- When a Subagent ends while the parent Session is at rest at the Review Gate, its exit Note is sent at once (see
  The result). Nothing waits for a Subagent: a headless parent that answers without calls ends and stops its
  Subagents; a model that wants their results there waits itself (e.g. `sleep` through bash), and the tool's
  description says so.
- Max turns is the configured Headless Run value. There is no time limit.
- At most `subagent.max` Subagents (default 2) run at once per parent Session. A call over the limit fails at once
  with an error as its Tool Result; nothing is queued.

We rejected a Headless Run that waits for its Background Processes: with a server among them it would never end, and
waiting for Subagents only would make a Subagent more than a Background Process.

## The result

During its run the Subagent works with its Context Policy like every Headless Run. When the run has ended with an
answer or at max turns, resector sends it one more request with a summary prompt of its own (built in, overridable
as `subagent.summaryPrompt`; the default asks what was done, what was found, what is open, the files touched and the
commits). The request does not count as a turn, Tool Calls in its answer are not run, and prompt and answer are
logged in the Subagent's Session Log. After an error or a kill there is no summary. Only a Subagent gets this
request; other Headless Runs end as before.

The parent learns the result from the exit Note, one per Subagent: a head (Outcome, turns, tokens; the first line of
the prompt; worktree and branch when there are any, and whether the worktree has uncommitted changes; the Subagent's
Session and its log) and the whole summary, without a cap. After an error or a kill the Note holds the head and the
status text.

We rejected returning the run's last answer, whole or capped: it is often a closing remark, not a report. We
rejected an instruction at the start of the prompt: small models forget it, and a run that hits max turns would
report nothing.

One thing changes for every Background Process: its exit Note enters the Context when the process ends, not when the
next request is prepared, and a Session at rest sends it at once, as if the user had pressed Enter. So a long Session
goes on without the user when a Subagent reports. One rule covers every case: the send is the ordinary one, so
whatever stops Enter stops it too (a Tool Call awaiting approval, an open Question, no Budget), and while a request
or the Tool Loop is under way, or the loop is held, the Note goes with the next request as before. While an answer, a
policy or a Compaction is under way the Note enters once that is done; in a Headless Run before its next request. A
process the user killed sends nothing: they have just stepped in. Before, the Note appeared only with the next
request, and an idle Session answered Enter with "nothing to send".

We first decided against this request, because at the Review Gate none went out without the user. A Context Policy
already sends the Context on without a user message, and a Subagent's start is approved by the user; having to press
Enter for each report would only interrupt a long Session.

## Where it runs

The model decides per call with the `worktree` argument whether the Subagent gets a Session Worktree of its own.
Without the argument `headless.worktree` applies; without that the Subagent runs where the parent Session runs. The
worktree's branch starts from the HEAD of where the parent runs, so from the parent's branch also when the parent is
in a Session Worktree itself; uncommitted changes are not in it. Outside a git repository a call with `worktree`
fails at once, with no fallback to the project directory. Merging the branch is the parent model's own work.

We rejected "always a worktree" (needless for reading, impossible without git) and "never" (parallel writers
collide).

## Which model

The config decides: `subagent.profile` names the Model Profile, and without it the Subagent runs on the parent
Session's profile, so on the same instance. Which instance is free the user knows, not the model, so the tool takes
no profile argument. Context Policy, thinking, tools, max turns and worktree come from `headless`.

Both backends serve a second client. On a shared llama.cpp server a Subagent never gets its parent's slot while the
server has more than one: it takes the parent's slot plus its running number, modulo the slot count. A second Model
Profile on another instance avoids the sharing altogether.

## What remains

A Subagent's Session is an ordinary Session: it stays, is resumable, its Session Worktree goes with it and its
branch only when merged. The parent's Session Log records each Subagent's Session; `/sessions` lists them under
their parent, and deleting the parent deletes them with their worktrees (branches not merged stay and are reported).
A worktree a Subagent leaves clean and without a commit is removed with its branch at the Subagent's end. The
process log goes with the parent Session, as for every Background Process. Nothing else is removed automatically,
and there is no clean-up command.

## Not part of this

Starting or stopping model servers, merging a Subagent's branch automatically, a slash command to start one, nested
Subagents, and asking a Subagent's Tool Approvals at the parent's Review Gate.

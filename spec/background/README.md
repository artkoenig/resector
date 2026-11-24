# Background Processes — Quint model (#122)

`backgroundProcess.qnt` models a bash Tool Call's Background Process across the OS, the Session Log, the Context, the per-Session record and app crashes. Decisions modelled: #124, #125, #128, #129, #130, #140, ADR 0007 (the exit Note goes into the Context at the process's end).

## Run

```bash
quint run backgroundProcess.qnt --main=fixed --max-samples=100000 --max-steps=30 --invariant=allInvariants --witnesses wStarted wExitNoted wUserStopNoted wSessionEndedNoted wOrphanNoted wPairRemovedAfterExit wReusedHandled
```

```bash
quint test backgroundProcess_test.qnt --main=decidedTest
```

## Open points (consts)

| const | as decided | fix |
|---|---|---|
| `EXIT_ON_LEADER` | `true`: registry logs the exit on the leader's `'exit'` (unspecified, Bun's natural event) | `false`: logged only when the process group is empty |
| `REAP_LOGS_GONE` | `false`: #129 logs `orphaned` only for groups it kills; ESRCH / reused pid only drops the record | `true`: log `orphaned` for every record dropped |
| `RESUME_ALL` | `false`: on resume, Notes only for `session ended` / `orphaned` (#129.4) | `true`: Notes for every logged exit with no Note yet |
| `CHECK_START_TIME` | `true` (#129.3) | — (ablation `noStartTimeCheck` shows why it's needed) |

## Results (`quint run`, 20 000 samples, 20 steps)

| invariant | asDecided | fixed |
|---|---|---|
| `neverOutlivesApp` | violated — `start → leaderExits → observeExit` (fix: `EXIT_ON_LEADER=false`) | ok |
| `noStuckRunning`, `recordMatchesLog` | violated — `start → crash → groupDies → restart` (fix: `REAP_LOGS_GONE`) | ok |
| `noLostExitNote` | violated — `start → k → closeSession → openSession` (fix: `RESUME_ALL`) | ok |
| `noForeignKill` | ok (violated in `noStartTimeCheck`: `crash → groupDies → pidReused → restart`) | ok |
| `runningPairInContext`, `noteOnlyAfterExit` | ok | ok |

Each fix removes exactly one group of violations (instances `onlyGroupExit`, `onlyReapLogs`, `onlyResumeAll`). All witnesses reached > 0 traces.

## Not covered

- Two live resector instances in one Project (lock held by another instance).
- Timing: start wait (`bash.backgroundWait`), SIGTERM→SIGKILL grace (one step), pid reuse while resector runs.
- The request a Session at rest sends for an exit Note (#180).
- Log file content, live preview, TUI flag rendering, Kind Filters, Headless Run vs TUI differences (same lifecycle).
- Context Policy internals: every remove/compact/edit/move is one `removePair` guarded by `untouchable`.
- Plain `&` without `background` (#133): a foreground concern of the runner.

Update this model and re-run before changing the decisions it encodes.

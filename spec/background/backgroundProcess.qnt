// Quint model of Background Processes (ticket #122): lifetime of a bash Tool Call's
// Background Process across the Session Log, the Context, the app and crashes.
//
// Decisions modelled: #124 (start), #125 (exit Note before next request), #128 (registry,
// stopAll on Opened.release, BackgroundStarted/Exited), #129 (orphan reaping at start with
// per-Session record + start-time guard, exit Note on resume), #130 (`k`), #140 (running
// Tool Pair is untouchable).
//
// Open points are consts, so each choice can be simulated:
//   EXIT_ON_LEADER    registry logs BackgroundExited when the group leader exits (Bun 'exit')
//                     instead of when the whole process group is gone.
//   CHECK_START_TIME  reaper skips the kill when pid = pgid now belongs to another process (#129.3).
//   REAP_LOGS_GONE    reaper also logs `orphaned` for records whose group is already gone
//                     (ESRCH / pid reused), not only for groups it killed.
//   RESUME_ALL        on resume, exit Notes for every logged exit the model has not seen, not only
//                     `session ended` / `orphaned` (#129.4 as written).
module backgroundProcess {
  const SESSIONS: Set[int]
  const CALLS: Set[int]
  const EXIT_ON_LEADER: bool
  const CHECK_START_TIME: bool
  const REAP_LOGS_GONE: bool
  const RESUME_ALL: bool

  pure val NONE = 0   // no open Session

  type Key = (int, int)   // (Session, Tool Call)

  // The OS side: what really runs.
  type Real = NoProc | Running | LeaderGone | Dead

  type Reason = ExitCode | UserStop | SessionEnded | Orphaned

  // The Session Log side (persisted).
  type Logged = NotStarted | LogRunning | LogExited(Reason)

  type Proc = {
    real: Real,
    reused: bool,      // pid = pgid now belongs to a foreign process
    log: Logged,
    noted: bool,       // an exit Note for it reached the Context (persisted with the Context)
    inContext: bool,   // its Tool Pair is in the Context
    recorded: bool,    // listed in sessions/<id>.background
  }

  type App = { alive: bool, open: int }

  var procs: Key -> Proc
  var app: App
  var pending: Set[Key]       // exit Notes queued in memory for the next request
  var foreignKilled: bool
  var lastAction: str

  pure val KEYS: Set[Key] = tuples(SESSIONS, CALLS)

  pure val FRESH: Proc = { real: NoProc, reused: false, log: NotStarted, noted: false, inContext: false, recorded: false }

  // ---------- functional layer ----------

  pure def realAlive(r: Real): bool = r == Running or r == LeaderGone

  pure def logRunning(p: Proc): bool = p.log == LogRunning

  pure def isExited(p: Proc): bool = match p.log { | LogExited(_) => true | _ => false }

  pure def exitReason(p: Proc): Reason = match p.log { | LogExited(r) => r | _ => ExitCode }

  // The registry has seen the process end.
  pure def exitObservable(p: Proc): bool =
    if (EXIT_ON_LEADER) p.real == LeaderGone or p.real == Dead else p.real == Dead

  // kill(-pgid): SIGTERM, SIGKILL after 2 s (abstracted to one step).
  pure def killGroup(p: Proc): Proc = if (realAlive(p.real)) { ...p, real: Dead } else p

  pure def logExit(p: Proc, r: Reason): Proc = { ...p, log: LogExited(r), recorded: false }

  // Is this Context operation allowed on the pair (#140)?
  pure def touchable(p: Proc): bool = not(logRunning(p))

  // Reaper on one recorded entry of a Session not locked by a live instance (#129).
  pure def reap(p: Proc): { p: Proc, foreign: bool } =
    if (not(p.recorded)) { p: p, foreign: false }
    else if (realAlive(p.real)) { p: logExit(killGroup(p), Orphaned), foreign: false }
    else {
      // group gone: ESRCH, or pid reused by another process
      val foreign = p.reused and not(CHECK_START_TIME)
      val dropped = { ...p, recorded: false }
      { p: if (REAP_LOGS_GONE) logExit(dropped, Orphaned) else dropped, foreign: foreign }
    }

  pure def resumeNote(p: Proc): bool =
    isExited(p) and not(p.noted) and
      (RESUME_ALL or exitReason(p) == SessionEnded or exitReason(p) == Orphaned)

  // ---------- state machine ----------

  action init = all {
    procs' = KEYS.mapBy(_ => FRESH),
    app' = { alive: true, open: NONE },
    pending' = Set(),
    foreignKilled' = false,
    lastAction' = "init",
  }

  // New or resumed Session (TUI start, switch target, Headless Run).
  action openSession(s: int): bool = all {
    app.alive, app.open == NONE,
    app' = { ...app, open: s },
    pending' = CALLS.filter(c => resumeNote(procs.get((s, c)))).map(c => (s, c)),
    procs' = procs, foreignKilled' = foreignKilled,
    lastAction' = "openSession",
  }

  // bash Tool Call with background: true (#124).
  action start(s: int, c: int): bool = {
    val p = procs.get((s, c))
    all {
      app.alive, app.open == s, p.log == NotStarted,
      procs' = procs.set((s, c), { ...p, real: Running, log: LogRunning, inContext: true, recorded: true }),
      app' = app, pending' = pending, foreignKilled' = foreignKilled,
      lastAction' = "start",
    }
  }

  // ---- environment: the OS ----
  action leaderExits(k: Key): bool = all {
    procs.get(k).real == Running,
    procs' = procs.setBy(k, p => { ...p, real: LeaderGone }),
    app' = app, pending' = pending, foreignKilled' = foreignKilled,
    lastAction' = "leaderExits",
  }

  action groupDies(k: Key): bool = all {
    realAlive(procs.get(k).real),
    procs' = procs.setBy(k, p => { ...p, real: Dead }),
    app' = app, pending' = pending, foreignKilled' = foreignKilled,
    lastAction' = "groupDies",
  }

  // pid wraparound: only plausible over the long gap while resector is down.
  action pidReused(k: Key): bool = all {
    not(app.alive), procs.get(k).real == Dead, not(procs.get(k).reused),
    procs' = procs.setBy(k, p => { ...p, reused: true }),
    app' = app, pending' = pending, foreignKilled' = foreignKilled,
    lastAction' = "pidReused",
  }

  // ---- registry ----
  action observeExit(s: int, c: int): bool = {
    val p = procs.get((s, c))
    all {
      app.alive, app.open == s, logRunning(p), exitObservable(p),
      procs' = procs.set((s, c), logExit(p, ExitCode)),
      pending' = pending.union(Set((s, c))),
      app' = app, foreignKilled' = foreignKilled,
      lastAction' = "observeExit",
    }
  }

  // `k` on the row (#130); works while busy.
  action userStop(s: int, c: int): bool = {
    val p = procs.get((s, c))
    all {
      app.alive, app.open == s, logRunning(p),
      procs' = procs.set((s, c), logExit(killGroup(p), UserStop)),
      pending' = pending.union(Set((s, c))),
      app' = app, foreignKilled' = foreignKilled,
      lastAction' = "userStop",
    }
  }

  // User or Context Policy removes / compacts / edits / moves the pair (#140).
  action removePair(s: int, c: int): bool = {
    val p = procs.get((s, c))
    all {
      app.alive, app.open == s, p.inContext, touchable(p),
      procs' = procs.set((s, c), { ...p, inContext: false }),
      app' = app, pending' = pending, foreignKilled' = foreignKilled,
      lastAction' = "removePair",
    }
  }

  // Exit Notes go in before the next request (#125).
  action sendRequest: bool = all {
    app.alive, app.open != NONE, pending != Set(),
    procs' = procs.keys().mapBy(k => if (pending.contains(k)) { ...procs.get(k), noted: true } else procs.get(k)),
    pending' = Set(),
    app' = app, foreignKilled' = foreignKilled,
    lastAction' = "sendRequest",
  }

  // Opened.release → stopAll: switch, quit, Headless Run end, SIGTERM/SIGHUP (#128).
  action closeSession: bool = {
    val s = app.open
    all {
      app.alive, s != NONE,
      procs' = procs.keys().mapBy(k =>
        if (k._1 == s and logRunning(procs.get(k))) logExit(killGroup(procs.get(k)), SessionEnded)
        else procs.get(k)),
      app' = { ...app, open: NONE },
      pending' = Set(),
      foreignKilled' = foreignKilled,
      lastAction' = "closeSession",
    }
  }

  // SIGKILL / crash: nothing is logged, processes keep running (#127).
  action crash: bool = all {
    app.alive,
    app' = { alive: false, open: NONE },
    pending' = Set(),
    procs' = procs, foreignKilled' = foreignKilled,
    lastAction' = "crash",
  }

  // Next start in the Project: reap every recorded orphan first (#129).
  action restart: bool = {
    val reaped = procs.keys().mapBy(k => reap(procs.get(k)))
    all {
      not(app.alive),
      procs' = reaped.keys().mapBy(k => reaped.get(k).p),
      foreignKilled' = (foreignKilled or reaped.keys().exists(k => reaped.get(k).foreign)),
      app' = { alive: true, open: NONE },
      pending' = Set(),
      lastAction' = "restart",
    }
  }

  // Session delete kills first, then removes log, record, logs (#129.5).
  action deleteSession(s: int): bool = all {
    app.alive, app.open != s,
    procs' = procs.keys().mapBy(k => if (k._1 == s) FRESH else procs.get(k)),
    foreignKilled' = foreignKilled,
    app' = app, pending' = pending,
    lastAction' = "deleteSession",
  }

  action step = {
    nondet s = SESSIONS.oneOf()
    nondet c = CALLS.oneOf()
    any {
      openSession(s),
      start(s, c),
      leaderExits((s, c)),
      groupDies((s, c)),
      pidReused((s, c)),
      observeExit(s, c),
      userStop(s, c),
      removePair(s, c),
      sendRequest,
      closeSession,
      crash,
      restart,
      deleteSession(s),
    }
  }

  // ---------- invariants ----------

  // A Background Process never outlives the app: while resector runs, every live group
  // belongs to the open Session and is logged as running.
  val neverOutlivesApp: bool =
    app.alive implies KEYS.forall(k =>
      realAlive(procs.get(k).real) implies (app.open == k._1 and logRunning(procs.get(k))))

  // The reaper never kills a process that is not ours.
  val noForeignKill: bool = not(foreignKilled)

  // The model never loses a running Background Process from its Context (#140.1).
  val runningPairInContext: bool =
    KEYS.forall(k => logRunning(procs.get(k)) implies procs.get(k).inContext)

  // No pair stays untouchable forever: while resector runs, only the open Session has
  // processes logged as running.
  val noStuckRunning: bool =
    app.alive implies KEYS.forall(k => logRunning(procs.get(k)) implies app.open == k._1)

  // The record on disk matches the Session Log while resector runs.
  val recordMatchesLog: bool =
    app.alive implies KEYS.forall(k => procs.get(k).recorded iff logRunning(procs.get(k)))

  // No exit Note for a process that has not ended.
  val noteOnlyAfterExit: bool = KEYS.forall(k => procs.get(k).noted implies isExited(procs.get(k)))

  // Every end the model has not been told about is queued for the next request.
  val noLostExitNote: bool =
    (app.alive and app.open != NONE) implies CALLS.forall(c => {
      val p = procs.get((app.open, c))
      (isExited(p) and not(p.noted)) implies pending.contains((app.open, c))
    })

  val allInvariants: bool = and {
    neverOutlivesApp, noForeignKill, runningPairInContext, noStuckRunning,
    recordMatchesLog, noteOnlyAfterExit, noLostExitNote,
  }

  // ---------- witnesses (reachability) ----------
  val wStarted: bool = KEYS.exists(k => logRunning(procs.get(k)))
  val wExitNoted: bool = KEYS.exists(k => procs.get(k).noted and exitReason(procs.get(k)) == ExitCode)
  val wUserStopNoted: bool = KEYS.exists(k => procs.get(k).noted and exitReason(procs.get(k)) == UserStop)
  val wSessionEndedNoted: bool = KEYS.exists(k => procs.get(k).noted and exitReason(procs.get(k)) == SessionEnded)
  val wOrphanNoted: bool = KEYS.exists(k => procs.get(k).noted and exitReason(procs.get(k)) == Orphaned)
  val wPairRemovedAfterExit: bool = KEYS.exists(k => isExited(procs.get(k)) and not(procs.get(k).inContext))
  val wReusedHandled: bool = KEYS.exists(k => procs.get(k).reused and not(procs.get(k).recorded))
  val wDeleted: bool = lastAction == "deleteSession"
}

// As decided in the tickets; registry watches the leader's 'exit'.
module asDecided {
  import backgroundProcess(SESSIONS = Set(1, 2), CALLS = Set(1, 2),
    EXIT_ON_LEADER = true, CHECK_START_TIME = true, REAP_LOGS_GONE = false, RESUME_ALL = false).*
}

// With the three fixes the simulation suggests.
module fixed {
  import backgroundProcess(SESSIONS = Set(1, 2), CALLS = Set(1, 2),
    EXIT_ON_LEADER = false, CHECK_START_TIME = true, REAP_LOGS_GONE = true, RESUME_ALL = true).*
}

// Ablation: reaper without the start-time guard.
module noStartTimeCheck {
  import backgroundProcess(SESSIONS = Set(1, 2), CALLS = Set(1, 2),
    EXIT_ON_LEADER = false, CHECK_START_TIME = false, REAP_LOGS_GONE = true, RESUME_ALL = true).*
}

// Decided + one fix each, to attribute every violation to one decision.
module onlyGroupExit {
  import backgroundProcess(SESSIONS = Set(1, 2), CALLS = Set(1, 2),
    EXIT_ON_LEADER = false, CHECK_START_TIME = true, REAP_LOGS_GONE = false, RESUME_ALL = false).*
}
module onlyReapLogs {
  import backgroundProcess(SESSIONS = Set(1, 2), CALLS = Set(1, 2),
    EXIT_ON_LEADER = true, CHECK_START_TIME = true, REAP_LOGS_GONE = true, RESUME_ALL = false).*
}
module onlyResumeAll {
  import backgroundProcess(SESSIONS = Set(1, 2), CALLS = Set(1, 2),
    EXIT_ON_LEADER = true, CHECK_START_TIME = true, REAP_LOGS_GONE = false, RESUME_ALL = true).*
}

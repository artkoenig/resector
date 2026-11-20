// Scenario tests for backgroundProcess.qnt: the counterexamples found by simulation, pinned.
module decidedTest {
  import backgroundProcess(SESSIONS = Set(1, 2), CALLS = Set(1, 2),
    EXIT_ON_LEADER = true, CHECK_START_TIME = true, REAP_LOGS_GONE = false, RESUME_ALL = false).* from "./backgroundProcess"

  // Leader exits (`npm run dev` forks the server, bash ends): logged as ended, server still runs.
  run leaderExitLeavesServerRunningTest =
    init.then(openSession(1)).then(start(1, 1)).then(leaderExits((1, 1))).then(observeExit(1, 1))
      .expect(not(neverOutlivesApp))

  // Group dies while resector is down: reaper drops the record but logs nothing → pair untouchable forever.
  run goneOrphanStaysRunningTest =
    init.then(openSession(1)).then(start(1, 1)).then(crash).then(groupDies((1, 1))).then(restart)
      .expect(not(noStuckRunning))

  // `k`, then switch before the next request: resume notes only `session ended`, the user stop is lost.
  run userStopNoteLostOnSwitchTest =
    init.then(openSession(1)).then(start(1, 1)).then(userStop(1, 1)).then(closeSession).then(openSession(1))
      .expect(not(noLostExitNote))
}

module fixedTest {
  import backgroundProcess(SESSIONS = Set(1, 2), CALLS = Set(1, 2),
    EXIT_ON_LEADER = false, CHECK_START_TIME = true, REAP_LOGS_GONE = true, RESUME_ALL = true).* from "./backgroundProcess"

  run leaderExitKeepsRunningTest =
    init.then(openSession(1)).then(start(1, 1)).then(leaderExits((1, 1)))
      .expect(neverOutlivesApp and logRunning(procs.get((1, 1))))
      .then(groupDies((1, 1))).then(observeExit(1, 1))
      .expect(allInvariants)

  run goneOrphanLoggedOrphanedTest =
    init.then(openSession(1)).then(start(1, 1)).then(crash).then(groupDies((1, 1))).then(restart)
      .expect(allInvariants)

  run userStopNoteSurvivesSwitchTest =
    init.then(openSession(1)).then(start(1, 1)).then(userStop(1, 1)).then(closeSession).then(openSession(1))
      .then(sendRequest)
      .expect(allInvariants and wUserStopNoted)

}

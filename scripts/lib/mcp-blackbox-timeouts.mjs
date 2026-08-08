export const BLACKBOX_TIMEOUTS = Object.freeze({
  processStartup: 3_000,
  request: 5_000,
  upstreamStartup: 2_000,
  shutdown: 5_000,
  forcedCleanup: 5_000,
  fixtureReady: 3_000,
  statePoll: 25,
  test: 30_000,
});

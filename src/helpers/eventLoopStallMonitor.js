// A short interval fires late by however long its thread was blocked, so the
// drift is the stall, logged once the thread is free again. Hotkey presses and
// IPC queue behind such stalls invisibly to every other timing in the log.
const SUSPEND_DRIFT_MS = 30000;

export function startEventLoopStallMonitor({
  logger,
  label,
  intervalMs = 200,
  thresholdMs = 250,
  warnMs = 1000,
  now = () => performance.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let expected = now() + intervalMs;
  const timer = setIntervalFn(() => {
    const current = now();
    const stallMs = Math.round(current - expected);
    expected = current + intervalMs;
    if (stallMs < thresholdMs) return;
    if (stallMs >= SUSPEND_DRIFT_MS) {
      // Most likely the machine sleeping rather than this thread blocking.
      logger.debug(
        "Event loop timer delayed past suspend threshold",
        { process: label, delayMs: stallMs },
        "performance"
      );
      return;
    }
    const level = stallMs >= warnMs ? "warn" : "debug";
    logger[level]("Event loop stalled", { process: label, stallMs }, "performance");
  }, intervalMs);
  timer?.unref?.();
  return () => clearIntervalFn(timer);
}

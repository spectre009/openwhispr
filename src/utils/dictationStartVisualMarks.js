// The dictation window's half of "Dictation start visuals" (main's
// dictationStartVisuals.js): when main asks (`dictation-start-visuals-probe`,
// sent once the pill is on screen and the press's messages went out), report
// the first frame painted after it; when the pill's entrance settles, report
// that frame too. Each is a double requestAnimationFrame, so the time is the
// frame that showed the change, never a timeout. Main ignores marks for a press
// it isn't collecting, so a settle from an unrelated recording is harmless.

// The pill's entrance settles well within this after its press's probe.
export const START_VISUAL_MAX_AGE_MS = 5000;

export function createStartVisualReporter({
  report,
  now = Date.now,
  scheduleFrame = (callback) => requestAnimationFrame(callback),
  maxAgeMs = START_VISUAL_MAX_AGE_MS,
}) {
  let press = null;
  const afterNextFrame = (callback) => scheduleFrame(() => scheduleFrame(callback));
  const send = (pressId, mark) => {
    try {
      report({ pressId, mark, at: now() });
    } catch {
      // a report must never disturb the dictation window
    }
  };

  return {
    probe(pressId) {
      if (!Number.isFinite(pressId)) return;
      press = { pressId, probedAt: now(), settled: false };
      afterNextFrame(() => send(pressId, "pillPainted"));
    },
    settled() {
      const current = press;
      if (!current || current.settled || now() - current.probedAt > maxAgeMs) return;
      current.settled = true;
      afterNextFrame(() => send(current.pressId, "pillSettled"));
    },
  };
}

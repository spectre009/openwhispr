// The one owner of the dictation window's global Esc. It holds Esc while a
// recording runs, and while AudioManager's processing (transcription, cleanup)
// has run for more than SLOW_PROCESSING_MS: only then is a dictation worth
// cancelling from another app, and normal dictations (p99 8.2 s of processing)
// never take Esc from it. Pasting is not processing.
//
// Every phase change starts a new cycle, so a slow-processing timer, or a
// registration that lands late, can never grab or drop a newer recording's
// Esc. The hint ("Esc to cancel") shows only once registration succeeded.
// Register and unregister reach main in the order they're called, so the
// last call always wins there. Pure: the caller injects the IPC and timers.

export const SLOW_PROCESSING_MS = 8000;

/**
 * @param {{
 *   register: (purpose: "recording" | "processing") => Promise<{ success?: boolean } | undefined> | unknown,
 *   unregister: () => unknown,
 *   onHintChange?: (visible: boolean) => void,
 *   slowAfterMs?: number,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} deps
 */
export function createDictationCancelHotkey({
  register,
  unregister,
  onHintChange,
  slowAfterMs = SLOW_PROCESSING_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let phase = "idle";
  let cycle = 0;
  // What main was last asked to hold for this window, if anything.
  let held = null;
  let timer = null;
  let hint = false;

  const setHint = (visible) => {
    if (hint === visible) return;
    hint = visible;
    onHintChange?.(visible);
  };

  const release = () => {
    if (!held) return;
    held = null;
    try {
      unregister();
    } catch {
      // The slot is dropped on the next registration anyway.
    }
  };

  const hold = (purpose, onHeld) => {
    held = purpose;
    const owner = cycle;
    let pending;
    try {
      pending = register(purpose);
    } catch {
      pending = undefined;
    }
    Promise.resolve(pending).then(
      (result) => {
        if (owner !== cycle) return;
        if (result && result.success === false) {
          held = null;
          return;
        }
        onHeld?.();
      },
      () => {
        if (owner === cycle) held = null;
      }
    );
  };

  return {
    /** "idle" | "recording" | "processing", as the dictation window sees it. */
    setPhase(next) {
      if (next === phase) return;
      phase = next;
      cycle += 1;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      setHint(false);
      if (next === "recording") {
        hold("recording");
        return;
      }
      release();
      if (next !== "processing") return;
      const owner = cycle;
      timer = setTimer(() => {
        timer = null;
        if (owner !== cycle) return;
        hold("processing", () => setHint(true));
      }, slowAfterMs);
    },
    get phase() {
      return phase;
    },
    /** Whether main holds Esc for this window's processing (a press there cancels it). */
    get holdsProcessing() {
      return held === "processing";
    },
    dispose() {
      this.setPhase("idle");
    },
  };
}

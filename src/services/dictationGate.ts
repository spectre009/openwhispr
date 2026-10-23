// Dictation comes first: a window running background model work (Prompt
// Studio's test set) follows the dictation lifecycle main tracks
// (windowManager.setDictationLifecycleState, reported by the dictation
// window) and waits while a dictation is prepared, recorded or processed.
// Main reports "idle" when processing settles, just before the paste, so the
// gate also waits a short grace after it.

import type { DictationLifecycleSnapshot } from "../types/electron";

export const DICTATION_RESUME_GRACE_MS = 1500;

type LifecycleState = DictationLifecycleSnapshot["state"];

const STATES = new Set<LifecycleState>(["idle", "preparing", "recording", "processing"]);

export interface DictationLifecycleSource {
  get?: () => Promise<DictationLifecycleSnapshot | null | undefined> | undefined;
  subscribe?: (
    listener: (snapshot: DictationLifecycleSnapshot) => void
  ) => (() => void) | undefined;
}

export interface DictationGate {
  /** Starts following the lifecycle; call the returned function when done. */
  retain(): () => void;
  isActive(): boolean;
  /**
   * Resolves once no dictation is underway and the grace after the last one
   * has passed, or when `signal` aborts. `onPause` runs once if it had to wait
   * for a dictation.
   */
  waitForIdle(signal: AbortSignal, onPause?: () => void): Promise<void>;
}

export function createDictationGate({
  source,
  now = Date.now,
  graceMs = DICTATION_RESUME_GRACE_MS,
}: {
  source: DictationLifecycleSource;
  now?: () => number;
  graceMs?: number;
}): DictationGate {
  let state: LifecycleState = "idle";
  // No grace before the first dictation this window has seen.
  let idleSince = -Infinity;
  let users = 0;
  let unsubscribe: (() => void) | null = null;
  const waiters = new Set<() => void>();

  const apply = (snapshot: DictationLifecycleSnapshot | null | undefined) => {
    const next = STATES.has(snapshot?.state as LifecycleState)
      ? (snapshot!.state as LifecycleState)
      : "idle";
    if (next === state) return;
    state = next;
    if (state === "idle") idleSince = now();
    for (const wake of [...waiters]) wake();
  };

  // Resolves on the next lifecycle change, after `timeoutMs`, or on abort.
  const nextChange = (signal: AbortSignal, timeoutMs?: number) =>
    new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        waiters.delete(done);
        signal.removeEventListener("abort", done);
        if (timer) clearTimeout(timer);
        resolve();
      };
      waiters.add(done);
      signal.addEventListener("abort", done);
      if (timeoutMs !== undefined) timer = setTimeout(done, Math.max(0, timeoutMs));
    });

  return {
    retain() {
      users += 1;
      if (!unsubscribe) {
        unsubscribe = source.subscribe?.(apply) ?? (() => {});
        try {
          void Promise.resolve(source.get?.())
            .then(apply)
            .catch(() => {});
        } catch {
          // An unavailable lifecycle reads as idle.
        }
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        users -= 1;
        if (users === 0) {
          unsubscribe?.();
          unsubscribe = null;
        }
      };
    },

    isActive: () => state !== "idle",

    async waitForIdle(signal, onPause) {
      let paused = false;
      while (!signal.aborted) {
        if (state !== "idle") {
          if (!paused) {
            paused = true;
            onPause?.();
          }
          await nextChange(signal);
          continue;
        }
        const remaining = idleSince + graceMs - now();
        if (remaining <= 0) return;
        await nextChange(signal, remaining);
      }
    },
  };
}

/** The gate on main's lifecycle, shared by this window. */
export const dictationGate = createDictationGate({
  source: {
    get: () => window.electronAPI?.getDictationLifecycle?.(),
    subscribe: (listener) => window.electronAPI?.onDictationLifecycleChanged?.(listener),
  },
});

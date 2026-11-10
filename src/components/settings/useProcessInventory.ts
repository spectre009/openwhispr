import { useEffect, useState } from "react";
import type {
  ProcessInventoryHistory,
  ProcessInventoryResult,
  ProcessInventorySample,
} from "../../types/electron";

// History gains a point every 5 minutes; reading it once a minute shows a new
// point soon after main keeps it.
const HISTORY_REFRESH_MS = 60 * 1000;

export interface ProcessInventoryState {
  /** The latest sample; its `snapshot` is null until main has measured once. */
  sample: ProcessInventorySample | null;
  history: ProcessInventoryHistory | null;
  /** The app can't answer (no preload method, or the call failed). */
  failed: boolean;
}

/** The newer of two samples: a reply that crossed a broadcast never takes the numbers back. */
function newer(
  previous: ProcessInventorySample | null,
  next: ProcessInventorySample
): ProcessInventorySample {
  const before = previous?.snapshot?.at ?? -1;
  const after = next.snapshot?.at ?? -1;
  return after >= before ? next : { ...next, snapshot: previous?.snapshot ?? null };
}

/**
 * Settings › Data › Processes & resources' numbers. While `active` (the page
 * shows while Settings is visible) it subscribes, so main streams a sample
 * every 2 seconds (`process-inventory-sample`), and reads the 24-hour history
 * once a minute; otherwise, and on unmount, it unsubscribes. The last sample
 * stays shown while hidden or paused.
 */
export function useProcessInventory(active: boolean): ProcessInventoryState {
  const [sample, setSample] = useState<ProcessInventorySample | null>(null);
  const [history, setHistory] = useState<ProcessInventoryHistory | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api?.subscribeProcessInventory || !api.getProcessInventory) {
      setFailed(true);
      return undefined;
    }
    let cancelled = false;
    const apply = (next: ProcessInventorySample | null | undefined) => {
      if (cancelled || !next || typeof next !== "object" || !("snapshot" in next)) return;
      setSample((previous) => newer(previous, next));
      setFailed(false);
    };
    const unlisten = api.onProcessInventorySample?.(apply);
    const readHistory = () =>
      Promise.resolve(api.getProcessInventory?.({ history: true }))
        .then((result: ProcessInventoryResult | undefined) => {
          if (cancelled || !result || typeof result !== "object") return;
          setHistory(result.history ?? null);
          apply(result);
        })
        .catch(() => {});

    Promise.resolve(api.subscribeProcessInventory())
      .then((answer) => {
        if (answer && typeof answer === "object") apply(answer);
        else if (!cancelled) setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    void readHistory();
    const timer = setInterval(() => void readHistory(), HISTORY_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      unlisten?.();
      Promise.resolve(api.unsubscribeProcessInventory?.()).catch(() => {});
    };
  }, [active]);

  return { sample, history, failed };
}

/**
 * System › Diagnostics' one line: the latest sample, read (never measured)
 * when `active` turns on. `undefined` until main answers; `null` when the app
 * can't answer.
 */
export function useProcessSummary(active: boolean): ProcessInventorySample | null | undefined {
  const [sample, setSample] = useState<ProcessInventorySample | null | undefined>(undefined);

  useEffect(() => {
    if (!active) return undefined;
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api?.getProcessInventory) {
      setSample(null);
      return undefined;
    }
    let cancelled = false;
    Promise.resolve(api.getProcessInventory({ history: false }))
      .then((result) => {
        if (!cancelled) setSample(result && typeof result === "object" ? result : null);
      })
      .catch(() => {
        if (!cancelled) setSample(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return sample;
}

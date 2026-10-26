import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StorageInventoryItem,
  StorageInventoryResult,
  StorageResourceId,
} from "../../types/electron";

export interface StorageInventoryState {
  result: StorageInventoryResult | null;
  /** A measurement is running ("Measuring…"). */
  loading: boolean;
  failed: boolean;
  /** Measures again, past main's one-minute cache. */
  refresh: () => Promise<void>;
  item: (id: StorageResourceId) => StorageInventoryItem | null;
}

/**
 * Settings › Storage's inventory from main (`storage-inventory`), read when
 * `active` turns on (the page shows while Settings is visible), and again on
 * `refresh()` after an action or the Refresh button. Nothing polls: a hidden
 * page reads nothing.
 */
export function useStorageInventory(active: boolean): StorageInventoryState {
  const [result, setResult] = useState<StorageInventoryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api?.getStorageInventory) {
      setFailed(true);
      return;
    }
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await api.getStorageInventory({ refresh });
      if (current !== generation.current) return;
      if (next && Array.isArray(next.items)) {
        setResult(next);
        setFailed(false);
      } else {
        setFailed(true);
      }
    } catch {
      if (current === generation.current) setFailed(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void load(false);
  }, [active, load]);

  const refresh = useCallback(() => load(true), [load]);
  const item = useCallback(
    (id: StorageResourceId) => result?.items.find((entry) => entry.id === id) ?? null,
    [result]
  );

  return { result, loading, failed, refresh, item };
}

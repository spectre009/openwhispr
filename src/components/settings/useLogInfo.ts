import { useCallback, useEffect, useRef, useState } from "react";
import type { LogInfoResult, LogProblem } from "../../types/electron";

/**
 * The log's settings, size and recent problems from main (`log-info`,
 * `log-recent-problems`), read when `active` turns on (the page shows while
 * Settings is visible), when any window changes the settings, and on
 * `refresh()` after an action. Nothing polls: a hidden page reads nothing.
 */
export function useLogInfo(active: boolean) {
  const [info, setInfo] = useState<LogInfoResult | null>(null);
  const [problems, setProblems] = useState<LogProblem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api?.getLogInfo) {
      setFailed(true);
      return;
    }
    const current = ++generation.current;
    try {
      const [nextInfo, nextProblems] = await Promise.all([
        api.getLogInfo(),
        api.getRecentLogProblems?.() ?? Promise.resolve([]),
      ]);
      if (current !== generation.current) return;
      if (nextInfo && typeof nextInfo === "object") {
        setInfo(nextInfo);
        setFailed(false);
      } else {
        setFailed(true);
      }
      setProblems(Array.isArray(nextProblems) ? nextProblems : []);
    } catch {
      if (current === generation.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useEffect(() => {
    const subscribe = window.electronAPI?.onLogSettingsChanged;
    if (typeof subscribe !== "function") return undefined;
    return subscribe(() => {
      if (activeRef.current) void refresh();
    });
  }, [refresh]);

  return { info, setInfo, problems, failed, refresh };
}

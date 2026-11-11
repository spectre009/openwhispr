import { useEffect, useState } from "react";
import { formatPillElapsed } from "../helpers/recordingIndicator";

/**
 * A recording's elapsed time ("0:07"), ticking once a second from the
 * recording's own start time, so a slow render never drifts the readout.
 */
export function useElapsedLabel(startedAt: number | null | undefined, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);
  return formatPillElapsed(active && startedAt ? now - startedAt : 0);
}

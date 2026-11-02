import { useEffect, useRef } from "react";
import { createStartVisualReporter } from "../utils/dictationStartVisualMarks";

/**
 * Reports a dictation start's painted frames to main ("Dictation start
 * visuals"): the first frame after main's probe, and the frame where the
 * pill's entrance settles (`entrancePhase` from useListeningEntrancePhase).
 */
export function useDictationStartVisuals(entrancePhase) {
  const reporterRef = useRef(null);
  if (!reporterRef.current) {
    reporterRef.current = createStartVisualReporter({
      report: (mark) => window.electronAPI?.reportDictationStartVisual?.(mark),
    });
  }

  useEffect(() => {
    const subscribe = window.electronAPI?.onDictationStartVisualsProbe;
    if (typeof subscribe !== "function") return undefined;
    return subscribe((payload) => reporterRef.current?.probe(payload?.pressId));
  }, []);

  useEffect(() => {
    if (entrancePhase === "settled") reporterRef.current?.settled();
  }, [entrancePhase]);
}

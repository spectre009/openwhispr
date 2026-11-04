import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NOTHING_HEARD_TIMING } from "../helpers/voicePillPresentation";

export type NothingHeardPhase = "playing" | "faded" | null;

/**
 * The pill's quiet end of a short empty dictation (the red spin-down,
 * NOTHING_HEARD_TIMING): "playing" for the whole beat from each bump of
 * `seq`, then the pill does what it does after any dictation. With auto-hide
 * (`autoHide`: nothing else keeps the window up) the pill has faded out by
 * then and stays "faded" until its window has hidden, so it never shows again
 * first; otherwise it settles to idle. A new dictation (`interrupted`) ends it
 * at once, and so does anything that keeps the window up while it's faded.
 */
export function useNothingHeardPill({
  seq,
  interrupted,
  autoHide,
}: {
  seq: number;
  interrupted: boolean;
  autoHide: boolean;
}): NothingHeardPhase {
  const [phase, setPhase] = useState<NothingHeardPhase>(null);
  const seenSeqRef = useRef(seq);
  const autoHideRef = useRef(autoHide);
  autoHideRef.current = autoHide;

  useLayoutEffect(() => {
    if (seq === seenSeqRef.current) return undefined;
    seenSeqRef.current = seq;
    if (interrupted) return undefined;
    setPhase("playing");
    const timer = setTimeout(
      () => setPhase(autoHideRef.current ? "faded" : null),
      NOTHING_HEARD_TIMING.totalMs
    );
    return () => clearTimeout(timer);
  }, [seq, interrupted]);

  useLayoutEffect(() => {
    if (interrupted) setPhase(null);
  }, [interrupted]);

  useEffect(() => {
    if (phase !== "faded") return undefined;
    if (!autoHide) {
      setPhase(null);
      return undefined;
    }
    const timer = setTimeout(() => setPhase(null), NOTHING_HEARD_TIMING.fadedHoldMs);
    return () => clearTimeout(timer);
  }, [phase, autoHide]);

  return interrupted ? null : phase;
}

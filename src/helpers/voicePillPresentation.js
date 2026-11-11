import { LIVE_TRANSCRIPT_SURFACE_LIMITS } from "./voiceSurfaceGeometry.mjs";
import { parsePanelPosition } from "./floatingIconPlacement.js";

export { LIVE_TRANSCRIPT_SURFACE_LIMITS };

// The pill's two rendered footprints (px). This is a real cross-process
// contract: WINDOW_SIZES.RECORDING in src/helpers/windowConfig.js sizes the
// native overlay window around the compact recording pill, so these values
// and that window size may only change together.
export const VOICE_PILL_FOOTPRINT = Object.freeze({
  idle: Object.freeze({ width: 40, height: 40 }),
  // 98 = 6px edge inset + 22px icon + 6px gap + 52px waveform + 12px edge
  // inset (the waveform side keeps extra air; insets include the 1px border).
  recording: Object.freeze({ width: 98, height: 36 }),
  // REC: 6 + 10px dot + 6 + elapsed slot + 6 + 52px waveform + 12.
  rec: Object.freeze({ width: 92 + 32, height: 36 }),
  // Any other style with the elapsed time: today's row + 6 + elapsed slot.
  elapsed: Object.freeze({ width: 104 + 32, height: 36 }),
});

// The elapsed-time slot (px): fixed, so the pill never changes width as the
// time ticks. It fits "59:59" and, past an hour, "1h02" in the pill's 12px
// semibold tabular numerals: 30.8px in Noto Sans, the widest of Yowza, Noto
// Sans and Segoe UI (measured in the dictation window).
export const VOICE_PILL_ELAPSED_SLOT = 32;
export const VOICE_PILL_REC_DOT = 10;

/**
 * Which wide recording row a floating pill shows: "rec" (dot, time,
 * waveform), "elapsed" (the usual row plus the time) or null for today's row.
 * Pills inside a panel keep today's row, which the panel chrome is sized for.
 */
export function resolveRecordingLayout({ style, showElapsed, recording, inPanel = false }) {
  if (!recording || inPanel) return null;
  if (style === "rec") return "rec";
  return showElapsed ? "elapsed" : null;
}

/** The footprint target for a pill, compact or not, in a given layout. */
export function resolvePillFootprint({ compact, layout = null }) {
  if (!compact) return VOICE_PILL_FOOTPRINT.idle;
  if (layout === "rec") return VOICE_PILL_FOOTPRINT.rec;
  if (layout === "elapsed") return VOICE_PILL_FOOTPRINT.elapsed;
  return VOICE_PILL_FOOTPRINT.recording;
}

// The hover cancel control that emerges beside the pill (px). Same contract:
// WINDOW_SIZES.RECORDING must fit pill + gap + cancel inside its dock insets,
// or the control clips at the native window bounds.
export const VOICE_PILL_CANCEL = Object.freeze({ size: 28, gap: 8 });

export const LISTENING_ENTRANCE_TIMING = Object.freeze({
  // A short hold that reads as an acknowledged press before the control
  // changes shape. It was 420ms when it also had to hide the native window
  // grow; BASE and RECORDING now share one box (windowConfig.js), so the
  // floating pill's hold is purely the design beat.
  thinkingMs: 260,
  expansionMs: 300,
  // Hold the finished footprint briefly so the waveform reveal cannot be
  // perceived as part of the width animation.
  waveformDelayMs: 100,
});

// The pill's morph between the two VOICE_PILL_FOOTPRINT boxes. The cancel
// skin tweens its capsule geometry against the same duration and curve
// (usePillFootprintTween), so a fused outline never drifts off the real pill —
// one definition keeps them from diverging.
export const VOICE_PILL_GROW_EASING = "cubic-bezier(0.2, 0, 0, 1)";
export const VOICE_PILL_GROW_TRANSITION = `${LISTENING_ENTRANCE_TIMING.expansionMs}ms ${VOICE_PILL_GROW_EASING}`;

export const LIVE_TRANSCRIPT_ENTRANCE_TIMING = Object.freeze({
  encapsulateMs: 180,
  encapsulateHoldMs: 140,
  horizontalMs: 320,
  controlsDelayMs: 70,
  controlsRevealMs: 200,
  contentDelayMs: 110,
  measurementSettleMs: 220,
  panelExpansionMs: 320,
  contentRevealDelayMs: 80,
  contentSettleMs: 280,
});

export function getLiveTranscriptEntranceTimeline(timing = LIVE_TRANSCRIPT_ENTRANCE_TIMING) {
  const horizontalAtMs = timing.encapsulateMs + timing.encapsulateHoldMs;
  const controlsAtMs = horizontalAtMs + timing.horizontalMs + timing.controlsDelayMs;
  const prepareAtMs = controlsAtMs + timing.controlsRevealMs + timing.contentDelayMs;
  const panelAtMs = prepareAtMs + timing.measurementSettleMs;
  const contentAtMs = panelAtMs + timing.panelExpansionMs + timing.contentRevealDelayMs;
  return {
    horizontalAtMs,
    controlsAtMs,
    prepareAtMs,
    panelAtMs,
    contentAtMs,
    streamAtMs: contentAtMs + timing.contentSettleMs,
  };
}

export function resolveLiveTranscriptEntrancePresentation(phase) {
  const effectivePhase = phase === "idle" ? "encapsulate" : phase;
  const encapsulating = effectivePhase === "encapsulate";
  const panelExpanded = effectivePhase === "panel" || effectivePhase === "content";
  const controlsVisible =
    effectivePhase === "controls" ||
    effectivePhase === "prepare" ||
    effectivePhase === "panel" ||
    effectivePhase === "content";
  const contentVisible = effectivePhase === "content";

  return {
    coreStage: encapsulating ? "encapsulated" : panelExpanded ? "content" : "footer",
    controlsVisible,
    contentVisible,
  };
}

/**
 * Expanded voice modes only animate horizontally from the two supported edge
 * docks. Keep center on the established right-origin choreography until a
 * dedicated centered transition is designed.
 */
export function resolveVoiceHorizontalDirection(panelStartPosition) {
  return parsePanelPosition(panelStartPosition).horizontal === "left" ? "left" : "right";
}

export function resolveVoicePillDock({
  liveTranscriptOpen,
  liveTranscriptEntrancePhase,
  panelStartPosition,
  horizontalDirection = resolveVoiceHorizontalDirection(panelStartPosition),
}) {
  if (liveTranscriptOpen) {
    if (liveTranscriptEntrancePhase === "encapsulate") {
      return `live-transcript-encapsulated-bottom-${horizontalDirection}`;
    }

    // The established right-origin flow carries the pill to the left side as
    // the footer grows leftward. A left-origin flow already occupies that
    // anchor, so keep it fixed while the footer grows rightward around it.
    return "live-transcript-bottom-left";
  }
  const { vertical, horizontal } = parsePanelPosition(panelStartPosition);
  if (vertical === "top")
    return horizontal === "center" ? "top-center" : `top-${horizontalDirection}`;
  if (horizontal === "center") return "center";
  return `bottom-${horizontalDirection}`;
}

export function getListeningEntranceTimeline(timing = LISTENING_ENTRANCE_TIMING) {
  const settleAtMs = timing.thinkingMs + timing.expansionMs;
  return {
    expandAtMs: timing.thinkingMs,
    settleAtMs,
    waveformAtMs: settleAtMs + timing.waveformDelayMs,
  };
}

/**
 * Stage a recording entrance without delaying microphone capture. `idle` is
 * treated as the first thinking frame so a recording edge cannot paint the
 * final expanded waveform before the layout effect starts the timers.
 */
export function resolveListeningEntrancePresentation({ isRecording, phase }) {
  if (!isRecording) {
    return {
      activeState: null,
      collapseToLogo: false,
      compactPill: false,
      waveformVisible: true,
    };
  }

  const effectivePhase = phase === "idle" ? "thinking" : phase;
  if (effectivePhase === "thinking") {
    return {
      // Keep the actual recording state stable across every visual phase. The
      // waveform can sample audio while hidden and its reveal changes opacity
      // only; it never remounts or changes the pill's layout.
      activeState: "recording",
      collapseToLogo: true,
      compactPill: false,
      waveformVisible: false,
    };
  }

  if (effectivePhase === "expanding" || effectivePhase === "settled") {
    // Both phases render identically on purpose: "settled" exists only as a
    // timing beat that holds the finished footprint before the waveform
    // reveal, so the presentation must not change between them.
    return {
      activeState: "recording",
      collapseToLogo: false,
      compactPill: true,
      waveformVisible: false,
    };
  }

  return {
    activeState: "recording",
    collapseToLogo: false,
    compactPill: true,
    waveformVisible: true,
  };
}

/**
 * Resolve only the active voice presentation. Idle/hover styling remains owned
 * by App because it also depends on pointer and microphone availability state.
 */
export function resolveVoiceActivityPresentation({
  isRecording,
  isProcessing,
  isAssistantVoice,
  assistantThinking,
}) {
  if (isRecording) {
    return { activeState: "recording", compactPill: true, isAgentThinking: false };
  }

  if (assistantThinking || (isAssistantVoice && isProcessing)) {
    return { activeState: "thinking", compactPill: false, isAgentThinking: true };
  }

  if (isProcessing) {
    return { activeState: "thinking", compactPill: false, isAgentThinking: false };
  }

  return { activeState: null, compactPill: false, isAgentThinking: false };
}

// The pill's quiet end of a short empty dictation (animation A, "red
// spin-down"): the thinking ring turns red, keeps spinning as it slows, and
// fades; with auto-hide the pill fades out with it, else it settles to idle.
// VoicePill hands these to dictation-panel.css as custom properties.
export const NOTHING_HEARD_TIMING = Object.freeze({
  toRedMs: 250,
  spinDownDelayMs: 100,
  spinDownMs: 1000,
  pillFadeDelayMs: 1050,
  pillFadeMs: 350,
  // The whole beat, after which the pill does what it does after any dictation.
  totalMs: 1400,
  // A faded pill waits this long at most for its window to hide before it
  // shows as idle again (the hide is immediate; this only bounds a lost one).
  fadedHoldMs: 2000,
});

/**
 * A collapsed Live Transcript can be reopened only while its owning dictation
 * is still recording or finalizing. Completed and Agent sessions must return
 * the pill to its normal identity instead of inheriting a stale chevron.
 */
export function shouldOfferLiveTranscriptReopen({
  manuallyCollapsed,
  isRecording,
  isProcessing,
  isAssistantVoice,
}) {
  return Boolean(
    manuallyCollapsed && !isAssistantVoice && (Boolean(isRecording) || Boolean(isProcessing))
  );
}

/**
 * Keeps the shared pill's action semantics scoped to the surface that owns it.
 * Live Transcript may stop an active recording through the pill and always
 * exposes a distinct discard action while recording or processing.
 */
export function resolveVoicePillInteraction({
  liveTranscriptMounted,
  isRecording,
  isProcessing,
  isHovered = false,
}) {
  const active = Boolean(isRecording) || Boolean(isProcessing);
  return {
    pillInteractive: !liveTranscriptMounted || Boolean(isRecording),
    // Live Transcript always shows its discard control; the bare pill shows
    // it on hover so a stalled processing step can still be cancelled.
    cancelVisible: active && (Boolean(liveTranscriptMounted) || Boolean(isHovered)),
  };
}

export function shouldActivateVoicePill({
  hasDragged,
  liveTranscriptMounted,
  isProcessing,
  isAgentThinking,
}) {
  return Boolean((!hasDragged || liveTranscriptMounted) && !isProcessing && !isAgentThinking);
}

export function isVoicePillActivationKey(key) {
  return key === "Enter" || key === " ";
}

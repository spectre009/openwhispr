import { forwardRef, useEffect, useState, type HTMLAttributes } from "react";
import { ChevronUp } from "../icons";
import { cn } from "../lib/utils";
import { PillWaveform } from "./PillWaveform";
import { VoiceIdentityIcon } from "./VoiceIdentityIcon";
import { RESTING_WAVE_SILHOUETTE, WAVEFORM_BAR_COUNT } from "./waveformMath";
import {
  VOICE_PILL_ELAPSED_SLOT,
  VOICE_PILL_FOOTPRINT,
  VOICE_PILL_GROW_TRANSITION,
  VOICE_PILL_REC_DOT,
  resolvePillFootprint,
} from "../../helpers/voicePillPresentation";
import { formatPillElapsed, resolveRecordingChromeStyle } from "../../helpers/recordingIndicator";
import type { RecordingIndicatorStyle } from "../../types/electron";

export type VoicePillState =
  "idle" | "hover" | "recording" | "processing" | "thinking" | "unavailable";

export type VoicePillRecordingLayout = "rec" | "elapsed" | null;

interface VoicePillProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  variant: "floating" | "panel";
  state: VoicePillState;
  getAudioLevel: () => number | null;
  expanded?: boolean;
  collapseToLogo?: boolean;
  waveformVisible?: boolean;
  waveformOnlyWhileRecording?: boolean;
  integratedWithPanel?: boolean;
  /** The cancel button's liquid skin owns the fused surface; go headless. */
  liquidFused?: boolean;
  agentMode?: boolean;
  showExpandChevron?: boolean;
  isDragging?: boolean;
  horizontalDirection?: "left" | "right";
  /** Settings → Floating icon → While recording. Colors come from
   *  recordingIndicatorCssVars on an ancestor shared with the cancel skin. */
  recordingStyle?: RecordingIndicatorStyle;
  /** The wide recording row (resolveRecordingLayout); the parent sizes the
   *  cancel skin from the same value. */
  recordingLayout?: VoicePillRecordingLayout;
  /** When the recording started (ms since epoch), for the elapsed time. */
  recordingStartedAt?: number | null;
  /** Bumped by the "still recording" reminder; each change pulses the pill. */
  reminderPulseKey?: number;
}

// Ticks once a second from the recording's own start time, so a slow render
// never drifts the readout.
function useElapsedLabel(startedAt: number | null | undefined, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);
  return formatPillElapsed(active && startedAt ? now - startedAt : 0);
}

function useReminderPulse(key: number) {
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (!key) return;
    setPulsing(true);
    const timer = setTimeout(() => setPulsing(false), 1300);
    return () => clearTimeout(timer);
  }, [key]);
  return pulsing;
}

// Sized from WAVEFORM_BAR_COUNT so a bar-count change can never silently
// desync the resting silhouette from the live waveform's footprint.
const RESTING_WAVE_HEIGHTS = Array.from(
  { length: WAVEFORM_BAR_COUNT },
  (_, index) => RESTING_WAVE_SILHOUETTE[index % RESTING_WAVE_SILHOUETTE.length]
);

// Icon↔waveform spacing inside the compact pill. Together with the 98px
// recording footprint and pr-1.5, centering lands the documented 6/12 edge
// insets (VOICE_PILL_FOOTPRINT in voicePillPresentation.js).
const COMPACT_CONTENT_GAP_PX = 6;

// Mirrored by .liquid-cancel-skin[data-pill-state] in dictation-panel.css,
// which redraws this chrome while the cancel skin owns the fused surface —
// change together. A recording style (data-recording-style) replaces the
// recording row's chrome there and in the skin's recording rules alike.
const STATE_APPEARANCE: Record<VoicePillState, string> = {
  idle: "border-border-hover bg-surface-1 text-muted-foreground dark:border-border/50",
  hover: "border-border-hover bg-surface-3 text-foreground",
  recording: "border-border-hover bg-surface-1 text-foreground",
  processing: "border-border/60 bg-surface-1 text-foreground/70",
  thinking: "border-border/60 bg-surface-1 text-foreground",
  unavailable: "border-border/60 bg-surface-1 text-muted-foreground",
};

/** One persistent control that resizes between the floating and panel layouts. */
export const VoicePill = forwardRef<HTMLDivElement, VoicePillProps>(function VoicePill(
  {
    variant,
    state,
    getAudioLevel,
    expanded = false,
    collapseToLogo = false,
    waveformVisible = true,
    waveformOnlyWhileRecording = false,
    integratedWithPanel = false,
    liquidFused = false,
    agentMode = false,
    showExpandChevron = false,
    isDragging = false,
    horizontalDirection = "right",
    recordingStyle = "classic",
    recordingLayout = null,
    recordingStartedAt = null,
    reminderPulseKey = 0,
    className,
    style,
    ...props
  },
  ref
) {
  const isRecording = state === "recording";
  const isProcessing = state === "processing";
  const isThinking = state === "thinking";
  const isUnavailable = state === "unavailable";
  // Only a pill that owns its chrome takes the style: inside Live Transcript
  // and under the fused cancel skin it stays headless (the skin carries it).
  const recordingChromeStyle = resolveRecordingChromeStyle({
    style: recordingStyle,
    state,
    integratedWithPanel,
    liquidFused,
  });
  // The beacon glow sits outside the pill's box, so it stays lit while the
  // fused skin draws the surface; only the Live Transcript footer drops it.
  const showRecordingBeacon =
    resolveRecordingChromeStyle({ style: recordingStyle, state, integratedWithPanel }) === "beacon";
  // One Signal glow (comet orbit over a breathing halo) serves both
  // identities; only the palette differs. It lights for the real thinking
  // state alone — glowing during the entrance or while listening would read
  // as work already in flight before any transcript exists.
  const showSignalGlow = !isUnavailable && isThinking;
  const isPanel = variant === "panel";
  const collapseToIdentity = collapseToLogo || isThinking;
  const showCompactPill =
    !collapseToIdentity && (isRecording || expanded || (isPanel && !waveformOnlyWhileRecording));
  const showDivider = showCompactPill && waveformVisible && !isRecording;
  // The wide recording rows only exist on a compact, recording pill.
  const layout = showCompactPill && isRecording ? recordingLayout : null;
  const isRecLayout = layout === "rec";
  const elapsedLabel = useElapsedLabel(recordingStartedAt, layout !== null);
  const reminderPulsing = useReminderPulse(reminderPulseKey);
  // The hidden divider's margins are what carry the compact pill's 6px
  // icon↔waveform gap; a visible divider keeps 4px flanking its 1px rule.
  const dividerMargin = showCompactPill ? (showDivider ? 4 : COMPACT_CONTENT_GAP_PX / 2) : 0;
  const identitySize = 22;
  const floatingHover = !isPanel && state === "hover";
  const footprint = showCompactPill
    ? resolvePillFootprint({ compact: true, layout })
    : VOICE_PILL_FOOTPRINT.idle;

  const pill = (
    <div
      ref={ref}
      className={cn(
        "voice-pill-control relative flex items-center justify-center overflow-hidden rounded-full border",
        showCompactPill && "pr-1.5",
        "shadow-[var(--shadow-card)]",
        STATE_APPEARANCE[state],
        className
      )}
      style={{
        // Listening uses the same compact pill as the assistant panel. The
        // previous wide recording bar made the control feel like a different
        // surface and forced an unnecessary large window resize.
        width: footprint.width,
        height: footprint.height,
        cursor: isProcessing || isThinking ? "not-allowed" : isDragging ? "grabbing" : "pointer",
        // Yields to the fused rule's `box-shadow: none` while the liquid skin
        // owns the chrome — an inline shadow would outrank it and paint a
        // phantom capsule when a de-fusing skin lingers over a hovered pill.
        boxShadow: floatingHover && !liquidFused ? "var(--shadow-card-hover-subtle)" : undefined,
        transition: `width ${VOICE_PILL_GROW_TRANSITION}, height ${VOICE_PILL_GROW_TRANSITION}, padding-left ${VOICE_PILL_GROW_TRANSITION}, padding-right ${VOICE_PILL_GROW_TRANSITION}, background-color 220ms ease-out, border-color 220ms ease-out, box-shadow 220ms ease-out`,
        ...style,
      }}
      data-horizontal-direction={horizontalDirection}
      data-integrated-with-panel={integratedWithPanel || undefined}
      data-liquid-fused={liquidFused || undefined}
      data-agent-mode={agentMode || undefined}
      data-agent-beam-active={(agentMode && isThinking) || undefined}
      data-expand-chevron={showExpandChevron || undefined}
      data-recording-style={recordingChromeStyle ?? undefined}
      data-recording-layout={layout ?? undefined}
      data-reminder-pulse={reminderPulsing || undefined}
      {...props}
    >
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-foreground/10 to-transparent transition-opacity duration-200 ease-out"
        style={{ opacity: state === "hover" ? 0.72 : 0 }}
      />

      <span
        aria-hidden="true"
        className="voice-pill-rec-dot shrink-0 rounded-full"
        style={{
          width: isRecLayout ? VOICE_PILL_REC_DOT : 0,
          height: VOICE_PILL_REC_DOT,
          marginRight: isRecLayout ? COMPACT_CONTENT_GAP_PX : 0,
          opacity: isRecLayout ? 1 : 0,
          transition: `width ${VOICE_PILL_GROW_TRANSITION}, margin ${VOICE_PILL_GROW_TRANSITION}, opacity 180ms ease-out`,
        }}
      />
      {isRecLayout && (
        <span
          className="voice-pill-elapsed shrink-0 text-center text-[12px] font-semibold leading-none tabular-nums"
          style={{ width: VOICE_PILL_ELAPSED_SLOT }}
        >
          {elapsedLabel}
        </span>
      )}

      <span
        className="voice-pill-identity-slot relative inline-block shrink-0 transition-[width,height,opacity] duration-200"
        style={{
          width: isRecLayout ? 0 : identitySize,
          height: identitySize,
          opacity: isRecLayout ? 0 : 1,
        }}
        aria-hidden="true"
      >
        <span
          className={cn(
            "voice-pill-identity-logo absolute inset-0 transition-[opacity,transform] duration-200 ease-out",
            showExpandChevron ? "translate-y-1 scale-75 opacity-0" : "scale-100 opacity-100"
          )}
        >
          <VoiceIdentityIcon
            size={identitySize}
            agentMode={agentMode}
            className={cn(
              "transition-[width,height] duration-200",
              state === "idle" && "text-foreground",
              (isUnavailable || isProcessing) && "animate-pulse"
            )}
          />
        </span>
        <ChevronUp
          className={cn(
            "voice-pill-expand-chevron absolute inset-0 m-auto size-5 transition-[opacity,transform] duration-200 ease-out",
            showExpandChevron ? "scale-100 opacity-100" : "translate-y-1 scale-75 opacity-0"
          )}
          strokeWidth={2}
        />
      </span>

      <div
        className="shrink-0 overflow-hidden bg-border/60"
        style={{
          height: showCompactPill ? 16 : 20,
          width: showDivider ? 1 : 0,
          marginLeft: dividerMargin,
          marginRight: dividerMargin,
          opacity: showDivider ? 1 : 0,
          transition: `width ${VOICE_PILL_GROW_TRANSITION}, margin ${VOICE_PILL_GROW_TRANSITION}, opacity 180ms ease-out`,
        }}
      />

      <div
        className="voice-pill-waveform relative shrink-0 overflow-hidden text-foreground"
        style={{
          width: showCompactPill ? 52 : 0,
          height: showCompactPill ? 24 : 32,
          transition: `width ${VOICE_PILL_GROW_TRANSITION}, height ${VOICE_PILL_GROW_TRANSITION}`,
        }}
      >
        <div
          className="absolute inset-0 flex items-center justify-center gap-0.75 transition-opacity duration-200 ease-out"
          style={{ opacity: showCompactPill && waveformVisible && !isRecording ? 1 : 0 }}
          aria-hidden="true"
        >
          {RESTING_WAVE_HEIGHTS.map((height, index) => (
            <span
              key={`${height}-${index}`}
              className="w-0.5 rounded-full bg-current"
              style={{ height }}
            />
          ))}
        </div>
        <PillWaveform
          getLevel={getAudioLevel}
          active={isRecording}
          className={cn(
            "absolute inset-0 transition-opacity duration-200 ease-out",
            showCompactPill && waveformVisible && isRecording ? "opacity-100" : "opacity-0"
          )}
        />
      </div>

      {layout === "elapsed" && (
        <span
          className="voice-pill-elapsed shrink-0 text-center text-[12px] font-semibold leading-none tabular-nums"
          style={{ width: VOICE_PILL_ELAPSED_SLOT, marginLeft: COMPACT_CONTENT_GAP_PX }}
        >
          {elapsedLabel}
        </span>
      )}

      {isUnavailable && (
        <div className="pointer-events-none absolute inset-0 rounded-full border-2 border-foreground/30 animate-pulse" />
      )}
    </div>
  );

  return (
    <span className="voice-pill-glow-anchor">
      <span
        aria-hidden="true"
        className="processing-signal-glow"
        data-active={showSignalGlow ? "true" : undefined}
        data-agent={agentMode || undefined}
      >
        <span className="processing-signal-ring" />
      </span>
      <span
        aria-hidden="true"
        className="recording-beacon-glow"
        data-active={showRecordingBeacon ? "true" : undefined}
      >
        <span className="recording-beacon-ripple" />
      </span>
      {pill}
    </span>
  );
});

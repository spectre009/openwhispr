import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Maximize, Mic, Square, X, type IconComponent } from "../icons";
import { cn } from "../lib/utils";
import { ICON_BUTTON } from "../chat/interactions/cardStyles";
import { PillWaveform } from "../dictation/PillWaveform";
import { resolveAgentPillRecordingLook } from "../../helpers/recordingIndicator";
import { VOICE_PILL_ELAPSED_SLOT, VOICE_PILL_REC_DOT } from "../../helpers/voicePillPresentation";
import { useElapsedLabel } from "../../hooks/useElapsedLabel";
import type { RecordingIndicatorStyle } from "../../types/electron";
import type { AgentPillButton, AgentPillControls } from "./agentWindowState";
import { useAgentWindowDrag } from "./useAgentWindowDrag";

const BUTTONS: Record<AgentPillButton, { icon: IconComponent; label: string }> = {
  expand: { icon: Maximize, label: "agentWindow.actions.expand" },
  mic: { icon: Mic, label: "agentWindow.actions.speak" },
  keyboard: { icon: Keyboard, label: "agentWindow.actions.type" },
  stop: { icon: Square, label: "agentWindow.actions.stop" },
  close: { icon: X, label: "agentWindow.actions.close" },
};

interface AgentPillProps {
  controls: AgentPillControls;
  /** The waveform moves only while the take records. */
  recording: boolean;
  readLevel: () => number;
  /** Shown in place of the waveform (already translated). */
  notice?: string | null;
  /** The provider or microphone failure behind a voice notice. */
  noticeDetail?: string;
  /** Voice input is unavailable with this transcription provider: Mic is off. */
  micUnavailableHint?: string;
  /** A take is still transcribing, or a reply is running. */
  micDisabled?: boolean;
  /** A card waits on the user: Expand pulses blue until the modal opens to it. */
  expandCue?: boolean;
  /** Inside the modal the pill is a shade apart from the panel it sits on. */
  inModal?: boolean;
  /** Settings → Floating icon → While recording: the take's pill takes the
   *  style, and the elapsed time when REC or "Show recording time" asks. */
  recordingStyle?: RecordingIndicatorStyle;
  recordingShowElapsed?: boolean;
  /** When the take started recording (ms since epoch). */
  recordingStartedAt?: number | null;
  /** The --recording-* variables, in the assistant's mode color. */
  recordingVars?: CSSProperties;
  onAction: (button: AgentPillButton) => void;
  className?: string;
}

/** The agent's pill: what it is doing, then its controls. */
export function AgentPill({
  controls,
  recording,
  readLevel,
  notice,
  noticeDetail,
  micUnavailableHint,
  micDisabled = false,
  expandCue = false,
  inModal = false,
  recordingStyle = "classic",
  recordingShowElapsed = false,
  recordingStartedAt = null,
  recordingVars,
  onAction,
  className,
}: AgentPillProps) {
  const { t } = useTranslation();
  const dragHandlers = useAgentWindowDrag();
  const hasStatus = Boolean(notice || controls.waiting || controls.thinking || controls.waveform);
  const look = resolveAgentPillRecordingLook({
    style: recordingStyle,
    showElapsed: recordingShowElapsed,
    recording: recording && controls.waveform && !notice && !controls.waiting && !controls.thinking,
  });
  const elapsedLabel = useElapsedLabel(recordingStartedAt, look.showTime);
  // REC puts the time before the waveform, the other styles after it.
  const elapsed = look.showTime && (
    <span
      className={cn(
        "agent-pill-elapsed shrink-0 text-center text-[12px] font-semibold leading-none tabular-nums",
        look.recDot ? "me-1.5" : "ms-1.5"
      )}
      style={{ width: VOICE_PILL_ELAPSED_SLOT }}
    >
      {elapsedLabel}
    </span>
  );
  return (
    <div
      className={cn(
        "agent-pill flex h-10 max-w-full cursor-grab items-center rounded-full border border-border pe-1.25 select-none active:cursor-grabbing text-muted-foreground shadow-[var(--shadow-card)]",
        hasStatus ? "ps-2.5" : "ps-1.25",
        inModal ? "bg-surface-1 dark:bg-surface-2" : "agent-panel bg-surface-0",
        className
      )}
      style={look.chromeStyle || look.showTime ? recordingVars : undefined}
      data-recording-style={look.chromeStyle ?? undefined}
      {...dragHandlers}
    >
      {notice ? (
        <span
          className="ms-2.5 max-w-30 truncate text-xs text-foreground/80"
          title={noticeDetail ? `${notice}\n${noticeDetail}` : notice}
        >
          {notice}
        </span>
      ) : controls.waiting ? (
        // Truncates where a translation outgrows the window.
        <span
          className="ms-2.5 min-w-0 truncate text-sm text-foreground/80 select-none"
          title={t("agentWindow.waitingForAnswer")}
        >
          {t("agentWindow.waitingForAnswer")}
        </span>
      ) : controls.thinking ? (
        <span className="agent-shimmer-text ms-3.5 me-2 min-w-0 truncate text-sm select-none">
          {t("agentMode.input.thinking")}
        </span>
      ) : controls.waveform ? (
        <>
          {look.recDot && (
            <span
              aria-hidden="true"
              className="agent-pill-rec-dot me-1.5 shrink-0 rounded-full"
              style={{ width: VOICE_PILL_REC_DOT, height: VOICE_PILL_REC_DOT }}
            />
          )}
          {look.recDot && elapsed}
          <PillWaveform
            getLevel={readLevel}
            active={recording}
            className={cn(
              "agent-pill-waveform h-6 shrink-0",
              look.chromeStyle ? "text-inherit" : "text-foreground"
            )}
          />
          {!look.recDot && elapsed}
        </>
      ) : null}
      {hasStatus && !controls.thinking && (
        <span className="mx-3 h-3.5 w-px shrink-0 bg-border" aria-hidden="true" />
      )}
      <div className="flex items-center gap-0.5">
        {controls.buttons.map((button) => {
          const { icon: Icon, label } = BUTTONS[button];
          const unavailable = button === "mic" ? micUnavailableHint : undefined;
          return (
            <button
              key={button}
              type="button"
              onClick={() => onAction(button)}
              disabled={button === "mic" && (micDisabled || Boolean(unavailable))}
              aria-label={t(label)}
              title={unavailable ?? t(label)}
              className={cn(ICON_BUTTON, button === "expand" && expandCue && "agent-expand-cue")}
            >
              <Icon size={button === "stop" ? 14 : 16} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

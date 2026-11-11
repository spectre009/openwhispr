import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import "./index.css";
import { useToast } from "./components/ui/useToast";
import { useHotkey } from "./hooks/useHotkey";
import { formatHotkeyListLabel } from "./utils/hotkeys";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useLinuxPillInteractivity } from "./hooks/useLinuxPillInteractivity";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useOnboardingAssistantDemo } from "./hooks/useOnboardingAssistantDemo";
import { useLiveTranscriptPanel } from "./hooks/useLiveTranscriptPanel";
import { useMainWindowSizeOwner } from "./hooks/useMainWindowSizeOwner";
import { useMainProcessNotifications } from "./hooks/useMainProcessNotifications";
import { useListeningEntrancePhase } from "./hooks/useListeningEntrancePhase";
import { useNothingHeardPill } from "./hooks/useNothingHeardPill";
import { useDictationStartVisuals } from "./hooks/useDictationStartVisuals";
import { useWindowResizeCompensation } from "./hooks/useWindowResizeCompensation";
import { useRecordingIndicator } from "./hooks/useRecordingIndicator";
import { useSettingsStore } from "./stores/settingsStore";
import { isAgentAllowed } from "./stores/policyRules";
import { usePolicyStore } from "./stores/policyStore";
import { useTranscriptionContextAllowed } from "./hooks/usePolicy";
import { meetingStartRefusalKey } from "./helpers/trayActionPolicy";
import { VoicePill } from "./components/dictation/VoicePill";
import { StyleBadge } from "./components/dictation/StyleBadge";
import { LiveTranscriptPanel } from "./components/dictation/LiveTranscriptPanel";
import { VoiceModePanelCore } from "./components/dictation/VoiceModePanelCore";
import { PillTooltip } from "./components/dictation/PillTooltip";
import { PillCommandMenu } from "./components/dictation/PillCommandMenu";
import { LiquidCancelButton } from "./components/dictation/LiquidCancelButton";
import { createMainWindowResizeCoordinator } from "./utils/mainWindowResizeCoordinator";
import {
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  resolveLiveTranscriptEntrancePresentation,
  resolveListeningEntrancePresentation,
  resolveVoiceActivityPresentation,
  resolveVoiceHorizontalDirection,
  resolveVoicePillDock,
  resolveVoicePillInteraction,
  resolvePillFootprint,
  resolveRecordingLayout,
  isVoicePillActivationKey,
  shouldActivateVoicePill,
  shouldOfferLiveTranscriptReopen,
} from "./helpers/voicePillPresentation";
import { panelDocksAtTop, parsePanelPosition } from "./helpers/floatingIconPlacement";

const formatPillHotkeyLabel = (value) =>
  formatHotkeyListLabel(value)
    .replace(/\s*\+\s*/g, " + ")
    .replace(/\s+/g, " ")
    .trim();

const UNMOUNTED_RESIZE = {
  success: false,
  superseded: true,
  message: "Resize coordinator not mounted",
};

export default function App() {
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const buttonRef = useRef(null);
  const pillPresenceRef = useRef(null);
  const { toast, dismiss, toastCount, dictationErrorActionCount, dismissByPresentation } =
    useToast();
  const { t } = useTranslation();
  const { hotkey } = useHotkey();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();

  const [dragStartPos, setDragStartPos] = useState(null);
  const [hasDragged, setHasDragged] = useState(false);

  // Floating icon auto-hide setting (read from store, synced via IPC)
  const floatingIconAutoHide = useSettingsStore((s) => s.floatingIconAutoHide);
  const recordingIndicatorColor = useSettingsStore((s) => s.recordingIndicatorColor);
  const recordingEdgeStrip = useSettingsStore((s) => s.recordingEdgeStrip);
  const recordingEdgeStripDisplays = useSettingsStore((s) => s.recordingEdgeStripDisplays);
  const recordingTrayIndicator = useSettingsStore((s) => s.recordingTrayIndicator);
  const recordingColorByMode = useSettingsStore((s) => s.recordingColorByMode);
  const recordingAssistantColor = useSettingsStore((s) => s.recordingAssistantColor);
  const recordingTranslationColor = useSettingsStore((s) => s.recordingTranslationColor);
  const recordingReminderMinutes = useSettingsStore((s) => s.recordingReminderMinutes);
  const [reminderPulseKey, setReminderPulseKey] = useState(0);
  const panelStartPosition = useSettingsStore((s) => s.panelStartPosition);
  const floatingIconDisplay = useSettingsStore((s) => s.floatingIconDisplay);
  const floatingIconDisplayLabel = useSettingsStore((s) => s.floatingIconDisplayLabel);
  const prevAutoHideRef = useRef(floatingIconAutoHide);
  // Settings → "Show me" holds auto-hide off for the preview's duration.
  const [placementPreviewActive, setPlacementPreviewActive] = useState(false);
  const [voiceHorizontalDirection, setVoiceHorizontalDirection] = useState(() =>
    resolveVoiceHorizontalDirection(panelStartPosition)
  );
  const [mainWindowHorizontalDirection, setMainWindowHorizontalDirection] = useState(null);

  // Main boots the window from .env, which can lag the settings this window
  // read from localStorage; report them once so the two always agree. Main
  // ignores an unchanged value.
  useEffect(() => {
    window.electronAPI?.notifyPanelStartPositionChanged?.(panelStartPosition);
    window.electronAPI?.notifyFloatingIconDisplayChanged?.(
      floatingIconDisplay,
      floatingIconDisplayLabel
    );
    // Startup only: later changes are reported by the settings store's setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Main draws the edge strip and the tray dot, and runs the reminder clock.
  // Settings changes reach this window as storage events, which update the
  // store without calling its setters, so only an effect over the values
  // themselves sees them.
  useEffect(() => {
    window.electronAPI?.notifyRecordingIndicatorChanged?.({
      color: recordingIndicatorColor,
      strip: recordingEdgeStrip,
      displays: recordingEdgeStripDisplays,
      tray: recordingTrayIndicator,
      colorByMode: recordingColorByMode,
      assistantColor: recordingAssistantColor,
      translationColor: recordingTranslationColor,
      reminderMinutes: recordingReminderMinutes,
    });
  }, [
    recordingIndicatorColor,
    recordingEdgeStrip,
    recordingEdgeStripDisplays,
    recordingTrayIndicator,
    recordingColorByMode,
    recordingAssistantColor,
    recordingTranslationColor,
    recordingReminderMinutes,
  ]);

  // Main sends a reminder only to the pill that shows the recording.
  useEffect(
    () => window.electronAPI?.onRecordingReminder?.(() => setReminderPulseKey((key) => key + 1)),
    []
  );

  useEffect(() => {
    let timer;
    const unsubscribe = window.electronAPI?.onFloatingIconPlacementPreview?.((payload) => {
      clearTimeout(timer);
      setPlacementPreviewActive(true);
      timer = setTimeout(() => setPlacementPreviewActive(false), payload?.durationMs ?? 2000);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, []);

  const setWindowInteractivity = React.useCallback((shouldCapture) => {
    // Linux has one pointer-poll owner; native mouseleave must not undo its
    // drag/menu capture or strand the next hover in click-through mode.
    if (window.electronAPI?.getPlatform?.() === "linux") return;
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);
  const dismissDictationError = React.useCallback(
    () => dismissByPresentation("dictation-error"),
    [dismissByPresentation]
  );

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    let disposed = false;
    const applyDirection = (direction) => {
      if (!disposed && (direction === "left" || direction === "right")) {
        setMainWindowHorizontalDirection(direction);
      }
    };
    const unsubscribe =
      window.electronAPI?.onMainWindowHorizontalDirectionChanged?.(applyDirection);
    const initialDirection = window.electronAPI?.getMainWindowHorizontalDirection?.();
    initialDirection?.then(applyDirection).catch(() => {});
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useWindowResizeCompensation();
  useMainProcessNotifications({ toast, dismiss, t });

  const agentAllowed = usePolicyStore(isAgentAllowed);
  const meetingAllowed = useTranscriptionContextAllowed("meeting");

  const mainWindowResizeCoordinatorRef = useRef(null);
  useEffect(() => {
    // Created in the effect, not lazily during render: React StrictMode's
    // dev-only setup→cleanup→setup cycle then disposes and recreates it
    // instead of disposing the only instance for the rest of the session.
    const coordinator = createMainWindowResizeCoordinator({
      resizeMainWindow: (sizeKey) => window.electronAPI?.resizeMainWindow?.(sizeKey),
      resizeAssistantWindowToContent: (height) =>
        window.electronAPI?.resizeAssistantWindowToContent?.(height),
    });
    mainWindowResizeCoordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      if (mainWindowResizeCoordinatorRef.current === coordinator) {
        mainWindowResizeCoordinatorRef.current = null;
      }
    };
  }, []);

  const requestMainWindowSize = React.useCallback(
    (sizeKey) =>
      mainWindowResizeCoordinatorRef.current?.resizeMainWindow(sizeKey) ??
      Promise.resolve(UNMOUNTED_RESIZE),
    []
  );
  const resizeLiveTranscriptToContent = React.useCallback(
    (height) =>
      mainWindowResizeCoordinatorRef.current?.resizeAssistantWindowToContent(height) ??
      Promise.resolve(UNMOUNTED_RESIZE),
    []
  );

  const onPanelOpened = React.useCallback(() => setIsHovered(false), []);

  // The live transcript needs recording state as effect deps, and recording
  // needs it for errors and transcripts. This ref breaks the render-order
  // cycle; it is read only at event time, never during render.
  const liveTranscriptApiRef = useRef(null);

  // Demo sessions only exist while onboarding is incomplete — skip the IPC otherwise.
  const publishOnboardingDemoEvent = useCallback((event) => {
    if (localStorage.getItem("onboardingCompleted") === "true") return;
    window.electronAPI?.publishOnboardingDemoEvent?.(event);
  }, []);
  const runOnboardingAssistantDemo = useOnboardingAssistantDemo(
    useCallback(
      (event) => publishOnboardingDemoEvent({ ...event, kind: "assistant" }),
      [publishOnboardingDemoEvent]
    )
  );

  const handleDictationError = React.useCallback(() => {
    liveTranscriptApiRef.current?.dismissForError();
  }, []);

  const handleDictationToggle = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    if (!liveTranscriptApiRef.current?.openRef.current) {
      setWindowInteractivity(false);
    }
  }, [setWindowInteractivity]);

  const recording = useAudioRecording(toast, {
    onToggle: handleDictationToggle,
    onDemoEvent: publishOnboardingDemoEvent,
    onOnboardingAssistantCommand: runOnboardingAssistantDemo,
    dismissDictationError,
    onDictationError: handleDictationError,
    onShowTranscript: (text) => liveTranscriptApiRef.current?.showFinalText(text),
  });
  const {
    isRecording,
    isProcessing,
    isAssistantVoice,
    isPreparing,
    isStopping,
    micCaptureStatus,
    toggleListening,
    cancelRecording,
    cancelProcessing,
    getAudioLevel,
    recordingInputKind,
    recordingStartedAt,
    dictationStyle,
    slowProcessingHint,
    nothingHeardSeq,
  } = recording;
  const isVisuallyProcessing = isProcessing || isPreparing || isStopping;
  // With "Color by mode" on, the pill takes the color of the recording's mode.
  const { recordingStyle, recordingShowElapsed, recordingVars } =
    useRecordingIndicator(recordingInputKind);

  const liveTranscript = useLiveTranscriptPanel({
    resizeToContent: resizeLiveTranscriptToContent,
    onWillOpen: onPanelOpened,
    isRecording,
    isProcessing,
    isAssistantVoice,
  });

  useLayoutEffect(() => {
    liveTranscriptApiRef.current = liveTranscript;
  });

  // Must run before the size owner's ladder effect below: the error teardown
  // drops the live transcript's open ref, which the ladder reads this commit.
  useEffect(() => {
    if (dictationErrorActionCount > 0) handleDictationError();
  }, [dictationErrorActionCount, handleDictationError]);

  // Direction is part of the interaction's geometry, not a live decoration.
  // Hold the origin through processing and panel exit so every close animation
  // returns to the same side from which that voice session started.
  const voiceDirectionLocked = isRecording || isVisuallyProcessing || liveTranscript.mounted;
  useLayoutEffect(() => {
    if (voiceDirectionLocked) return;
    setVoiceHorizontalDirection(
      mainWindowHorizontalDirection ?? resolveVoiceHorizontalDirection(panelStartPosition)
    );
  }, [mainWindowHorizontalDirection, panelStartPosition, voiceDirectionLocked]);

  const voiceActivity = resolveVoiceActivityPresentation({
    isRecording,
    // Mic warm-up is an acknowledged press, not work on a transcript. Keeping
    // isPreparing out of the thinking state leaves the press on the pulsing
    // "processing" mic-state pill instead of lighting the glow at hotkey time.
    isProcessing: isProcessing || isStopping,
    isAssistantVoice,
  });
  const listeningEntrancePhase = useListeningEntrancePhase(isRecording);
  // "Dictation start visuals": the pill's first painted frame and its settled entrance.
  useDictationStartVisuals(listeningEntrancePhase);
  const listeningEntrance = resolveListeningEntrancePresentation({
    isRecording,
    phase: listeningEntrancePhase,
  });
  const isCompactPill = isRecording ? listeningEntrance.compactPill : voiceActivity.compactPill;
  // BASE and RECORDING resolve to the same native box (windowConfig.js), so
  // recording edges never call setBounds — resizing the transparent window
  // always kicks a compositor frame. This flag still feeds the size ladder so
  // a menu opening over the compact pill resolves to EXPANDED geometry.
  const windowFitsCompactPill = isRecording || voiceActivity.compactPill;

  const { dictationErrorPillHandoffActive, panelReturnResizeActive } = useMainWindowSizeOwner({
    requestMainWindowSize,
    dictationErrorActionCount,
    toastCount,
    isCommandMenuOpen,
    isCompactPill: windowFitsCompactPill,
    isDictationActive: isRecording || isVisuallyProcessing,
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptMounted: liveTranscript.mounted,
    liveTranscriptOpenRef: liveTranscript.openRef,
  });

  // "Hide floating icon when idle" would hide the window now, but for a
  // dictation in progress.
  const autoHideWhenIdle =
    floatingIconAutoHide &&
    !placementPreviewActive &&
    toastCount === 0 &&
    !dictationErrorPillHandoffActive &&
    !liveTranscript.mounted;
  // A short empty dictation's quiet end: the red spin-down, cut short by the
  // next dictation. Inside the Live Transcript panel the pill just returns to idle.
  const nothingHeardPhase = useNothingHeardPill({
    seq: nothingHeardSeq,
    interrupted: isRecording || isVisuallyProcessing,
    autoHide: autoHideWhenIdle,
  });
  const pillNothingHeard = nothingHeardPhase !== null && !liveTranscript.mounted;

  useEffect(() => {
    if (isCommandMenuOpen || toastCount > 0 || liveTranscript.mounted) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [isCommandMenuOpen, isHovered, toastCount, liveTranscript.mounted, setWindowInteractivity]);

  useEffect(() => {
    if (isRecording && dictationErrorActionCount > 0) {
      dismissByPresentation("dictation-error");
    }
  }, [isRecording, dictationErrorActionCount, dismissByPresentation]);

  // Sync auto-hide from main process — setState directly to avoid IPC echo
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onFloatingIconAutoHideChanged?.((enabled) => {
      localStorage.setItem("floatingIconAutoHide", String(enabled));
      useSettingsStore.setState({ floatingIconAutoHide: enabled });
    });
    return () => unsubscribe?.();
  }, []);

  const isRecordingRef = useRef(isRecording);

  useLayoutEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCancelHotkeyPressed?.(() => {
      if (isRecordingRef.current) cancelRecording();
    });
    return () => unsubscribe?.();
  }, [cancelRecording]);

  // The Agent companion pill's cancel button routes here: only this renderer
  // owns the recording, so it decides what "cancel" means at arrival time.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCancelDictation?.(() => {
      if (isRecording || isPreparing) cancelRecording();
      else if (isProcessing) cancelProcessing();
    });
    return () => unsubscribe?.();
  }, [isRecording, isPreparing, isProcessing, cancelRecording, cancelProcessing]);

  // Every tray refusal surfaces the pill first, so the message is visible even
  // when the pill was hidden. useTrayQuickActions decides when one is needed.
  const refuse = useCallback(
    (messageKey) => {
      void window.electronAPI?.showDictationPanel?.();
      toast({ title: t(messageKey), variant: "default" });
    },
    [toast, t]
  );

  // "Review last dictation" pressed while a dictation is still being made or
  // pasted: main leaves it alone and the pill says why nothing opened.
  useEffect(
    () => window.electronAPI?.onReviewDictationBusy?.(() => refuse("historyView.review.busy")),
    [refuse]
  );

  // The meeting hotkey and tray item start in main, which refuses under policy.
  useEffect(
    () =>
      window.electronAPI?.onMeetingStartRefused?.((code) => refuse(meetingStartRefusalKey(code))),
    [refuse]
  );

  // Auto-hide the floating icon when idle (setting enabled or dictation cycle completed)
  useEffect(() => {
    let hideTimeout;

    if (autoHideWhenIdle && !isRecording && !isVisuallyProcessing) {
      // A quiet empty dictation's spin-down plays out first; the pill has
      // faded with it, so the window then hides at once. Otherwise wait
      // briefly so processing can start after recording stops without a flash.
      if (nothingHeardPhase !== "playing") {
        hideTimeout = setTimeout(
          () => {
            window.electronAPI?.hideWindow?.();
          },
          nothingHeardPhase === "faded" ? 0 : 500
        );
      }
    } else if (!floatingIconAutoHide && prevAutoHideRef.current) {
      window.electronAPI?.showDictationPanel?.();
    }

    prevAutoHideRef.current = floatingIconAutoHide;
    return () => clearTimeout(hideTimeout);
  }, [
    isRecording,
    isVisuallyProcessing,
    floatingIconAutoHide,
    autoHideWhenIdle,
    nothingHeardPhase,
  ]);

  const handleClose = () => {
    window.electronAPI.hideWindow();
  };

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
        } else if (isRecording) {
          cancelRecording();
        } else if (isPreparing) {
          cancelRecording();
        } else if (isProcessing) {
          cancelProcessing();
        } else {
          handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [
    isCommandMenuOpen,
    isRecording,
    isPreparing,
    isProcessing,
    cancelRecording,
    cancelProcessing,
  ]);

  // Determine current mic state
  const getMicState = () => {
    if (isRecording && (micCaptureStatus === "reconnecting" || micCaptureStatus === "unavailable"))
      return "unavailable";
    if (isRecording) return "recording";
    if (isVisuallyProcessing) return "processing";
    if (pillNothingHeard) return "nothing-heard";
    if (isHovered && !isRecording && !isVisuallyProcessing) return "hover";
    return "idle";
  };

  const micState = getMicState();

  const getMicTooltip = () => {
    switch (micState) {
      case "recording":
        return t("app.mic.recording");
      case "unavailable":
        return t("app.mic.waitingForMicrophone");
      case "processing":
        return t("app.mic.processing");
      default:
        return formatPillHotkeyLabel(hotkey);
    }
  };

  const micTooltip = getMicTooltip();
  // The style badge follows the pill's own recording and processing.
  const pillHasLiveActivity = isRecording || isProcessing || isStopping;
  // Processing has run long and Esc now cancels it: said on the pill itself,
  // not only on hover.
  const slowProcessingNotice =
    slowProcessingHint && micState === "processing" ? t("app.mic.slowProcessing") : null;
  const panelOpen = liveTranscript.open;
  const panelMounted = liveTranscript.mounted;
  const canReopenLiveTranscript =
    shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: liveTranscript.manuallyCollapsed,
      isRecording,
      isProcessing,
      isAssistantVoice,
    }) && !panelMounted;
  const voicePillInteraction = resolveVoicePillInteraction({
    liveTranscriptMounted: liveTranscript.mounted,
    isRecording,
    isProcessing,
    isHovered,
  });
  const pillIsInteractive = voicePillInteraction.pillInteractive;
  // The cancel button pours out of the pill as a fused liquid skin — except
  // inside the Live Transcript panel, where the pill is already headless and
  // the classic bordered circle stays (with the same emergence motion).
  const [cancelSkinActive, setCancelSkinActive] = useState(false);
  const cancelFused = !liveTranscript.open;
  // isCompactPill tracks the pill's footprint through the entrance phases
  // (logo-collapsed thinking renders 40×40 even while recording). These are
  // targets, not rendered sizes: the pill transitions between footprints over
  // GROW_TRANSITION, and the skin tweens its geometry to match
  // (usePillFootprintTween in LiquidCancelButton). The footprint itself comes
  // from resolvePillFootprint once the pill's state is known, below.
  const activateVoicePill = () => {
    if (!pillIsInteractive) return;
    if (canReopenLiveTranscript) {
      liveTranscript.reopen();
      return;
    }
    if (
      shouldActivateVoicePill({
        hasDragged,
        liveTranscriptMounted: liveTranscript.mounted,
        isProcessing: micState === "processing",
        isAgentThinking: voiceActivity.isAgentThinking,
      })
    ) {
      setIsCommandMenuOpen(false);
      toggleListening();
    }
  };
  const liveTranscriptEntrance = resolveLiveTranscriptEntrancePresentation(
    liveTranscript.entrancePhase
  );
  const commonPillState =
    micState === "unavailable"
      ? "unavailable"
      : listeningEntrance.activeState || voiceActivity.activeState || micState;
  const recordingLayout = resolveRecordingLayout({
    style: recordingStyle,
    showElapsed: recordingShowElapsed,
    recording: commonPillState === "recording",
    inPanel: panelOpen,
  });
  const cancelPillFootprint = resolvePillFootprint({
    compact: isCompactPill,
    layout: recordingLayout,
  });
  const voicePillDock = resolveVoicePillDock({
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptEntrancePhase: liveTranscript.entrancePhase,
    panelStartPosition,
    horizontalDirection: voiceHorizontalDirection,
  });
  const voicePillPopoverAlign =
    parsePanelPosition(panelStartPosition).horizontal === "center"
      ? "center"
      : voiceHorizontalDirection;
  const voicePillPopoverSide = panelDocksAtTop(panelStartPosition) ? "below" : "above";
  const voicePillTravelDuration =
    liveTranscript.open && liveTranscript.entrancePhase === "encapsulate"
      ? LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs
      : LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs;
  const dictationErrorSuppressesPill =
    dictationErrorActionCount > 0 || dictationErrorPillHandoffActive;
  // The pill hides while a dictation error owns the window and through the
  // masked shrink back from the Live Transcript panel.
  const pillVisuallySuppressed = dictationErrorSuppressesPill || panelReturnResizeActive;

  useLinuxPillInteractivity({
    pillRef: pillPresenceRef,
    captureWindow: isCommandMenuOpen || toastCount > 0 || panelMounted || isDragging,
    pillInteractive: pillIsInteractive && !pillVisuallySuppressed,
  });

  return (
    <div className="dictation-window">
      <div
        className={`voice-pill-position voice-pill-position-${voicePillDock} fixed z-50 transition-opacity duration-150 ease-out ${
          pillVisuallySuppressed ? "pointer-events-none" : ""
        } ${pillVisuallySuppressed ? "opacity-0" : "opacity-100"}`}
        style={{
          ...recordingVars,
          "--voice-pill-travel-duration": `${voicePillTravelDuration}ms`,
        }}
        data-dictation-error-suppressed={dictationErrorSuppressesPill || undefined}
        aria-hidden={pillVisuallySuppressed || undefined}
      >
        <div
          ref={pillPresenceRef}
          className="relative flex items-center"
          data-horizontal-direction={voiceHorizontalDirection}
          onMouseEnter={() => {
            if (!pillIsInteractive) return;
            setIsHovered(true);
            setWindowInteractivity(true);
          }}
          onMouseLeave={() => {
            setIsHovered(false);
            if (!pillIsInteractive) return;
            if (!isCommandMenuOpen) {
              setWindowInteractivity(false);
            }
          }}
        >
          <PillTooltip
            content={canReopenLiveTranscript ? t("transcriptionPreview.label") : micTooltip}
            notice={slowProcessingNotice}
            disabled={panelMounted}
            align={voicePillPopoverAlign}
            side={voicePillPopoverSide}
          >
            <VoicePill
              ref={buttonRef}
              variant={panelOpen ? "panel" : "floating"}
              state={commonPillState}
              expanded={!panelOpen && isCompactPill}
              collapseToLogo={listeningEntrance.collapseToLogo}
              waveformVisible={listeningEntrance.waveformVisible}
              waveformOnlyWhileRecording={panelMounted}
              integratedWithPanel={liveTranscript.open}
              liquidFused={cancelSkinActive}
              showExpandChevron={canReopenLiveTranscript && isHovered}
              getAudioLevel={getAudioLevel}
              isDragging={isDragging}
              horizontalDirection={voiceHorizontalDirection}
              recordingStyle={recordingStyle}
              recordingLayout={recordingLayout}
              recordingStartedAt={recordingStartedAt}
              reminderPulseKey={reminderPulseKey}
              nothingHeardExit={autoHideWhenIdle ? "fade" : "settle"}
              role={pillIsInteractive ? "button" : "status"}
              tabIndex={pillIsInteractive ? 0 : undefined}
              aria-label={
                canReopenLiveTranscript || liveTranscript.mounted
                  ? t("transcriptionPreview.label")
                  : micTooltip
              }
              onMouseDown={(e) => {
                if (panelMounted) {
                  setHasDragged(false);
                  return;
                }
                setIsCommandMenuOpen(false);
                setDragStartPos({ x: e.clientX, y: e.clientY });
                setHasDragged(false);
                handleMouseDown(e);
              }}
              onMouseMove={(e) => {
                if (panelMounted) return;
                if (dragStartPos && !hasDragged) {
                  const distance = Math.sqrt(
                    Math.pow(e.clientX - dragStartPos.x, 2) +
                      Math.pow(e.clientY - dragStartPos.y, 2)
                  );
                  if (distance > 5) {
                    // 5px threshold for drag
                    setHasDragged(true);
                  }
                }
              }}
              onMouseUp={(e) => {
                if (panelMounted) return;
                handleMouseUp(e);
                setDragStartPos(null);
              }}
              onClick={(e) => {
                activateVoicePill();
                e.preventDefault();
              }}
              onKeyDown={(event) => {
                if (event.repeat || !isVoicePillActivationKey(event.key)) return;
                event.preventDefault();
                activateVoicePill();
              }}
              onContextMenu={(e) => {
                if (panelMounted) return;
                e.preventDefault();
                if (!hasDragged) {
                  setWindowInteractivity(true);
                  setIsCommandMenuOpen((prev) => !prev);
                }
              }}
            />
          </PillTooltip>
          {dictationStyle && pillHasLiveActivity && !panelOpen && !slowProcessingNotice && (
            <StyleBadge
              style={dictationStyle}
              side={voicePillPopoverSide}
              align={voicePillPopoverAlign}
            />
          )}
          <LiquidCancelButton
            visible={voicePillInteraction.cancelVisible}
            fused={cancelFused}
            pillWidth={cancelPillFootprint.width}
            pillHeight={cancelPillFootprint.height}
            pillState={commonPillState}
            recordingStyle={recordingStyle}
            ariaLabel={
              isRecording ? t("app.buttons.cancelRecording") : t("app.buttons.cancelProcessing")
            }
            onCancel={() => {
              if (isRecording) cancelRecording();
              else cancelProcessing();
            }}
            onFusedSkinChange={setCancelSkinActive}
          />
          {!panelMounted && isCommandMenuOpen && (
            <PillCommandMenu
              buttonRef={buttonRef}
              align={voicePillPopoverAlign}
              side={voicePillPopoverSide}
              isRecording={isRecording}
              agentAllowed={agentAllowed}
              meetingAllowed={meetingAllowed}
              isHovered={isHovered}
              setWindowInteractivity={setWindowInteractivity}
              onToggleListening={() => {
                toggleListening();
              }}
              onAskAssistant={() => {
                setIsCommandMenuOpen(false);
                void window.electronAPI?.openAgentWindow?.();
              }}
              onStartMeeting={() => {
                setIsCommandMenuOpen(false);
                // Main refuses under policy before the start reaches the
                // engine, so it never sends meeting-start-refused for this.
                void window.electronAPI?.startManualMeeting?.().then((result) => {
                  if (
                    result?.code === "POLICY_MEETING_RECORDING_DISABLED" ||
                    result?.code === "POLICY_UNRESOLVABLE"
                  ) {
                    refuse(meetingStartRefusalKey(result.code));
                  }
                });
              }}
              onHide={() => {
                setIsCommandMenuOpen(false);
                setWindowInteractivity(false);
                handleClose();
              }}
              onClose={() => setIsCommandMenuOpen(false)}
            />
          )}
        </div>
      </div>

      <VoiceModePanelCore
        mode={panelOpen || panelMounted ? "live-transcript" : null}
        open={panelOpen}
        stage={liveTranscriptEntrance.coreStage}
        horizontalDirection={voiceHorizontalDirection}
        label={t("transcriptionPreview.label")}
        measurementRevision={liveTranscript.measurementText}
        onPreferredHeightChange={liveTranscript.requestHeight}
      >
        <LiveTranscriptPanel
          text={liveTranscript.mounted ? liveTranscript.text : ""}
          measurementText={liveTranscript.mounted ? liveTranscript.measurementText : ""}
          phase={liveTranscript.phase}
          processing={liveTranscript.mounted && isProcessing && !isAssistantVoice}
          controlsVisible={liveTranscript.mounted && liveTranscriptEntrance.controlsVisible}
          contentVisible={liveTranscript.mounted && liveTranscriptEntrance.contentVisible}
          onCollapse={() => liveTranscript.close({ suppress: true })}
          onHoldChange={liveTranscript.holdFinal}
        />
      </VoiceModePanelCore>
    </div>
  );
}

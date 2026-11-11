import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { playStartCue, playStopCue, releaseCueOutput, warmCueOutput } from "../utils/dictationCues";
import { getSettings } from "../stores/settingsStore";
import { expandSnippets } from "../utils/snippets";
import { getRecordingErrorTitle, getRecordingErrorDescription } from "../utils/recordingErrors";
import { openInHistoryAction, providerErrorActions } from "../utils/describeProviderError";
import { cleanupFailureReason } from "../utils/cleanupFailureCard";
import { isProviderSettingsTarget } from "../helpers/providerHttpErrors.js";
import { isAccessibilitySkipped } from "../utils/permissions";
import { needsSttConfigBeforeStart } from "../helpers/sttConfigPolicy";
import { recordPastedText } from "../helpers/postTranscription";
import {
  isAgentAllowed,
  isScreenContextAllowed,
  isTranscriptionContextAllowed,
} from "../stores/policyRules";
import { isManagedTranscriptionActive } from "../services/managedTranscription";
import { usePolicyStore } from "../stores/policyStore";
import { getOnboardingDemoKind } from "../utils/onboardingDemo";
import {
  buildLiveTranscriptionPreview,
  shouldShowByokStreamingPreview,
} from "../utils/transcriptionPreview";
import { canStartDictation } from "../utils/dictationReadiness";
import { waitForVisualFrames } from "../utils/visualFrame";
import { startEventLoopStallMonitor } from "../helpers/eventLoopStallMonitor";
import {
  createStartTrace,
  joinStartTrace,
  logStartTrace,
  markStartTrace,
} from "../utils/dictationStartTrace";
import { resolveLifecycleInputKind } from "../helpers/dictationRouting";
import { createAssistantResponseDelivery } from "../helpers/assistantResponseDelivery";
import { recordCleanupFailure } from "../stores/cleanupFailureStore";
import { resolveStyleForRecording } from "../stores/styleStore";
import { traceStyle } from "../helpers/postTranscription";
import { createDictationCancelHotkey } from "../helpers/dictationCancelHotkey";

// Maps a failed selection-replacement code to its `selectionEditing.*` toast
// detail key; unlisted codes fall back to the generic "unavailable" message.
const SELECTION_EDIT_DETAIL_KEY_BY_CODE = {
  target_changed: "changed",
  selection_changed: "changed",
  session_expired: "expired",
  paste_failed: "pasteFailed",
  wl_copy_missing: "wlCopyMissing",
  wl_copy_failed: "wlCopyFailed",
};
// Pastes held back because Wayland apps can't read the text yet (#2621).
const WAYLAND_CLIPBOARD_REASON_KEYS = {
  "wl-copy-missing": "wlCopyMissing",
  "wl-copy-failed": "wlCopyFailed",
};
const COMPANION_AUDIO_LEVEL_INTERVAL_MS = 80;
const START_CUE_LOG_WAIT_MS = 2000;

// Pastes and saves of finished dictations still in flight. Main's lifecycle is
// idle by then, so it hears when the count leaves and returns to zero
// (dictation-delivery-state): the review hotkey waits for the dictation it
// would open. Main resets it if this renderer goes away.
function countDelivery(ref, delta) {
  const before = ref.current;
  ref.current = Math.max(0, before + delta);
  if (before === 0 && ref.current > 0) window.electronAPI?.dictationDeliveryStateChanged?.(true);
  else if (before > 0 && ref.current === 0) {
    window.electronAPI?.dictationDeliveryStateChanged?.(false);
  }
}

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  // The audio manager settles processing before the transcript is pasted; the
  // hook keeps the pill in processing until the paste attempt has settled (a
  // Linux paste can wait up to 1.5 s for held modifier keys). Main is never told:
  // it drops dictation hotkeys while processing, and the next dictation may start
  // while a paste is still waiting.
  const [isPasting, setIsPasting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isAssistantVoice, setIsAssistantVoice] = useState(false);
  // The running recording's mode and start (ms since epoch), for the pill's
  // per-mode color and elapsed time; null while not recording.
  const [recordingInputKind, setRecordingInputKind] = useState(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState(null);
  // The style the current recording carries ({ id, name, emoji }), frozen at
  // its start, for the pill badge while it records and is processed.
  const [recordingStyleBadge, setRecordingStyleBadge] = useState(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [micCaptureStatus, setMicCaptureStatus] = useState("inactive");
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  // Processing has run long and Esc now cancels it: the pill says so.
  const [slowProcessingHint, setSlowProcessingHint] = useState(false);
  // Bumped each time a short dictation comes back empty and ends quietly
  // (emptyDictation.js): the pill plays its spin-down, nothing else shows.
  const [nothingHeardSeq, setNothingHeardSeq] = useState(0);
  const audioManagerRef = useRef(null);
  // The one owner of the global Esc: while recording, and once processing has
  // run long (dictationCancelHotkey.js). Created once, never per render.
  const cancelHotkeyRef = useRef(null);
  if (cancelHotkeyRef.current === null) {
    cancelHotkeyRef.current = createDictationCancelHotkey({
      register: (purpose) =>
        window.electronAPI?.registerCancelHotkey?.("Escape", { purpose }) ?? { success: false },
      unregister: () => window.electronAPI?.unregisterCancelHotkey?.(),
      onHintChange: setSlowProcessingHint,
    });
  }
  // The failed recording the current error card's Retry re-sends, with that
  // card's generation; released when the card goes.
  const keptRecordingRef = useRef(null);
  const resendingRef = useRef(false);
  const startLockRef = useRef(false);
  const stopRequestedDuringStartRef = useRef(false);
  const pushForceStoppedRef = useRef(false);
  const stopLockRef = useRef(false);
  const preparationGenerationRef = useRef(0);
  const startTraceRef = useRef(null);
  const dictationErrorGenerationRef = useRef(0);
  // Bumped when a recording (or a re-send) starts: a card from an older
  // dictation that settles after it never replaces the newer one's.
  const dictationSeqRef = useRef(0);
  const wasRecordingRef = useRef(false);
  const pastesInFlightRef = useRef(0);
  const deliveriesInFlightRef = useRef(0);
  const cancellingRef = useRef(false);
  const wasMicUnavailableRef = useRef(false);
  const demoKindRef = useRef("dictation");
  const onDemoEventRef = useRef(options.onDemoEvent);
  const reportedLifecycleRef = useRef(null);
  const lastStartOptionsRef = useRef({
    voiceAgentRequested: false,
    translationRequested: false,
  });
  const {
    onToggle,
    onAssistantCommand,
    onOnboardingAssistantCommand,
    dismissDictationError,
    onDictationError,
    onQuietEmptyDictation,
    getAssistantSelectionContext,
    onShowTranscript,
    onDemoEvent,
    assistantOpenRef,
  } = options;

  useEffect(
    () => () => {
      dictationErrorGenerationRef.current += 1;
      keptRecordingRef.current = null;
      cancelHotkeyRef.current?.dispose();
    },
    []
  );

  useEffect(() => {
    onDemoEventRef.current = onDemoEvent;
  }, [onDemoEvent]);

  // Read through a ref so a re-render never tears down the AudioManager
  // (the mount effect below must not depend on this callback).
  const onAssistantCommandRef = useRef(onAssistantCommand);
  useEffect(() => {
    onAssistantCommandRef.current = onAssistantCommand;
  });
  const onOnboardingAssistantCommandRef = useRef(onOnboardingAssistantCommand);
  useEffect(() => {
    onOnboardingAssistantCommandRef.current = onOnboardingAssistantCommand;
  });
  const onShowTranscriptRef = useRef(onShowTranscript);
  useEffect(() => {
    onShowTranscriptRef.current = onShowTranscript;
  });
  const onQuietEmptyDictationRef = useRef(onQuietEmptyDictation);
  useEffect(() => {
    onQuietEmptyDictationRef.current = onQuietEmptyDictation;
  });
  const getAssistantSelectionContextRef = useRef(getAssistantSelectionContext);
  useEffect(() => {
    getAssistantSelectionContextRef.current = getAssistantSelectionContext;
  });

  // Reads only refs and the global electronAPI bridge, so a single stable
  // instance is safe to share between the mount effect (recording/processing
  // transitions) and performStartRecording (the toggle path's own "preparing"
  // report).
  const reportLifecycle = useCallback((state, inputKindOverride) => {
    const inputKind =
      inputKindOverride ??
      resolveLifecycleInputKind({
        voiceAgentRequested: audioManagerRef.current?.voiceAgentRequested,
        translationRequested: audioManagerRef.current?.translationRequested,
      });
    const signature = `${state}:${inputKind}`;
    if (reportedLifecycleRef.current === signature) return;
    reportedLifecycleRef.current = signature;
    // The audio manager sets its start (back-dated over adopted pre-roll)
    // before announcing the recording, so main's tray and reminders count
    // from the same moment as the pill.
    const startedAt =
      state === "recording" ? (audioManagerRef.current?.recordingStartTime ?? null) : null;
    window.electronAPI?.dictationLifecycleStateChanged?.(state, inputKind, startedAt);
  }, []);

  const performStartRecording = useCallback(
    async ({
      voiceAgentRequested = false,
      translationRequested = false,
      pressTrace,
      styleId,
    } = {}) => {
      if (startLockRef.current) return false;
      // A style is never carried over: Retry resolves the hotkey's style again.
      lastStartOptionsRef.current = { voiceAgentRequested, translationRequested };
      startLockRef.current = true;
      const trace = joinStartTrace(startTraceRef.current, pressTrace);
      startTraceRef.current = trace;
      markStartTrace(trace, "startReceived");
      stopRequestedDuringStartRef.current = false;
      pushForceStoppedRef.current = false;
      let recordingStarted = false;
      try {
        if (!audioManagerRef.current) return false;
        const policyState = usePolicyStore.getState();
        if (
          (!isManagedTranscriptionActive() &&
            !isTranscriptionContextAllowed(policyState, getSettings(), "dictation")) ||
          (voiceAgentRequested && !isAgentAllowed(policyState))
        ) {
          toast({ title: t("common.managedByOrg"), variant: "default" });
          return false;
        }

        if (!canStartDictation(audioManagerRef.current.getState())) return false;
        void warmCueOutput();

        const assistantSelectionContext = voiceAgentRequested
          ? (getAssistantSelectionContextRef.current?.() ?? null)
          : null;

        const preparationGeneration = ++preparationGenerationRef.current;
        setIsStopping(false);
        setIsPreparing(true);
        // Preserve the requested identity while Windows is still opening the
        // microphone; AudioManager confirms the same value once recording.
        setIsAssistantVoice(voiceAgentRequested);
        await waitForVisualFrames();
        markStartTrace(trace, "startFramesDone");
        if (preparationGeneration !== preparationGenerationRef.current) return false;

        // Start acquisition only after the compact thinking frame has reached
        // the compositor. startRecording() joins this prepared capture, so the
        // device still opens exactly once.
        void audioManagerRef.current.prepareMicCapture?.({ trace });

        // The floating dictation panel only takes focus while the assistant panel
        // is open, so the foreground app is otherwise still the user's actual
        // editing target here. Refresh it for recordings
        // started from the panel itself as well as from global hotkeys; otherwise
        // paste can reactivate a stale target from the preceding dictation.
        let targetFrozen = false;
        try {
          await window.electronAPI.captureDictationTarget?.();
          targetFrozen = true;
        } catch (error) {
          logger.warn("Failed to refresh dictation target", { error: error?.message });
        }
        markStartTrace(trace, "targetCaptured");

        demoKindRef.current = getOnboardingDemoKind(voiceAgentRequested);
        audioManagerRef.current.setVoiceAgentRequested(voiceAgentRequested);
        audioManagerRef.current.setAssistantSelectionContext(assistantSelectionContext);
        audioManagerRef.current.setTranslationRequested(translationRequested);
        // The recording's style, read from the style record now and frozen
        // for the whole recording: the requested one (a style key) or the
        // dictation hotkey's. Assistant and translation recordings never get one.
        let recordingStyle = null;
        if (!voiceAgentRequested && !translationRequested) {
          try {
            recordingStyle = resolveStyleForRecording(styleId);
          } catch (error) {
            logger.warn("Couldn't read the dictation styles", { error: error?.message });
          }
        }
        audioManagerRef.current.setRecordingStyle?.(recordingStyle);
        setRecordingStyleBadge(
          recordingStyle
            ? { id: recordingStyle.id, name: recordingStyle.name, emoji: recordingStyle.emoji }
            : null
        );
        // Main froze this recording's target app in captureDictationTarget above
        // (Hold and Tap both arrive here); fetch it without holding the start.
        // Without a fresh freeze the app stays unknown rather than a stale one.
        if (targetFrozen) audioManagerRef.current.beginRecordingTargetCapture?.();
        // Step history: main captures who owns this dictation's steps now.
        audioManagerRef.current.beginStepHistoryRun?.();
        // Starts the Copilot runtime while the user speaks when this
        // dictation's cleanup or translation runs on it. Never awaited.
        audioManagerRef.current.beginCopilotPrewarm?.({
          voiceAgentRequested,
          translationRequested,
          style: recordingStyle,
        });
        // Covers the toggle path with freshly-set flags; the signature dedup
        // makes this a no-op when the prepare handler already reported the
        // same kind ahead of the flags being set.
        reportLifecycle("preparing");
        if (voiceAgentRequested) {
          logger.info(
            "Voice agent recording start",
            { screenContextEnabled: !!getSettings().voiceAgentScreenContext },
            "reasoning"
          );
        }
        // getSettings() already reflects a managed policy that forces the
        // setting off; the predicate additionally fails closed while the
        // policy is still loading or errored.
        if (
          voiceAgentRequested &&
          getSettings().voiceAgentScreenContext &&
          isScreenContextAllowed(policyState)
        ) {
          audioManagerRef.current.beginScreenContextCapture();
        }

        // The selection to edit is whatever was highlighted at press time, so
        // read it now: it resolves while the user speaks instead of adding a
        // round trip after transcription.
        if (voiceAgentRequested && !assistantSelectionContext) {
          audioManagerRef.current.beginSelectionCapture();
        }

        // Tone & Style names the app being dictated into while the user speaks,
        // for cleanup and for an assistant answer typed or edited in place there.
        // A styled recording is its own intent: its style, not the app's tone,
        // decides how it reads, so it captures none.
        if (getSettings().toneStyleEnabled && !translationRequested && !recordingStyle) {
          audioManagerRef.current.beginToneStyleCapture();
        }

        // Retry STT config fetch if it wasn't loaded on mount (e.g. auth wasn't ready),
        // and refresh a copy older than its TTL so a server-side rollout change
        // reaches a long-running app. Await it only when it can change the start
        // decision (no config yet, signed-in OpenWhispr-cloud streaming); for
        // local STT or a signed-out session the fetch stalls on auth resolution
        // and would delay the mic open (#1673). A stale-but-present copy is
        // refreshed in the background and this recording keeps the old decision.
        if (audioManagerRef.current.isSttConfigStale()) {
          const hadConfig = Boolean(audioManagerRef.current.sttConfig);
          const configFetch = (async () => {
            const config = await window.electronAPI.getSttConfig?.();
            if (config?.success) {
              audioManagerRef.current.setSttConfig(config);
            }
          })().catch((error) => {
            logger.warn("STT config fetch failed", { error: error?.message });
          });
          if (!hadConfig && needsSttConfigBeforeStart(getSettings())) {
            await configFetch;
          }
        }

        audioManagerRef.current.lastStartInfo = null;
        audioManagerRef.current.startTrace = trace;
        const didStart = audioManagerRef.current.shouldUseStreaming()
          ? await audioManagerRef.current.startStreamingRecording()
          : await audioManagerRef.current.startRecording();
        recordingStarted = didStart;
        if (didStart) {
          markStartTrace(trace, "recordingStarted");
          trace.details = { ...trace.details, ...audioManagerRef.current.lastStartInfo };
          dictationSeqRef.current += 1;
          dictationErrorGenerationRef.current += 1;
          keptRecordingRef.current = null;
          dismissDictationError?.();
        }

        // A stop that landed while the start was still awaiting the mic open was
        // dropped (isRecording was still false), leaving a runaway recording
        // until the next hotkey press. Honor it now that we started.
        if (didStart && stopRequestedDuringStartRef.current) {
          logStartTrace(trace, "stopped-during-start");
          cancelHotkeyRef.current.setPhase("idle");
          // Cue semantics mirror performStopRecording: unconditional for
          // streaming, gated on the stop landing for batch.
          if (audioManagerRef.current.getState().isStreaming) {
            void playStopCue();
            await audioManagerRef.current.stopStreamingRecording();
          } else if (audioManagerRef.current.stopRecording()) {
            void playStopCue();
          }
          return didStart;
        }

        // A quick tap can end the recording inside the start call itself (deferred
        // streaming stop) — don't pause media for a recording that already ended. See #1060.
        if (didStart && audioManagerRef.current.getState().isRecording) {
          if (getSettings().pauseMediaOnDictation) {
            window.electronAPI?.pauseMediaPlayback?.();
          }
          cancelHotkeyRef.current.setPhase("recording");
          // Bounded: a wedged output device can leave the cue's resume pending,
          // and the start must still be logged.
          void Promise.race([
            playStartCue(),
            new Promise((resolve) =>
              setTimeout(() => resolve({ played: false, reason: "pending" }), START_CUE_LOG_WAIT_MS)
            ),
          ]).then((cue) => {
            if (cue?.played) markStartTrace(trace, "cueScheduled");
            trace.details = {
              ...trace.details,
              cuePlayed: cue?.played,
              cuePriorState: cue?.priorState ?? cue?.reason,
              cueReadyMs: cue?.readyMs,
              cueOutputLatencyMs: cue?.outputLatencyMs,
              cueWasWarm: cue?.wasWarm,
              cueWarmedForMs: cue?.warmedForMs,
              cueDelayedMs: cue?.delayedMs,
            };
            logStartTrace(trace, "started");
          });
        } else if (didStart) {
          logStartTrace(trace, "stopped-during-start");
        }

        return didStart;
      } finally {
        startLockRef.current = false;
        if (!recordingStarted) {
          logStartTrace(
            trace,
            stopRequestedDuringStartRef.current ? "stopped-during-start" : "not-started"
          );
        }
        // A stop that landed mid-start set isStopping expecting the started
        // recording's state change to clear it; if the recording never began,
        // no state change will ever arrive.
        if (stopRequestedDuringStartRef.current && !recordingStarted) setIsStopping(false);
        stopRequestedDuringStartRef.current = false;
        if (!recordingStarted) {
          releaseCueOutput();
          setIsPreparing(false);
          setIsAssistantVoice(false);
          setRecordingStyleBadge(null);
          // Covers every exit above that never started a recording — the
          // policy-block early return, the mic-open failure, a stale
          // preparation generation, etc. Without this, a failed start leaves
          // the main process (and the companion pill) stuck reporting
          // "preparing" forever, since startRecording's failure path only
          // fires onError, never the onStateChange that normally reports
          // "idle". The signature dedup makes this a no-op when
          // onStateChange already reported it first.
          if (reportedLifecycleRef.current?.startsWith("preparing:")) reportLifecycle("idle");
        }
      }
    },
    [t, toast, dismissDictationError, reportLifecycle]
  );

  const performStopRecording = useCallback(async () => {
    if (startLockRef.current) {
      stopRequestedDuringStartRef.current = true;
      setIsPreparing(false);
      setIsStopping(true);
      return true;
    }
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (!currentState.isRecording && !currentState.isStreamingStartInProgress) return false;

      cancelHotkeyRef.current.setPhase("idle");
      setIsPreparing(false);
      setIsStopping(true);
      // Contract to the stable thinking state before MediaRecorder/streaming
      // finalization can occupy the renderer on slower Windows machines.
      await waitForVisualFrames();

      if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
        void playStopCue();
        return await audioManagerRef.current.stopStreamingRecording();
      }

      const didStop = audioManagerRef.current.stopRecording();

      if (didStop) {
        void playStopCue();
      }

      return didStop;
    } finally {
      stopLockRef.current = false;
      setIsStopping(false);
    }
  }, []);

  useEffect(() => {
    audioManagerRef.current = new AudioManager();
    // rAF waits and IPC replies on the start path queue behind this thread.
    const stopStallMonitor = startEventLoopStallMonitor({ logger, label: "renderer" });

    // Resolve and pin the input device now, not on the first hotkey press, which
    // would otherwise wait on the device lookup before the mic can open.
    void audioManagerRef.current.cacheMicrophoneDeviceId?.();

    // Keep this at mount: it opens the recording spool, which a hung main process would block.
    void audioManagerRef.current.recoverInterruptedRecordings?.(
      t("hooks.audioRecording.interruptedRecordingRecovered")
    );

    // Reset stale main-process state after a renderer reload or crash recovery.
    reportLifecycle("idle");

    const getRecoverableTranscript = (fallback = "") =>
      buildLiveTranscriptionPreview(
        audioManagerRef.current?.streamingFinalText,
        audioManagerRef.current?.streamingPartialText
      ).trim() || fallback.trim();

    // `onRetry` replaces the default Retry (a new recording) for a pill whose
    // transcript is already kept and only needs delivering again. A
    // `keptRecording` (failedRecordingRetry.js) makes Retry re-send that
    // recording; it belongs to this card and is released when the card goes.
    // A failure card stays until it is dismissed or the next dictation starts
    // (`transient`: a short notice instead, for "no audio"). `historyRowId`
    // resolves the dictation's saved row (Open in History), and a
    // `cleanupFailure` of the same dictation rides on its paste-failure card:
    // the pill shows one card at a time, and both failures stay visible.
    const showDictationError = ({
      title,
      description,
      transcript = "",
      code,
      settingsLaunchFailed = false,
      onRetry,
      keptRecording,
      settingsTarget,
      technicalDetails,
      historyRowId = null,
      cleanupFailure = null,
      transient = false,
    }) => {
      const errorGeneration = ++dictationErrorGenerationRef.current;
      const isCurrent = () => errorGeneration === dictationErrorGenerationRef.current;
      keptRecordingRef.current = keptRecording
        ? { generation: errorGeneration, recording: keptRecording }
        : null;
      const releaseKeptRecording = () => {
        if (keptRecordingRef.current?.generation === errorGeneration) {
          keptRecordingRef.current = null;
        }
      };
      const recoverAssistant = Boolean(audioManagerRef.current?.voiceAgentRequested);
      onDictationError?.({ recoverAssistant });
      const cleanupLine = cleanupFailure
        ? t("app.toasts.cleanupFailed.alsoFailed", {
            reason: cleanupFailureReason(cleanupFailure, t),
          })
        : "";
      const openInHistory = historyRowId ? openInHistoryAction(historyRowId, t, isCurrent) : null;
      if (code === "ACCESSIBILITY_PERMISSION_REQUIRED") {
        let settingsOpening = false;
        const actions = [
          {
            label: t("hooks.audioRecording.pastePermission.openSettings"),
            icon: "settings",
            dismissOnClick: false,
            onClick: async () => {
              if (settingsOpening || !isCurrent()) return;
              settingsOpening = true;
              let opened = false;
              try {
                const result = await window.electronAPI?.openAccessibilitySettings?.();
                opened = result?.success === true;
              } catch {
                // Keep the manual path available if System Settings cannot open.
              } finally {
                settingsOpening = false;
              }
              // A recording that is starting owns the pill; re-showing the card now would
              // dismiss that recording's live transcript.
              if (!opened && isCurrent() && !startLockRef.current) {
                showDictationError({
                  title,
                  description,
                  transcript,
                  code,
                  settingsLaunchFailed: true,
                  historyRowId,
                  cleanupFailure,
                });
              }
            },
          },
        ];
        if (openInHistory) actions.push(openInHistory);
        if (transcript.trim()) {
          actions.push({
            label: t("hooks.audioRecording.pastePermission.copyToClipboard"),
            icon: "copy",
            dismissOnClick: false,
            feedback: {
              successLabel: t("common.copied"),
              failureLabel: t("hooks.audioRecording.pastePermission.copyFailed"),
            },
            onClick: async () => {
              if (!isCurrent()) return;
              let copied = false;
              try {
                const result = await window.electronAPI?.writeClipboard?.(transcript);
                copied = result?.success === true;
              } catch {
                copied = false;
              }
              if (isCurrent()) return copied;
            },
          });
        }
        toast({
          title,
          description: [
            [
              settingsLaunchFailed
                ? t("hooks.audioRecording.pastePermission.settingsFailed")
                : description,
              transcript.trim()
                ? t("hooks.audioRecording.pastePermission.manualPaste", { shortcut: "Cmd+V" })
                : "",
            ]
              .filter(Boolean)
              .join(" "),
            cleanupLine,
          ]
            .filter(Boolean)
            .join("\n"),
          descriptionHotkey: transcript.trim() ? "Cmd+V" : undefined,
          variant: "destructive",
          presentation: "dictation-error",
          duration: 0,
          dismissible: true,
          onClose: () => {
            if (isCurrent()) dictationErrorGenerationRef.current += 1;
          },
          actions,
        });
        return;
      }
      const recoverableTranscript = getRecoverableTranscript(transcript);
      // A retried paste can wait on held keys with no visible progress, so a
      // second click is ignored until it settles, and a paste that lands after
      // a newer pill or recording leaves that one alone. A re-send dismisses
      // its own card when it starts, so it never dismisses one here.
      const retryAction =
        onRetry ?? (keptRecording ? () => resendKeptRecording(errorGeneration) : null);
      let retrying = false;
      const retry = async () => {
        if (retrying || !isCurrent()) return;
        retrying = true;
        try {
          if ((await retryAction()) && isCurrent()) dismissDictationError?.();
        } finally {
          retrying = false;
        }
      };
      const actions = [
        {
          label: t("common.retry"),
          icon: "retry",
          dismissOnClick: false,
          onClick: retryAction ? retry : () => performStartRecording(lastStartOptionsRef.current),
        },
      ];

      actions.push(...providerErrorActions({ settingsTarget, technicalDetails }, t, isCurrent));
      // The cleanup failure's own fix, when this card's error has none.
      if (cleanupFailure && !isProviderSettingsTarget(settingsTarget)) {
        actions.push(
          ...providerErrorActions({ settingsTarget: cleanupFailure.settingsTarget }, t, isCurrent)
        );
      }
      if (openInHistory) actions.push(openInHistory);

      if (recoverableTranscript) {
        actions.push({
          label: t("hooks.audioRecording.errorActions.viewTranscript"),
          icon: "transcript",
          onClick: () => {
            onShowTranscriptRef.current?.(recoverableTranscript);
          },
        });
      }

      toast({
        title,
        description: [description, cleanupLine].filter(Boolean).join("\n"),
        variant: "destructive",
        presentation: "dictation-error",
        ...(transient
          ? {}
          : {
              duration: 0,
              dismissible: true,
              onClose: () => {
                if (isCurrent()) dictationErrorGenerationRef.current += 1;
              },
            }),
        actions,
        ...(keptRecording ? { onRemoved: releaseKeptRecording } : {}),
      });
    };

    // The card's Retry for a kept recording: one at a time, and only while
    // that card is current and nothing else holds the pipeline. The re-send
    // owns the recording from here; its card goes so the pill shows the
    // processing, which the pill's cancel and Esc cancel like any other.
    const resendKeptRecording = async (generation) => {
      const kept = keptRecordingRef.current;
      const manager = audioManagerRef.current;
      if (!kept || kept.generation !== generation) return false;
      if (generation !== dictationErrorGenerationRef.current) return false;
      if (resendingRef.current || startLockRef.current || !manager) return false;
      if (!canStartDictation(manager.getState())) return false;
      if (
        !isManagedTranscriptionActive() &&
        !isTranscriptionContextAllowed(usePolicyStore.getState(), getSettings(), "dictation")
      ) {
        toast({ title: t("common.managedByOrg"), variant: "default" });
        return false;
      }
      keptRecordingRef.current = null;
      resendingRef.current = true;
      dictationSeqRef.current += 1;
      dictationErrorGenerationRef.current += 1;
      dismissDictationError?.();
      // The keys that force-stopped the original are long released.
      pushForceStoppedRef.current = false;
      const style = kept.recording.style;
      setRecordingStyleBadge(style ? { id: style.id, name: style.name, emoji: style.emoji } : null);
      try {
        await manager.resendFailedRecording(kept.recording);
      } catch (error) {
        logger.warn("Couldn't re-send the failed dictation", { error: error?.message }, "audio");
      } finally {
        resendingRef.current = false;
      }
      return false;
    };

    // Every failure the audio manager reports, and a paste of this window's
    // dictation that failed: a card that stays until dismissed or the next
    // dictation starts. `historyRowId` (the failed row, or the dictation's own)
    // gives it Open in History; a paste failure carries its dictation's
    // cleanup failure along (`cleanupFailure`).
    const handleError = (error) => {
      setIsPreparing(false);
      setIsStopping(false);
      if (error?.code === "TRANSCRIPTION_CANCELLED" || error?.code === "REASON_CANCELLED") return;
      onDemoEventRef.current?.({
        kind: demoKindRef.current,
        status: "error",
        message: error?.message,
      });
      if (error?.title !== "Paste Error") {
        window.electronAPI?.hideDictationPreview?.();
      }
      const title = getRecordingErrorTitle(error, t);
      const description = getRecordingErrorDescription(error, t);
      if (error?.variant === "default") {
        // Informational outcomes (SCREEN_CONTEXT_SKIPPED after a successful
        // text-only retry) are notices, not failures: no card, no Retry.
        toast({ title, description, variant: "default" });
      } else {
        showDictationError({
          title,
          description,
          code: error?.code,
          transcript: error?.transcript,
          keptRecording: error?.keptRecording,
          settingsTarget: error?.settingsTarget,
          technicalDetails: error?.technicalDetails,
          historyRowId: error?.historyRowId ?? null,
          cleanupFailure: error?.cleanupFailure ?? null,
        });
      }
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
    };

    // A dictation that ended with no text, with how the audio manager says it
    // ends (emptyDictation.js): a short one ends quietly, with the pill's
    // spin-down and nothing else; a longer one (or one of unknown length)
    // says "We didn't catch that" for a moment.
    const endEmptyDictation = (emptyDictation) => {
      window.electronAPI?.hideDictationPreview?.();
      if (emptyDictation?.outcome === "quiet") {
        setNothingHeardSeq((seq) => seq + 1);
        onQuietEmptyDictationRef.current?.({
          recoverAssistant: Boolean(audioManagerRef.current?.voiceAgentRequested),
        });
        return;
      }
      showDictationError({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        transient: true,
      });
    };

    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming, micCaptureStatus }) => {
        reportLifecycle(isRecording ? "recording" : isProcessing ? "processing" : "idle");
        if (isRecording) {
          onDemoEventRef.current?.({ kind: demoKindRef.current, status: "listening" });
        } else if (isProcessing) {
          onDemoEventRef.current?.({ kind: demoKindRef.current, status: "processing" });
        }
        if (!isRecording) {
          // Esc stays global only once processing has run long.
          cancelHotkeyRef.current.setPhase(isProcessing ? "processing" : "idle");
          // Resume media the instant recording ends, not after transcription.
          if (wasRecordingRef.current && getSettings().pauseMediaOnDictation) {
            window.electronAPI?.resumeMediaPlayback?.();
          }
          if (wasRecordingRef.current) releaseCueOutput();
        }
        wasRecordingRef.current = isRecording;
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        if (isRecording) {
          setRecordingStartedAt(audioManagerRef.current?.recordingStartTime ?? Date.now());
          setRecordingInputKind(
            resolveLifecycleInputKind({
              voiceAgentRequested: audioManagerRef.current?.voiceAgentRequested,
              translationRequested: audioManagerRef.current?.translationRequested,
            })
          );
        } else {
          setRecordingStartedAt(null);
          setRecordingInputKind(null);
        }
        if (isRecording) setIsPreparing(false);
        if (!isRecording) setIsStopping(false);
        // The panel only mirrors assistant-routed recordings; a plain
        // dictation started while it is open must not masquerade as a
        // follow-up (its transcript takes the paste route, not the panel).
        setIsAssistantVoice(!!audioManagerRef.current?.voiceAgentRequested);
        if (micCaptureStatus) {
          setMicCaptureStatus(micCaptureStatus);
          const unavailable = micCaptureStatus === "unavailable";
          if (unavailable && !wasMicUnavailableRef.current) {
            wasMicUnavailableRef.current = true;
            toast({
              title: t("hooks.audioRecording.micDisconnected.title"),
              description: t("hooks.audioRecording.micDisconnected.description"),
              variant: "default",
            });
          } else if (micCaptureStatus === "active" && wasMicUnavailableRef.current) {
            wasMicUnavailableRef.current = false;
            toast({
              title: t("hooks.audioRecording.micRestored.title"),
              description: t("hooks.audioRecording.micRestored.description"),
              variant: "default",
            });
          } else if (micCaptureStatus === "inactive") {
            wasMicUnavailableRef.current = false;
          }
        }
        if (!isStreaming) {
          setPartialTranscript("");
        }
      },
      onError: handleError,
      onNoAudio: (emptyDictation) => {
        setIsPreparing(false);
        setIsStopping(false);
        onDemoEventRef.current?.({
          kind: demoKindRef.current,
          status: "error",
          message: t("hooks.audioRecording.noAudio.title"),
        });
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }
        endEmptyDictation(emptyDictation);
      },
      onPartialTranscript: (text) => {
        onDemoEventRef.current?.({ kind: demoKindRef.current, status: "partial", text });
        setPartialTranscript(text);
        const settings = getSettings();
        if (
          audioManagerRef.current?.getStreamingProviderName?.() !== "tinfoil-realtime" &&
          shouldShowByokStreamingPreview(
            settings.showTranscriptionPreview,
            settings.cloudTranscriptionMode,
            !!audioManagerRef.current?.voiceAgentRequested
          )
        ) {
          const previewText = buildLiveTranscriptionPreview(
            audioManagerRef.current?.streamingFinalText,
            text
          );
          window.electronAPI
            ?.updateDictationPreview?.(previewText)
            .catch((error) =>
              logger.warn("Failed to update transcription preview", { error: error?.message })
            );
        }
      },
      onTranscriptionComplete: async (result) => {
        if (result.success) {
          dictationErrorGenerationRef.current += 1;
          dismissDictationError?.();
          const transcribedText = result.text?.trim();

          if (!transcribedText) {
            endEmptyDictation(result.emptyDictation);
            return;
          }

          // This dictation's cards: none once a newer dictation started.
          const dictationSeq = dictationSeqRef.current;
          const isCurrentDictation = () => dictationSeq === dictationSeqRef.current;

          // A selection edit must replace the model's exact result. Snippet
          // expansion is a dictation convenience and can otherwise mutate a
          // legitimate replacement that happens to contain a snippet trigger.
          if (!result.selectionEdit?.sessionId) {
            result.text = expandSnippets(result.text, getSettings().snippets);
          }

          setTranscript(result.text);
          if (result.assistantConversation) {
            window.electronAPI?.hideDictationPreview?.();
            const {
              screenContext,
              transcript,
              selectedContext,
              deliverySessionId,
              deliveryAcceptsMarkdown,
              deliveryAppCategory,
            } = result.assistantConversation;
            const command = {
              text: expandSnippets(transcript, getSettings().snippets),
              attachment: screenContext
                ? { image: screenContext.data, mediaType: screenContext.mediaType }
                : null,
            };
            if (localStorage.getItem("onboardingCompleted") !== "true") {
              // The assistant panel would cover the onboarding flow, so a headless
              // responder answers and streams the reply back as demo events.
              onDemoEventRef.current?.({
                kind: demoKindRef.current,
                status: "processing",
                text: command.text,
              });
              onOnboardingAssistantCommandRef.current?.(command);
            } else {
              const { autoPasteEnabled, keepTranscriptionInClipboard } = getSettings();
              onAssistantCommandRef.current?.({
                ...command,
                selectedContext: selectedContext ?? null,
                delivery: createAssistantResponseDelivery({
                  autoPasteEnabled,
                  deliverySessionId,
                  acceptsMarkdown: deliveryAcceptsMarkdown,
                  appCategory: deliveryAppCategory,
                  restoreClipboard: !keepTranscriptionInClipboard,
                  allowClipboardFallback: isAccessibilitySkipped(),
                }),
              });
            }
          } else {
            onDemoEventRef.current?.({
              kind: demoKindRef.current,
              status: "success",
              text: result.text,
            });
            window.electronAPI?.completeDictationPreview?.({ text: result.text });
          }

          if (result.warning) {
            toast({
              title: t("hooks.audioRecording.partialTranscription.title"),
              description: t("hooks.audioRecording.partialTranscription.description"),
              variant: "default",
            });
          }

          const isStreaming = result.source?.includes("streaming");
          const { autoPasteEnabled, keepTranscriptionInClipboard } = getSettings();

          countDelivery(deliveriesInFlightRef, 1);
          // The History row this dictation is saved to (the save starts before
          // the paste): a card's Open in History waits on it, never "the newest".
          let resolveRowId;
          const rowId = new Promise((resolve) => {
            resolveRowId = resolve;
          });
          const persistencePromise = audioManagerRef.current
            .saveTranscription(result.text, result.rawText ?? result.text, {
              clientTranscriptionId: result.clientTranscriptionId,
              // Spread rather than set: a result with no analytics timestamp
              // must not gain the key as undefined, matching how audioManager
              // carries this field and keeping the options object exactly what
              // callers without Insights data expect.
              ...(result.analyticsOccurredAt
                ? { analyticsOccurredAt: result.analyticsOccurredAt }
                : {}),
              // The boundary's trace goes to main with the row (step history),
              // ending with what was pasted: snippets expanded above.
              ...(result.trace ? { trace: recordPastedText(result.trace, result.text) } : {}),
              // A re-sent failed dictation completes its failed History row.
              ...(Number.isInteger(result.replacesTranscriptionId)
                ? { replacesTranscriptionId: result.replacesTranscriptionId }
                : {}),
              onRowSaved: (id) => resolveRowId(Number.isInteger(id) ? id : null),
            })
            .then(
              (persisted) => {
                if (!persisted) {
                  logger.error(
                    "Failed to persist transcription",
                    {
                      clientTranscriptionId: result.clientTranscriptionId,
                      runId: result.trace?.runId ?? null,
                      source: result.source,
                    },
                    "audio"
                  );
                }
                return persisted;
              },
              (error) => {
                logger.error(
                  "Failed to persist transcription",
                  {
                    clientTranscriptionId: result.clientTranscriptionId,
                    runId: result.trace?.runId ?? null,
                    error: error?.message,
                    source: result.source,
                  },
                  "audio"
                );
                return false;
              }
            )
            .finally(() => {
              // A save that never named its row: Open in History has nothing to open.
              resolveRowId(null);
              countDelivery(deliveriesInFlightRef, -1);
            });

          // A paste of this dictation that fails shows its card with the
          // dictation's cleanup failure on it; otherwise the cleanup card
          // follows a paste that landed.
          const cleanupFailure = result.cleanupFailure ?? null;
          let pasteCardShown = false;
          const dictationCard = { historyRowId: rowId, cleanupFailure };
          const reportPasteFailure = (error) => {
            if (!isCurrentDictation()) {
              logger.info(
                "A failed paste stays off the pill behind a newer dictation",
                { code: error?.code ?? null },
                "clipboard"
              );
              return;
            }
            pasteCardShown = true;
            handleError({ ...error, ...dictationCard });
          };

          const keepInClipboard = async (delivery) => {
            try {
              const clipboardResult = await window.electronAPI.writeClipboard(result.text);
              if (clipboardResult?.success === false) {
                throw new Error("clipboard-write-failed");
              }
              return true;
            } catch (error) {
              logger.warn(
                "Failed to keep transcription in clipboard",
                {
                  delivery,
                  error: error?.message,
                  clientTranscriptionId: result.clientTranscriptionId,
                },
                "clipboard"
              );
              return false;
            }
          };

          const pasteOptions = {
            restoreClipboard: !keepTranscriptionInClipboard,
            allowClipboardFallback: isAccessibilitySkipped(),
          };

          const whilePasting = async (attempt) => {
            pastesInFlightRef.current += 1;
            countDelivery(deliveriesInFlightRef, 1);
            setIsPasting(true);
            try {
              return await attempt();
            } finally {
              pastesInFlightRef.current -= 1;
              countDelivery(deliveriesInFlightRef, -1);
              if (pastesInFlightRef.current === 0) setIsPasting(false);
            }
          };

          // A paste held back (keys still down, or no Wayland clipboard written) keeps
          // the transcript and says why it did not land. `onRetry`, when given, replaces the
          // pill's record-again Retry. `generation` is the pill
          // generation when the attempt began: if the next dictation started while
          // it waited, that recording owns the pill (and would dismiss this one at
          // once) and its live preview, so the transcript only stays on the clipboard.
          let heldBehindNewerDictation = false;
          const reportHeldBackPaste = async (
            delivery,
            { title, description, descriptionClipboardFailed, onRetry },
            generation = dictationErrorGenerationRef.current
          ) => {
            const keptInClipboard = await keepInClipboard(delivery);
            if (generation !== dictationErrorGenerationRef.current) {
              logger.info(
                "Held-back paste kept on the clipboard behind a newer dictation",
                { delivery, keptInClipboard },
                "clipboard"
              );
              heldBehindNewerDictation = true;
              return;
            }
            window.electronAPI?.hideDictationPreview?.();
            pasteCardShown = true;
            showDictationError({
              title,
              // Never promise a clipboard that rejected the write; the transcript
              // action on this pill is the recovery path either way.
              description: keptInClipboard ? description : descriptionClipboardFailed,
              transcript: result.rawText ?? result.text,
              onRetry,
              ...dictationCard,
            });
          };

          const pasteTranscript = async () => {
            const generation = dictationErrorGenerationRef.current;
            const pasteOutcome = await whilePasting(() =>
              audioManagerRef.current.safePaste(
                result.text,
                {
                  ...(isStreaming ? { fromStreaming: true } : {}),
                  ...pasteOptions,
                  // A styled paste isn't what was said, so main must not learn
                  // dictionary words from edits to it (decided per paste).
                  ...(traceStyle(result.trace) ? { suppressAutoLearn: true } : {}),
                },
                { report: reportPasteFailure }
              )
            );
            if (pasteOutcome.reason === "modifiers-held") {
              await reportHeldBackPaste(
                "modifiers-held",
                {
                  title: t("hooks.audioRecording.modifiersHeld.title"),
                  description: t("hooks.audioRecording.modifiersHeld.description"),
                  descriptionClipboardFailed: t(
                    "hooks.audioRecording.modifiersHeld.descriptionClipboardFailed"
                  ),
                  // The modifier wait runs again, so the kept text is safe to re-paste.
                  onRetry: pasteTranscript,
                },
                generation
              );
            } else if (WAYLAND_CLIPBOARD_REASON_KEYS[pasteOutcome.reason]) {
              // Wayland apps may not read the clipboard copy here either, so the text
              // never claims to be on it. Retry writes and pastes the kept text again.
              const description = t(
                `hooks.audioRecording.waylandClipboard.${WAYLAND_CLIPBOARD_REASON_KEYS[pasteOutcome.reason]}`
              );
              await reportHeldBackPaste(
                pasteOutcome.reason,
                {
                  title: t("hooks.audioRecording.waylandClipboard.title"),
                  description,
                  descriptionClipboardFailed: description,
                  onRetry: pasteTranscript,
                },
                generation
              );
            }
            return pasteOutcome.pasted;
          };

          // Whether this dictation's text reached the cursor (the cleanup card's wording).
          let cleanupTextPasted = false;
          if (pushForceStoppedRef.current && autoPasteEnabled && !result.assistantConversation) {
            // The push hit its safety ceiling while the trigger keys were still
            // down. Injecting the paste shortcut into those held modifiers is
            // what silently loses the transcript, so keep it instead. Only macOS
            // and Windows force-stop, and neither waits for held modifiers, so
            // Retry records again rather than pasting.
            await reportHeldBackPaste("push-force-stopped", {
              title: t("hooks.audioRecording.pushForceStopped.title"),
              description: t("hooks.audioRecording.pushForceStopped.description"),
              descriptionClipboardFailed: t(
                "hooks.audioRecording.pushForceStopped.descriptionClipboardFailed"
              ),
            });
          } else if (autoPasteEnabled && !result.assistantConversation) {
            const pasteStart = performance.now();
            let pasteSucceeded = true;
            if (result.selectionEdit?.sessionId) {
              const generation = dictationErrorGenerationRef.current;
              const replacement = await whilePasting(() =>
                window.electronAPI?.replaceSelectedText?.(
                  result.selectionEdit.sessionId,
                  result.text,
                  pasteOptions
                )
              );
              pasteSucceeded = replacement?.success === true;
              if (replacement?.code === "modifiers_held") {
                await reportHeldBackPaste(
                  "selection-edit-modifiers-held",
                  {
                    title: t("hooks.audioRecording.selectionEditing.notAppliedTitle"),
                    description: t("hooks.audioRecording.selectionEditing.modifiersHeld"),
                    descriptionClipboardFailed: t(
                      "hooks.audioRecording.selectionEditing.modifiersHeldClipboardFailed"
                    ),
                    onRetry: pasteTranscript,
                  },
                  generation
                );
              } else if (!pasteSucceeded) {
                window.electronAPI?.hideDictationPreview?.();
                if (keepTranscriptionInClipboard) {
                  await keepInClipboard("selection-edit-fallback");
                }
                const detailKey =
                  SELECTION_EDIT_DETAIL_KEY_BY_CODE[replacement?.code] || "unavailable";
                pasteCardShown = true;
                showDictationError({
                  title: t("hooks.audioRecording.selectionEditing.notAppliedTitle"),
                  description: t(`hooks.audioRecording.selectionEditing.${detailKey}`),
                  transcript: result.rawText ?? result.text,
                  ...dictationCard,
                });
              }
            } else {
              pasteSucceeded = await pasteTranscript();
            }
            logger.info(
              "Paste timing",
              {
                pasteMs: Math.round(performance.now() - pasteStart),
                source: result.source,
                textLength: result.text.length,
                selectionEdit: !!result.selectionEdit,
                success: pasteSucceeded,
                clientTranscriptionId: result.clientTranscriptionId ?? null,
                runId: result.trace?.runId ?? null,
              },
              "streaming"
            );
            // The text has landed at the cursor; a preview lingering with the
            // final transcript after the paste reads as a stray surface. A
            // failed paste keeps the final flash so the transcript stays
            // visible somewhere.
            if (pasteSucceeded) {
              window.electronAPI?.hideDictationPreview?.();
            }
            cleanupTextPasted = pasteSucceeded;
          } else if (keepTranscriptionInClipboard && !result.assistantConversation) {
            await keepInClipboard("clipboard-only");
          }

          // The cleanup card, for a delivery that showed no card of its own: a
          // paste that landed, or no paste at all (auto-paste off). Cleanup can
          // be missing or can fail whether or not the paste landed (#2631,
          // #1003), so the card is told which. A paste card of this dictation
          // already carries it, and a newer dictation's pill is never covered by
          // this one's card (nor by a paste held back behind it). The onboarding
          // demo's paste is a no-op into its own text box, so it reports nothing
          // there. An unconfigured-cleanup warning is used up only once a card
          // showed it, so a dictation that showed none leaves it for the next.
          if (cleanupFailure && !heldBehindNewerDictation) {
            const cleanupCardShown =
              !pasteCardShown &&
              isCurrentDictation() &&
              localStorage.getItem("onboardingCompleted") === "true";
            if (cleanupCardShown) {
              recordCleanupFailure({
                ...cleanupFailure,
                pasted: cleanupTextPasted,
                dictation: { isCurrent: isCurrentDictation, rowId, pasted: cleanupTextPasted },
              });
            }
            if (cleanupCardShown || pasteCardShown) {
              audioManagerRef.current?.markCleanupNoticeShown?.(cleanupFailure);
            }
          }

          if (result.source === "openai" && getSettings().useLocalWhisper) {
            toast({
              title: t("hooks.audioRecording.fallback.title"),
              description: t("hooks.audioRecording.fallback.description"),
              variant: "default",
            });
          }

          // Cloud usage: limit reached after this transcription
          if (result.source === "openwhispr" && result.limitReached) {
            // Notify control panel to show UpgradePrompt dialog
            window.electronAPI?.notifyLimitReached?.({
              wordsUsed: result.wordsUsed,
              limit:
                result.wordsRemaining !== undefined
                  ? result.wordsUsed + result.wordsRemaining
                  : 2000,
            });
          }

          if (audioManagerRef.current.shouldUseStreaming()) {
            audioManagerRef.current.warmupStreamingConnection();
          }

          await persistencePromise;
        }
      },
      onTranslationFallback: ({ reason }) => {
        // Fail-open: the raw text was still pasted; the toast removes the silence.
        toast({
          title:
            reason === "unreachable"
              ? t("hooks.audioRecording.translationFallback.unreachableTitle")
              : t("hooks.audioRecording.translationFallback.failedTitle"),
          description:
            reason === "unreachable"
              ? t("hooks.audioRecording.translationFallback.unreachableDescription")
              : t("hooks.audioRecording.translationFallback.failedDescription"),
          variant: "destructive",
        });
      },
      onStyleFallback: ({ reason, style }) => {
        // The text was still pasted (cleaned, or as transcribed); say the style didn't apply.
        const name = style?.name || t("styles.plain.name");
        toast({
          title: t("hooks.audioRecording.styleFallback.title", { name }),
          description:
            reason === "unreachable"
              ? t("hooks.audioRecording.styleFallback.unreachableDescription")
              : t("hooks.audioRecording.styleFallback.failedDescription"),
          variant: "destructive",
        });
      },
    });

    // Keep overlay content protection in sync with the screen-context setting
    // so the dictation pill stays out of captures (survives window recreation).
    window.electronAPI.setScreenContextEnabled?.(getSettings().voiceAgentScreenContext);
    // A policy refresh can flip the effective screen-context value mid-session;
    // re-sync overlay content protection when it does.
    const unsubscribePolicy = usePolicyStore.subscribe(() => {
      window.electronAPI.setScreenContextEnabled?.(getSettings().voiceAgentScreenContext);
    });
    window.electronAPI.getSttConfig?.().then((config) => {
      if (config?.success && audioManagerRef.current) {
        audioManagerRef.current.setSttConfig(config);
        if (audioManagerRef.current.shouldUseStreaming()) {
          audioManagerRef.current.warmupStreamingConnection();
        }
      }
    });

    const handleToggle = async ({
      voiceAgentRequested = false,
      translationRequested = false,
      styleId,
      pressTrace,
    } = {}) => {
      if (!audioManagerRef.current) return;
      const currentState = audioManagerRef.current.getState();

      // A start still awaiting the mic open leaves isRecording false, so without
      // the lock check this toggle-off would take the start branch and be lost.
      // A stop press never changes the running recording's style.
      if (startLockRef.current || currentState.isRecording) {
        await performStopRecording();
      } else if (canStartDictation(currentState)) {
        // Main stamps a start press like a hold's, so its trace joins the prepare's.
        await performStartRecording({
          voiceAgentRequested,
          translationRequested,
          styleId,
          pressTrace,
        });
      }
    };

    const handleStart = async (payload) => {
      await performStartRecording({ pressTrace: payload?.trace, styleId: payload?.styleId });
    };

    const handleStop = async () => {
      await performStopRecording();
    };

    const disposeToggle = window.electronAPI.onToggleDictation((payload) => {
      handleToggle({ styleId: payload?.styleId, pressTrace: payload?.trace });
      onToggle?.();
    });

    const disposeVoiceAgentToggle = window.electronAPI.onToggleVoiceAgent?.((payload) => {
      handleToggle({ voiceAgentRequested: true, pressTrace: payload?.trace });
      onToggle?.();
    });

    const disposeTranslationToggle = window.electronAPI.onToggleTranslation?.((payload) => {
      handleToggle({ translationRequested: true, pressTrace: payload?.trace });
      onToggle?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.((payload) => {
      handleStart(payload);
      onToggle?.();
    });

    const disposePrepare = window.electronAPI.onPrepareDictation?.(async (options) => {
      if (!audioManagerRef.current || startLockRef.current) return;
      if (!canStartDictation(audioManagerRef.current.getState())) return;
      void warmCueOutput();
      const trace = createStartTrace(options?.trace);
      startTraceRef.current = trace;
      markStartTrace(trace, "prepareReceived");
      const generation = ++preparationGenerationRef.current;
      setIsAssistantVoice(false);
      setIsPreparing(true);
      // The prepare event precedes the flag-setting start, so the kind must come
      // from the payload — the audioManager flags still describe the PREVIOUS
      // recording at this point.
      reportLifecycle("preparing", options?.inputKind);
      await waitForVisualFrames();
      markStartTrace(trace, "prepareFramesDone");
      if (generation !== preparationGenerationRef.current || startLockRef.current) return;
      void audioManagerRef.current.prepareMicCapture?.({ trace });
    });

    const disposeCancelPreparation = window.electronAPI.onCancelDictationPreparation?.(() => {
      preparationGenerationRef.current += 1;
      setIsPreparing(false);
      audioManagerRef.current?.cancelPreparedMicCapture?.();
      releaseCueOutput();
      if (reportedLifecycleRef.current?.startsWith("preparing:")) reportLifecycle("idle");
    });

    const disposeStop = window.electronAPI.onStopDictation?.(() => {
      handleStop();
      onToggle?.();
    });

    const disposeForceStopped = window.electronAPI.onDictationForceStopped?.((payload) => {
      // Listed rather than negated: a future renderer-initiated stop would not
      // leave the keys down, and must not be swept in here.
      if (payload?.reason === "timeout" || payload?.reason === "reset") {
        pushForceStoppedRef.current = true;
      }
    });

    // Esc held for a long-running dictation's processing: cancels it, as the
    // pill's cancel does. Ignored unless this window still holds Esc for that,
    // so a press that crossed a newer dictation leaves it alone.
    const disposeCancelProcessing = window.electronAPI.onCancelProcessingHotkeyPressed?.(() => {
      if (!cancelHotkeyRef.current.holdsProcessing) return;
      setRecordingStyleBadge(null);
      audioManagerRef.current?.cancelProcessing();
    });

    // Cleanup
    return () => {
      reportLifecycle("idle");
      unsubscribePolicy();
      disposeToggle?.();
      disposeVoiceAgentToggle?.();
      disposeTranslationToggle?.();
      disposeStart?.();
      disposePrepare?.();
      disposeCancelPreparation?.();
      disposeStop?.();
      disposeForceStopped?.();
      disposeCancelProcessing?.();
      stopStallMonitor();
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, [
    toast,
    onToggle,
    performStartRecording,
    performStopRecording,
    dismissDictationError,
    onDictationError,
    reportLifecycle,
    t,
  ]);

  const cancelRecording = useCallback(async () => {
    if (audioManagerRef.current) {
      preparationGenerationRef.current += 1;
      setIsPreparing(false);
      setIsStopping(false);
      // A cancelled recording's style ends with it; the next start resolves its own.
      setRecordingStyleBadge(null);
      audioManagerRef.current.cancelPreparedMicCapture?.();
      cancelHotkeyRef.current.setPhase("idle");
      releaseCueOutput();
      const state = audioManagerRef.current.getState();
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      // A streaming start in its mic-open phase is not yet `isStreaming`;
      // only the streaming cancel knows how to abandon it.
      if (state.isStreaming || state.isStreamingStartInProgress) {
        // The streaming cancel reports processing while it tears the stream
        // down; flagged first so the follow-up thinking effect doesn't read
        // that as a command. A ref, so clearing it can't re-run that effect
        // while a pending paste still reports processing.
        cancellingRef.current = true;
        try {
          return await audioManagerRef.current.cancelStreamingRecording();
        } finally {
          cancellingRef.current = false;
        }
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  }, []);

  const cancelProcessing = useCallback(() => {
    if (audioManagerRef.current) {
      setRecordingStyleBadge(null);
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  }, []);

  const getAudioLevel = useCallback(
    () => audioManagerRef.current?.getRecordingAudioLevel() ?? null,
    []
  );

  useEffect(() => {
    if (!isRecording) return undefined;

    const reportAudioLevel = () => {
      const level = getAudioLevel();
      if (level === null) return;
      // The onboarding demo's pill draws its waveform from these levels.
      onDemoEventRef.current?.({ kind: demoKindRef.current, status: "level", level });
      // The companion pill only exists while the Agent panel is open — with
      // the panel closed there is nobody to mirror levels to, so skip the
      // IPC. Checked per tick, not once: the panel can open mid-recording and
      // a ref change never re-runs this effect.
      if (!isAssistantVoice && assistantOpenRef?.current) {
        window.electronAPI?.dictationAudioLevelChanged?.(level);
      }
    };
    reportAudioLevel();
    const interval = setInterval(reportAudioLevel, COMPANION_AUDIO_LEVEL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [assistantOpenRef, getAudioLevel, isAssistantVoice, isRecording]);

  const toggleListening = async ({
    voiceAgentRequested = false,
    translationRequested = false,
  } = {}) => {
    if (!isRecording && !isProcessing && !isPasting) {
      await performStartRecording({ voiceAgentRequested, translationRequested });
    } else if (isRecording) {
      await performStopRecording();
    }
  };

  return {
    isRecording,
    // A paste still waiting when the next recording starts must not paint that
    // recording's pill as processing.
    isProcessing: isProcessing || (isPasting && !isRecording),
    isStreaming,
    isAssistantVoice,
    recordingInputKind,
    recordingStartedAt,
    // The running dictation's style ({ id, name, emoji }) while it records and
    // is processed; null for Plain and when idle.
    dictationStyle:
      recordingStyleBadge && (isRecording || isProcessing || isPasting)
        ? recordingStyleBadge
        : null,
    cancellingRef,
    isPreparing,
    isStopping,
    micCaptureStatus,
    transcript,
    partialTranscript,
    startRecording: performStartRecording,
    stopRecording: performStopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
    getAudioLevel,
    // Processing has run long and Esc now cancels it (shown on the pill).
    slowProcessingHint: slowProcessingHint && isProcessing && !isRecording,
    // Bumped when a short empty dictation ends quietly: the pill's spin-down.
    nothingHeardSeq,
  };
};

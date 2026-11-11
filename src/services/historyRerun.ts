// Everything after speech-to-text, for a dictation already in History: what
// Re-transcribe runs once main has transcribed the stored recording again,
// and all that Re-run cleanup runs, on the stored raw transcript. One function,
// so both re-run the dictation exactly as a live one would have:
//
// - the post-speech-to-text boundary (helpers/postTranscription.ts) with the
//   dictation's captured target app, so app-scoped glossary rules apply as
//   they did when it was dictated;
// - its route: its style (even switched off; Plain when the caller says the
//   style was deleted), its translation chain, or cleanup, with today's
//   settings;
// - the snippet expansion a live dictation does after the boundary, recorded
//   as the trace's last step (recordPastedText), without pasting anything;
// - the completion: `update-transcription-text` with the trace, which
//   replaces the row's text and steps together (stepHistory.completeRetry).
//   A newer run on the same row has overtaken this one when main says
//   `stale`: nothing was written, and the newer run reports its own result.
//
// Never speech-to-text, its preflight or a paste. The trace holds dictated
// text: it goes to main with the row and is never logged.

import { getSettings } from "../stores/settingsStore";
import { getGlossarySnapshot } from "../stores/glossaryStore";
import { resolveStyleForRetry } from "../stores/styleStore";
import { styleIdFromRouteKind } from "../config/styles/library";
import {
  executeTranslationChain,
  hasTextContent,
  shouldRunTranslateStep,
} from "../helpers/translationChain";
import { applyChineseScript, resolveChineseScriptTarget } from "../utils/chineseScript";
import {
  recordPastedText,
  runPostTranscription,
  type PostTranscriptionRunArgs,
  type TraceSttReused,
} from "../helpers/postTranscription";
import { expandSnippets, selectCleanupDictionary } from "../utils/snippets";
import { cleanupStepMeta } from "../helpers/dictationCleanupConfig";
import { getAgentName } from "../utils/agentName";
import logger from "../utils/logger";
import type { TranscriptionItem, TranscriptionStepsResult } from "../types/electron";

export interface HistoryRerunInput {
  id: number;
  /** The uncorrected transcript to start from: the new one, or the row's `raw_text`. */
  rawText: string;
  /** The row's route ("translation", "style:<id>", …): what to re-run. */
  routeKind: string | null;
  /** The text the row has now, to skip a write that would change nothing. */
  currentText: string;
  /** Re-run a deleted style's dictation as Plain (the user said so). */
  plainStyle?: boolean;
  /** What produced `rawText`: the re-transcription, or the stored step reused. */
  stt: {
    provider: string | null;
    model: string | null;
    ms?: number | null;
    reused?: TraceSttReused | null;
  };
  /** The dictation's captured target app (from its stored steps), or null. */
  targetApp: string | null;
  /** Main's step-history run for this re-run (beginRun with the row's id). */
  runId: string | null;
}

/** What the re-run tells the user along the way, as a live dictation's toasts do. */
export interface HistoryRerunNotices {
  cleanupFailed: (error: unknown) => void;
  styleNotApplied: (styleName: string, reason: "unreachable" | "failed") => void;
}

export type HistoryRerunOutcome =
  | { status: "updated"; transcription: TranscriptionItem | null; text: string }
  | { status: "unchanged"; text: string }
  | { status: "stale" }
  | { status: "failed"; error?: string };

/** The captured target app a dictation's stored steps carry, or null (none, or not readable). */
export function targetAppFromSteps(result: TranscriptionStepsResult | null | undefined) {
  const app = result?.status === "captured" ? result.context?.targetApp : null;
  return typeof app === "string" && app.trim() ? app.trim() : null;
}

/** Whether a dictation's stored steps say it was a voice-assistant command. */
export function wasAssistantCommand(result: TranscriptionStepsResult | null | undefined) {
  if (result?.status !== "captured") return false;
  return result.route === "agent" || result.context?.intents?.voiceAgent === true;
}

/**
 * Re-run cleanup's speech-to-text step: the dictation's stored one carried
 * over (its provider and model; the text is the row's raw transcript), or one
 * whose provenance is unknown when the dictation has none.
 */
export function reusedSttStep(result: TranscriptionStepsResult | null | undefined) {
  const stored =
    result?.status === "captured" ? result.steps.find((step) => step.kind === "stt") : undefined;
  return stored
    ? {
        provider: stored.provider ?? null,
        model: stored.model ?? null,
        ms: null,
        reused: "stored" as const,
      }
    : { provider: null, model: null, ms: null, reused: "unknown" as const };
}

export async function rerunAfterSpeechToText(
  input: HistoryRerunInput,
  notices: HistoryRerunNotices
): Promise<HistoryRerunOutcome> {
  const { id, rawText, routeKind, currentText, plainStyle, stt, targetApp, runId } = input;
  const s = getSettings();
  const isTranslation = routeKind === "translation";
  let translationApplied = false;
  // A styled dictation re-runs its style ("style:<id>"), unless the user
  // chose Plain because the style was deleted.
  const retryStyleId = plainStyle ? null : styleIdFromRouteKind(routeKind);
  const retryStyle = retryStyleId ? resolveStyleForRetry(retryStyleId) : null;

  const { text: finalText, trace: boundaryTrace } = await runPostTranscription(rawText, {
    context: {
      targetApp,
      voiceAgentRequested: false,
      translationRequested: isTranslation,
      ...(retryStyle
        ? {
            style: { id: retryStyle.id, runMode: retryStyle.runMode },
            appScopedGlossary: retryStyle.appGlossary,
          }
        : {}),
    },
    glossary: getGlossarySnapshot(),
    snippets: s.snippets,
    stt,
    run: async ({
      rawText: routeText,
      workingText,
      recordStep,
      setRoute,
    }: PostTranscriptionRunArgs) => {
      // The style chain, as a styled dictation runs it: two steps or one,
      // with the cleanup switch deciding whether cleanup runs first.
      if (retryStyle) {
        const [
          { isStyleReachable, runStyledDictation },
          { default: ReasoningService },
          { buildDictationCleanupConfig },
          { getEffectiveCleanupModel, getSettings: getEffectiveSettings },
        ] = await Promise.all([
          import("./dictationStyles"),
          import("./ReasoningService"),
          import("../helpers/dictationCleanupConfig"),
          import("../stores/settingsStore"),
        ]);
        const settings = getEffectiveSettings();
        if (!isStyleReachable(settings)) {
          setRoute("none");
          notices.styleNotApplied(retryStyle.name, "unreachable");
          return workingText;
        }
        setRoute("style");
        const agentName = getAgentName();
        let styleFailed = false;
        const styled = await runStyledDictation({
          text: workingText,
          style: retryStyle,
          settings,
          agentName,
          cleanupOn: !!settings.useCleanupModel,
          recordStep,
          runCleanup: (text: string) => {
            // One request, one dictionary: the step records the set the prompt carried.
            const cleanupConfig = buildDictationCleanupConfig(settings);
            return recordStep("cleanup", cleanupStepMeta(cleanupConfig), (dispatched) =>
              ReasoningService.processText(text, getEffectiveCleanupModel(), agentName, {
                ...cleanupConfig,
                onDispatch: dispatched,
              })
            );
          },
          onCleanupError: (cleanupError: unknown) => notices.cleanupFailed(cleanupError),
          onStyleError: () => {
            styleFailed = true;
          },
        });
        if (styleFailed) notices.styleNotApplied(retryStyle.name, "failed");
        return styled.text;
      }
      // A translation dictation re-runs cleanup-then-translate, not plain cleanup.
      if (isTranslation) {
        try {
          const [
            { default: ReasoningService },
            { resolveReasoningRoute },
            { getEffectiveCleanupModel, getSettings: getEffectiveSettings },
          ] = await Promise.all([
            import("./ReasoningService"),
            import("../helpers/audioManager"),
            import("../stores/settingsStore"),
          ]);
          const settings = getEffectiveSettings();
          const agentName = getAgentName();
          // Routing reads what was said; the chain works on the corrected text.
          const route = resolveReasoningRoute(routeText, settings, agentName, false, true);
          setRoute(route.kind);
          if (route.kind === "translation") {
            const { text, translated } = await executeTranslationChain({
              text: workingText,
              cleanupReachable: route.cleanupReachable,
              runCleanup: (currentText: string) =>
                recordStep("cleanup", cleanupStepMeta(route.cleanupConfig), (dispatched) =>
                  ReasoningService.processText(currentText, getEffectiveCleanupModel(), agentName, {
                    ...route.cleanupConfig,
                    onDispatch: dispatched,
                  })
                ),
              runTranslate: (currentText: string) =>
                recordStep("translation", {}, (dispatched) =>
                  ReasoningService.processText(currentText, route.model, agentName, {
                    ...route.config,
                    onDispatch: dispatched,
                  })
                ),
              shouldTranslate: shouldRunTranslateStep(
                settings.translationSourceLanguage,
                settings.translationTargetLanguage
              ),
              onCleanupError: (cleanupError: unknown) => {
                logger.warn(
                  "Cleanup step failed in translation chain, translating raw transcript",
                  { error: (cleanupError as Error).message },
                  "transcription"
                );
                // The chain still translates the transcript, so say why cleanup
                // was dropped rather than reporting a clean success (#2091).
                notices.cleanupFailed(cleanupError);
              },
              onEmptyTranslate: () =>
                logger.warn(
                  "Translation step returned empty text, keeping previous text",
                  {},
                  "transcription"
                ),
              onUnchangedTranslate: () =>
                logger.warn(
                  "Translation step returned unchanged text, keeping source text",
                  {},
                  "transcription"
                ),
            });
            translationApplied = translated;
            return text;
          }
          // Translation disabled/unreachable since recording — fall through to cleanup.
        } catch {
          // Reasoning failed — keep the corrected transcript
          return workingText;
        }
      }

      // Apply AI reasoning if enabled
      if (!getSettings().useCleanupModel) return workingText;
      try {
        const [
          { default: ReasoningService },
          { getEffectiveCleanupModel, isCloudCleanupMode, getSettings: getEffectiveSettings },
        ] = await Promise.all([import("./ReasoningService"), import("../stores/settingsStore")]);
        const model = getEffectiveCleanupModel();
        const isCloud = isCloudCleanupMode();
        if (model || isCloud) {
          setRoute("cleanup");
          const agentName = getAgentName();
          const effective = getEffectiveSettings();
          // Cleanup's word set, decided once for this request and recorded on its step.
          const cleanupDictionary = selectCleanupDictionary(effective);
          const reasonedText = await recordStep(
            "cleanup",
            { detail: { dictionaryScope: cleanupDictionary.scope } },
            (dispatched) =>
              ReasoningService.processText(workingText, model, agentName, {
                disableThinking: effective.cleanupDisableThinking,
                reasoningEffort: effective.cleanupReasoningEffort,
                requireCompleteOutput: true,
                cleanupDictionary,
                onDispatch: dispatched,
              })
          );
          if (hasTextContent(reasonedText)) return reasonedText;
        }
      } catch (cleanupError) {
        // The row keeps its corrected transcript, so the re-run must not look like
        // it cleaned anything — report why, the way dictation does (#2091).
        notices.cleanupFailed(cleanupError);
      }
      return workingText;
    },
    // Deterministic Chinese script pass, mirroring dictation (#975). Runs last so
    // it covers the cleaned/translated text, or the transcript when neither ran.
    // Same rule as audioManager.getEffectiveOutputLanguage: only a completed
    // translate step moves the text into the target language, so anything else
    // still has to be scripted as the language that was dictated.
    finalize: (text: string) => {
      const outputLanguage = isTranslation
        ? (translationApplied ? s.translationTargetLanguage : s.translationSourceLanguage) || "auto"
        : s.preferredLanguage;
      return applyChineseScript(
        text,
        resolveChineseScriptTarget(outputLanguage, s.chineseScriptPreference, text)
      );
    },
  });

  // A live dictation expands snippets after the boundary, before pasting:
  // replay that, and end the trace with it, as useAudioRecording does.
  const text = expandSnippets(finalText, s.snippets);
  const trace = recordPastedText(boundaryTrace, text);

  // Main began this re-run's step-history run; its steps replace the row's
  // old ones together with the text, even when the text is unchanged.
  if (runId) trace.runId = runId;
  if (text === currentText && !trace.runId) return { status: "unchanged", text };
  const updated = await window.electronAPI.updateTranscriptionText(id, text, rawText, { trace });
  // A newer run on this row overtook this one; it reports its own result.
  if (updated?.stale) return { status: "stale" };
  if (!updated?.success) return { status: "failed", error: updated?.error };
  return { status: "updated", transcription: updated.transcription ?? null, text };
}

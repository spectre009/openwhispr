import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Settings, Wand2 } from "../icons";
import { Button } from "./button";
import { useSettingsStore } from "../../stores/settingsStore";
import { useStyleStore } from "../../stores/styleStore";
import { DEFAULT_PROMPT_ID, findPromptEntry } from "../../config/prompts/library";
import { describeStepFailure, openProviderSettings } from "../../utils/describeProviderError";
import { isFlaggedStepFailure } from "../../helpers/stepFailure.js";
import type { TranscriptionStepRecord, TranscriptionStepsResult } from "../../types/electron";
import {
  stepKindLabel,
  stepOutcomeLabel,
  stepReusedLabel,
  styleStepFacts,
  dictionaryScopeFact,
} from "./transcriptionStepLabels";

// Step history for one dictation, read from main on demand. Main scopes it to
// the current account (or the signed-out namespace); rows from before step
// history, or pulled from the cloud, have none.

/**
 * A step that failed: why, in the words its error card used (the stored
 * failure's message key), its code as small print, then the fix: the settings
 * the card offered and, for cleanup, a style or a translation, Re-run
 * cleanup. A failure stored before reasons were kept shows its code alone.
 */
export function StepFailure({
  step,
  onRerunCleanup,
  busy = false,
  running = false,
}: {
  step: TranscriptionStepRecord;
  onRerunCleanup?: () => void;
  /** A re-run of this dictation is going: the button waits. */
  busy?: boolean;
  /** It is the Re-run cleanup. */
  running?: boolean;
}) {
  const { t } = useTranslation();
  if (!step.errorCode && step.outcome !== "failed" && step.outcome !== "fallback") return null;
  const failure = step.detail?.failure ?? null;
  const reason = describeStepFailure(failure, t);
  const settingsTarget = failure?.settingsTarget;
  const rerun = onRerunCleanup && isFlaggedStepFailure(step) ? onRerunCleanup : null;
  if (!reason && !settingsTarget && !rerun) {
    return step.errorCode ? (
      <p className="mt-1 text-[11px] text-muted-foreground/80">
        {t("controlPanel.history.steps.errorCode", { code: step.errorCode })}
      </p>
    ) : null;
  }
  return (
    <div className="mt-2">
      {reason && (
        <p dir="auto" className="text-sm leading-relaxed text-foreground/90">
          {reason}
        </p>
      )}
      {step.errorCode && (
        <p className="mt-0.5 text-[11px] text-muted-foreground/80">
          {t("controlPanel.history.steps.errorCode", { code: step.errorCode })}
        </p>
      )}
      {(settingsTarget || rerun) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {settingsTarget && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openProviderSettings(settingsTarget)}
            >
              <Settings size={13} />
              {t("providerErrors.openSettings")}
            </Button>
          )}
          {rerun && (
            <Button variant="outline" size="sm" disabled={busy} onClick={rerun}>
              {running ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              {t("controlPanel.history.rerunCleanup.action")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A model step's prompt: its name and "Show prompt" (also the History view's step cards). */
export function StepPrompt({ step }: { step: TranscriptionStepRecord }) {
  const { t } = useTranslation();
  const cleanupLibrary = useSettingsStore((state) => state.promptLibraries?.cleanup);
  const prompt = step.prompt;
  if (!prompt) return null;
  if (prompt.source === "server") {
    return (
      <p className="mt-0.5 text-[11px] text-muted-foreground/80">
        {t("controlPanel.history.steps.promptServer")}
      </p>
    );
  }
  const entry =
    step.kind === "cleanup" && cleanupLibrary
      ? findPromptEntry(cleanupLibrary, prompt.entryId)
      : undefined;
  const label =
    step.kind === "cleanup" && prompt.entryId === DEFAULT_PROMPT_ID
      ? t("controlPanel.history.steps.promptBuiltIn")
      : entry?.name ||
        t("controlPanel.history.steps.promptHash", { hash: (prompt.hash || "").slice(0, 8) });
  return (
    <details className="mt-0.5 text-[11px] text-muted-foreground/80">
      <summary className="cursor-pointer select-none">
        {label} · {t("controlPanel.history.steps.showPrompt")}
      </summary>
      <p
        dir="auto"
        className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word rounded-sm bg-muted/40 p-2"
      >
        {prompt.text ?? ""}
      </p>
    </details>
  );
}

/** `revision` (the row's text) reloads the steps after a retry rewrites the row. */
export default function TranscriptionSteps({ id, revision }: { id: number; revision?: string }) {
  const { t } = useTranslation();
  const styleLibrary = useStyleStore((state) => state.library);
  const [result, setResult] = useState<TranscriptionStepsResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setFailed(false);
    const load = window.electronAPI?.getTranscriptionSteps;
    if (!load) {
      setFailed(true);
      return;
    }
    load(id).then(
      (reply) => {
        if (cancelled) return;
        if (reply?.success) setResult(reply);
        else setFailed(true);
      },
      () => {
        if (!cancelled) setFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [id, revision]);

  if (failed) {
    return (
      <p className="text-xs text-muted-foreground">{t("controlPanel.history.steps.loadError")}</p>
    );
  }
  if (!result) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />
        {t("controlPanel.history.steps.loading")}
      </div>
    );
  }
  if (result.status !== "captured" || result.steps.length === 0) {
    return (
      <p className="text-xs italic text-muted-foreground/80">
        {t(
          result.status === "otherOwner"
            ? "controlPanel.history.steps.otherOwner"
            : "controlPanel.history.steps.notCaptured"
        )}
      </p>
    );
  }

  return (
    <div>
      {result.context?.targetApp && (
        <p className="mb-1 text-[11px] text-muted-foreground/80">
          {t("controlPanel.history.steps.targetApp", { app: result.context.targetApp })}
        </p>
      )}
      <ol className="space-y-2">
        {result.steps.map((step, index) => {
          const facts = [
            ...styleStepFacts(step, styleLibrary, t),
            dictionaryScopeFact(step, t),
            step.provider,
            step.model,
            step.ms !== null && step.ms !== undefined
              ? t("controlPanel.history.steps.durationMs", { ms: step.ms })
              : null,
            step.kind === "glossary" && step.outcome === "ok"
              ? t("controlPanel.history.steps.corrections", {
                  n: step.detail?.rulesFired?.length ?? 0,
                })
              : null,
          ].filter(Boolean);
          const reused = stepReusedLabel(step, t);
          return (
            <li key={index} className="text-xs">
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-medium text-foreground/90">{stepKindLabel(step, t)}</span>
                {step.outcome !== "ok" && (
                  <span className="rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {stepOutcomeLabel(step.outcome, t)}
                  </span>
                )}
                {reused && (
                  <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">
                    {reused}
                  </span>
                )}
                {facts.length > 0 && (
                  <span className="text-[11px] text-muted-foreground/80">{facts.join(" · ")}</span>
                )}
              </div>
              {step.output && step.outcome !== "skipped" && (
                <p
                  dir="auto"
                  className="mt-0.5 whitespace-pre-wrap wrap-break-word leading-relaxed text-muted-foreground"
                >
                  {step.output}
                </p>
              )}
              <StepFailure step={step} />
              <StepPrompt step={step} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

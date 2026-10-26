import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import { consumeCleanupFailures, useCleanupFailureStore } from "../stores/cleanupFailureStore";
import { isDictationPanelWindow } from "../utils/windowContext";
import { cleanupFailureActions, cleanupFailureReason } from "../utils/cleanupFailureCard";

/**
 * Tells the user their dictation was pasted raw because AI cleanup failed:
 * why, and the fix. In the dictation window it takes the pill's error card
 * and stays until dismissed or the next dictation starts, with Open Settings
 * (when Settings can fix it) and Open in History (the dictation's own row,
 * where Re-run cleanup is). A failure from a dictation a newer one has
 * replaced is never shown over it.
 */
export default function CleanupFailureToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const pending = useCleanupFailureStore((s) => s.pending);

  useEffect(() => {
    if (pending === 0) return;
    const state = useCleanupFailureStore.getState();
    const failure = state.lastFailure ?? { message: state.lastMessage };
    // Draining first keeps a re-run of this effect from toasting the same failure twice.
    if (consumeCleanupFailures() === 0) return;
    if (failure.dictation && !failure.dictation.isCurrent()) return;
    const actions = cleanupFailureActions(failure, t, { rowId: failure.dictation?.rowId });
    const reason = cleanupFailureReason(failure, t);
    // Only a dictation window that knows its text wasn't pasted says so.
    const outcome = t(
      failure.dictation?.pasted === false
        ? "app.toasts.cleanupFailed.descriptionNotPasted"
        : "app.toasts.cleanupFailed.description"
    );
    if (isDictationPanelWindow()) {
      // The panel may already be hidden after dictation; surface it so the card is seen.
      window.electronAPI?.showDictationPanel?.();
      toast({
        title: t("app.toasts.cleanupFailed.title"),
        // A line break, not a space, so CJK sentences don't get one after "。".
        description: [reason, outcome].filter(Boolean).join("\n"),
        ...(actions.length ? { actions } : {}),
        variant: "destructive",
        // The dictation has already pasted, so the card takes the pill's place
        // like a transcription failure does, until dismissed.
        presentation: "dictation-error",
        duration: 0,
        dismissible: true,
      });
      return;
    }
    toast({
      title: t("app.toasts.cleanupFailed.title"),
      description: [reason, outcome].filter(Boolean).join("\n"),
      ...(actions.length ? { actions } : {}),
      variant: "destructive",
      duration: 0,
    });
  }, [pending, toast, t]);

  return null;
}

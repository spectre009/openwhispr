import type { TFunction } from "i18next";
import type { ToastActionConfig } from "../components/ui/useToast";
import type { CleanupFailure } from "../stores/cleanupFailureStore";
import {
  describeProviderError,
  openInHistoryAction,
  providerErrorActions,
} from "./describeProviderError";

// What a dictation card says about a failed cleanup, shared by the cleanup
// card (CleanupFailureToastListener) and a paste-failure card that carries the
// same dictation's cleanup failure with it (useAudioRecording), so both read
// the same.

/** Why cleanup failed, in the words the error came with, then what to do (enterprise). */
export function cleanupFailureReason(failure: CleanupFailure, t: TFunction): string {
  const reason = describeProviderError(failure, t).description || failure.message;
  const action = failure.actionKey ? String(t(failure.actionKey)) : failure.action;
  return [reason, action].filter(Boolean).join("\n");
}

/** The cleanup card's actions: Open Settings, Open in History, the recovery command, Copy details. */
export function cleanupFailureActions(
  failure: CleanupFailure,
  t: TFunction,
  {
    rowId,
    isCurrent = () => true,
  }: { rowId?: Promise<number | null> | null; isCurrent?: () => boolean } = {}
): ToastActionConfig[] {
  const providerActions = providerErrorActions(
    { settingsTarget: failure.settingsTarget, technicalDetails: failure.technicalDetails },
    t,
    isCurrent
  );
  const actions = providerActions.filter((action) => action.icon === "settings");
  const details = providerActions.filter((action) => action.icon !== "settings");
  if (rowId) actions.push(openInHistoryAction(rowId, t, isCurrent));
  const command = failure.copyCommand;
  if (command) {
    actions.push({
      label: t("reasoning.enterprise.technicalDetails.copyCommand"),
      icon: "copy",
      dismissOnClick: false,
      feedback: {
        successLabel: t("common.copied"),
        failureLabel: t("hooks.audioRecording.pastePermission.copyFailed"),
      },
      onClick: async () => {
        try {
          const result = await window.electronAPI?.writeClipboard?.(command);
          return result?.success === true;
        } catch {
          return false;
        }
      },
    });
  }
  return [...actions, ...details];
}

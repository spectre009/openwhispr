import type { CleanupDictionarySetting } from "../../utils/snippets";
import type { DictionaryCoverage, SpeechSetupLabel } from "./useDictionaryCoverage";

// The Dictionary page's shared wording: cleanup's word sets, who reads the
// speech-to-text hints and how much of the budget they use, and why
// heard/written isn't available.

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const CLEANUP_SET_KEYS: Record<CleanupDictionarySetting, string> = {
  all: "settingsPage.cleanupDictionary.options.all",
  typedPinnedMissed: "settingsPage.cleanupDictionary.options.typedPinnedMissed",
  typedPinned: "settingsPage.cleanupDictionary.options.typedPinned",
  none: "settingsPage.cleanupDictionary.options.none",
};

/** Whether cleanup gets a word, and why (an i18n key with its params). */
export interface CleanupInclusion {
  included: boolean;
  key: string;
  params?: Record<string, unknown>;
}

/** "Azure Speech · MAI-Transcribe-2": who reads the hints. */
export function speechSetupName(label: SpeechSetupLabel, t: Translate): string {
  switch (label.kind) {
    case "managed":
      return t("dictionary.where.speech.setup.managed");
    case "cloud":
      return t("dictionary.where.speech.setup.cloud");
    case "localWhisper":
      return t("dictionary.where.speech.setup.localWhisper", { model: label.model });
    case "localOther":
      return t("dictionary.where.speech.setup.localOther");
    case "selfHosted":
      return label.model
        ? t("dictionary.where.speech.setup.selfHostedModel", { model: label.model })
        : t("dictionary.where.speech.setup.selfHosted");
    default:
      return label.model ? `${label.name} · ${label.model}` : label.name;
  }
}

/** "142 of 199 phrases", "3,104 of 8,000 characters", or null when nothing is sent. */
export function speechBudgetText(
  coverage: Pick<DictionaryCoverage, "budget">,
  t: Translate,
  format: (n: number) => string
): string | null {
  const { budget } = coverage;
  if (!budget.unit) return null;
  const used = format(budget.used);
  if (budget.limit == null) return t(`dictionary.where.speech.used.${budget.unit}`, { used });
  return t(`dictionary.where.speech.usedOf.${budget.unit}`, {
    used,
    limit: format(budget.limit),
  });
}

const UNAVAILABLE_KEYS: Record<string, string> = {
  "history-off": "dictionary.usage.unavailable.historyOff",
  "policy-off": "dictionary.usage.unavailable.policyOff",
  pending: "dictionary.usage.unavailable.pending",
  idle: "dictionary.usage.unavailable.pending",
};

/** Why heard/written (or a word's evidence) can't be shown. */
export function usageUnavailableKey(reason: string | null | undefined): string {
  return UNAVAILABLE_KEYS[reason ?? ""] ?? "dictionary.usage.unavailable.other";
}

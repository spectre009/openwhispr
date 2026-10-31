import type { CleanupDictionarySetting } from "../../utils/snippets";
import type { DictionaryAppearanceKind, DictionaryFixedBy } from "../../types/electron";
import type { DictionaryCoverage, SpeechSetupLabel } from "./useDictionaryCoverage";

// The Dictionary page's shared wording: cleanup's word sets, who reads the
// speech-to-text hints and how much of the budget they use, why usage isn't
// available, and the kinds of an appearance ("speech got it", "fixed after
// speech", "changed after speech") shared with History.

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

/** Why usage (or a word's evidence, or where it appeared) can't be shown. */
export function usageUnavailableKey(reason: string | null | undefined): string {
  return UNAVAILABLE_KEYS[reason ?? ""] ?? "dictionary.usage.unavailable.other";
}

/** What happened to a word at one place: speech got it, fixed after speech, changed after speech. */
export const APPEARANCE_KIND_KEYS: Record<DictionaryAppearanceKind, string> = {
  ok: "dictionary.kinds.ok",
  fix: "dictionary.kinds.fix",
  chg: "dictionary.kinds.chg",
};

/** "by the glossary", "by cleanup", "by a style". */
export const FIXED_BY_KEYS: Record<DictionaryFixedBy, string> = {
  glossary: "dictionary.kinds.by.glossary",
  cleanup: "dictionary.kinds.by.cleanup",
  style: "dictionary.kinds.by.style",
};

/** The colors of the three kinds (the usage bar, the chart, History's underlines). */
export const APPEARANCE_KIND_BG: Record<DictionaryAppearanceKind, string> = {
  ok: "bg-success",
  fix: "bg-warning",
  chg: "bg-destructive",
};

export const APPEARANCE_KIND_TEXT: Record<DictionaryAppearanceKind, string> = {
  ok: "text-success",
  fix: "text-warning",
  chg: "text-destructive",
};

/** A word's counts as the page says them, from the row summaries (dictionaryUsage.js). */
export function usageParts(usage: {
  heard: number;
  written: number;
  missedRows: number;
  bothRows?: number;
}): { used: number; ok: number; fix: number; chg: number } {
  const ok = usage.bothRows ?? Math.max(0, usage.written - usage.missedRows);
  return {
    used: usage.written,
    ok,
    fix: usage.missedRows,
    chg: Math.max(0, usage.heard - ok),
  };
}

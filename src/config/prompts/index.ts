import i18n, { normalizeUiLanguage } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { en as enPrompts } from "../../locales/prompts";
import { getLanguageInstruction } from "../../utils/languageSupport";
import {
  formatCleanupDictionaryGroups,
  type CleanupDictionaryGroup,
  type CleanupDictionaryGroupKey,
} from "../../utils/dictionaryCategories";
import { PROMPT_KINDS, PLAIN_TEXT_RESPONSE_SUFFIX, type PromptKind } from "./registry";

export { PROMPT_KINDS, PROMPT_KIND_LIST, type PromptKind } from "./registry";

export interface ResolvePromptOptions {
  agentName: string | null;
  uiLanguage?: string;
  language?: string;
  customDictionary?: string[];
  /** Cleanup only: the same words by category (the grouped suffix); the flat list otherwise. */
  customDictionaryGroups?: readonly CleanupDictionaryGroup[];
  targetLanguageLabel?: string;
}

export function resolvePrompt(kind: PromptKind, opts: ResolvePromptOptions): string {
  return resolvePromptText(kind, useSettingsStore.getState().customPrompts[kind], opts);
}

/**
 * resolvePrompt for an explicit template instead of the saved one: the same
 * substitutions and suffixes, with "" meaning the built-in default. Lets a
 * candidate prompt be tried without saving it.
 */
export function resolvePromptText(
  kind: PromptKind,
  template: string,
  opts: ResolvePromptOptions
): string {
  return applySubstitutions(template || getDefaultPromptText(kind, opts.uiLanguage), opts);
}

/**
 * Which cleanup prompt one request runs, without touching saved settings:
 * - inherit: the saved prompt (what a dictation uses), read when the request starts;
 * - builtin: the built-in default, as if no prompt were saved;
 * - text: this text, as if it were the saved prompt ("" is the built-in default).
 * It changes only the prompt: the transcript wrapper, sampling, completeness and
 * output validation stay those of a real cleanup request.
 */
export type CleanupPromptOverride =
  { mode: "inherit" } | { mode: "builtin" } | { mode: "text"; text: string };

/** The cleanup template a request uses; "" is the built-in default. */
export function resolveCleanupPromptTemplate(
  override: CleanupPromptOverride | undefined,
  savedTemplate: string
): string {
  if (!override || override.mode === "inherit") return savedTemplate || "";
  if (override.mode === "builtin") return "";
  return typeof override.text === "string" ? override.text : "";
}

export function getDefaultPromptText(kind: PromptKind, uiLanguage?: string): string {
  const def = PROMPT_KINDS[kind];
  if (!def.i18nKey) return def.fallback;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const t = i18n.getFixedT(locale, "prompts");
  return t(def.i18nKey, { defaultValue: def.fallback });
}

// The cleanup prompt tells the model its input arrives between <transcript>
// tags; the trailing line re-anchors the output contract right after the
// transcript, where models weight instructions most. Mirrors api/reason.ts
// in openwhispr-api.
export function wrapCleanupTranscript(text: string): string {
  return `<transcript>\n${text}\n</transcript>\n\nOutput only the cleaned transcript.`;
}

// Appended to the dictation-agent prompt only when a screenshot is attached.
export function appendScreenContextSuffix(prompt: string, uiLanguage?: string): string {
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const suffix = i18n.getFixedT(locale, "prompts")("screenContextSuffix", {
    defaultValue: enPrompts.screenContextSuffix,
  });
  return prompt + suffix;
}

// The grouped dictionary's labels (prompts namespace, translated per locale).
const DICTIONARY_GROUP_KEYS = {
  people: "dictionaryGroupPeople",
  work: "dictionaryGroupWork",
  everyday: "dictionaryGroupEveryday",
  other: "dictionaryGroupOther",
} as const satisfies Record<CleanupDictionaryGroupKey, keyof typeof enPrompts>;

export function appendDictionarySuffix(
  prompt: string,
  customDictionary?: string[],
  uiLanguage?: string,
  groups?: readonly CleanupDictionaryGroup[]
): string {
  if (!customDictionary?.length) return prompt;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const t = i18n.getFixedT(locale, "prompts");
  const suffix = t("dictionarySuffix", {
    defaultValue: enPrompts.dictionarySuffix,
  });
  // Grouped (cleanup's "Group words by category"): the same sentence, then
  // "People: …; Work terms: …; Other: …" in the UI language.
  if (groups?.some((group) => group.words.length > 0)) {
    return (
      prompt +
      suffix +
      formatCleanupDictionaryGroups(groups, (group) =>
        t(DICTIONARY_GROUP_KEYS[group], { defaultValue: enPrompts[DICTIONARY_GROUP_KEYS[group]] })
      )
    );
  }
  return prompt + suffix + customDictionary.join(", ");
}

// Append after every other suffix: trailing instructions are the ones models weight most.
export function appendPlainTextResponseSuffix(prompt: string): string {
  return prompt + PLAIN_TEXT_RESPONSE_SUFFIX;
}

function applySubstitutions(template: string, opts: ResolvePromptOptions): string {
  const name = opts.agentName?.trim() || "Assistant";
  let prompt = template.replace(/\{\{agentName\}\}/g, name);

  if (opts.targetLanguageLabel) {
    prompt = prompt.replace(/\{\{targetLanguage\}\}/g, opts.targetLanguageLabel);
  }

  const langInstruction = getLanguageInstruction(opts.language);
  if (langInstruction) prompt += "\n\n" + langInstruction;

  return appendDictionarySuffix(
    prompt,
    opts.customDictionary,
    opts.uiLanguage,
    opts.customDictionaryGroups
  );
}

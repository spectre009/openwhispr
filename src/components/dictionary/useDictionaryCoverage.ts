import { useMemo } from "react";
import { getSettings, useSettingsStore } from "../../stores/settingsStore";
import { usePolicyStore } from "../../stores/policyStore";
import { useEnterpriseIdentityStore } from "../../stores/enterpriseIdentityStore";
import { useDictionarySourcesStore } from "../../stores/dictionarySourcesStore";
import { hintScoresFromUsage, useDictionaryUsageStore } from "../../stores/dictionaryUsageStore";
import { useGlossaryStore } from "../../stores/glossaryStore";
import { getManagedTranscriptionResolution } from "../../services/managedTranscription";
import { getTranscriptionProvider, getTranscriptionProviders } from "../../models/ModelRegistry";
import { glossaryCanonicalTerms } from "../../utils/glossary";
import {
  hintScoresForDictionary,
  normalizeDictionaryHintOrder,
} from "../../utils/dictionaryHintOrder";
import { buildSttHintFields } from "../../utils/sttHintFields.js";
import { resolveSttHintSpec, type SttHintSpec } from "../../utils/sttHintSpec";
import { buildSherpaHotwords } from "../../utils/sherpaHotwords";
import { dictionaryWordKey } from "../../utils/dictionaryWordKey.js";
import type { CoverageEntry } from "../../utils/dictionaryList";
import type { HintCoverage, HintSource } from "../../utils/dictionaryHints";
import { useSpeechDictionaryNotice, type SpeechDictionaryNotice } from "./speechDictionaryNotice";

// What the current speech setup sends of the dictionary: the hint route
// History's Re-transcribe would use (sttHintSpec.ts) and the fields
// buildSttHintFields builds for it, so the list's coverage and cut line are
// read off what a request carries: pins in pin order, the order setting and
// the usage scores live dictation ranks by. Recomputed when any setting,
// source, pin, usage count or glossary rule changes. A local sherpa model
// takes no request fields: Orukeet gets the dictionary as hotwords when its
// server starts (main's _getDictionaryHotwords: personal words in stored
// order, then teamspaces', then the workspace's, at most MAX_SHERPA_HOTWORDS),
// so its coverage is read off that list instead. `notice` says when the
// speech model gets none or only part of the dictionary (OpenRouter, a local
// model that ignores it, Orukeet's cap).

export type SpeechBudgetUnit = "chars" | "keywords" | "phrases" | "words" | "terms";

export interface SpeechBudget {
  unit: SpeechBudgetUnit | null;
  used: number;
  limit: number | null;
  readChars: number | null;
}

/** Who reads the hints, for the page's labels. */
export type SpeechSetupLabel =
  | { kind: "managed" }
  | { kind: "cloud" }
  | { kind: "localWhisper"; model: string }
  | { kind: "localOther" }
  | { kind: "selfHosted"; model: string }
  | { kind: "provider"; name: string; model: string };

export interface DictionaryCoverage {
  spec: SttHintSpec;
  entries: CoverageEntry[];
  budget: SpeechBudget;
  /** Terms (of every source) the request leaves out. */
  notSent: number;
  /** Terms it carries. */
  sent: number;
  label: SpeechSetupLabel;
  /** Whether evidence order ranked the unpinned words (the setting, with usage counts). */
  evidence: boolean;
  /** When the speech model gets none or only part of the dictionary. */
  notice: SpeechDictionaryNotice | null;
}

type EffectiveSettings = ReturnType<typeof getSettings>;

// One sherpa hotword's form, as buildSherpaHotwords writes it (words starting
// with ":" dropped, whitespace collapsed), lowercased: its dedupe key.
const hotwordKey = (part: string): string =>
  part
    .split(/\s+/)
    .filter((word) => word && !word.startsWith(":"))
    .join(" ")
    .toLowerCase();

/**
 * Coverage for a sherpa model that takes the dictionary as hotwords: the list
 * main sends (personal words in stored order without the ones hidden in every
 * team list, then teamspaces', then the workspace's), each term sent when all
 * of it is in that list, ranked by its place there.
 */
export function sherpaHotwordCoverage(
  entries: readonly CoverageEntry[],
  settings: Pick<EffectiveSettings, "customDictionary" | "sharedDictionaryHints">,
  limit: number
): { entries: CoverageEntry[]; budget: SpeechBudget } {
  const hints = settings.sharedDictionaryHints;
  const suppressed = new Set((hints?.suppressedPersonal ?? []).map((w) => dictionaryWordKey(w)));
  const personal = (settings.customDictionary ?? []).filter(
    (word) => !suppressed.has(dictionaryWordKey(word))
  );
  const hotwords: string[] = buildSherpaHotwords([
    ...personal,
    ...(hints?.space ?? []),
    ...(hints?.workspace ?? []),
  ]);
  const places = new Map(hotwords.map((hotword, index) => [hotword.toLowerCase(), index]));
  const ranked = entries.map((entry) => {
    const parts = entry.term
      .split(/[,\r\n]+/)
      .map(hotwordKey)
      .filter(Boolean);
    const indexes = parts.map((part) => places.get(part));
    const sent = parts.length > 0 && indexes.every((index) => index !== undefined);
    return {
      entry,
      sent,
      place: sent ? Math.min(...(indexes as number[])) : hotwords.length + entry.rank,
    };
  });
  return {
    entries: ranked
      .sort((a, b) => a.place - b.place)
      .map(({ entry, sent }, index) => ({
        ...entry,
        coverage: (sent ? "read" : "notSent") as HintCoverage,
        rank: index + 1,
      })),
    budget: { unit: "terms", used: hotwords.length, limit, readChars: null },
  };
}

function speechSetupLabel(spec: SttHintSpec, settings: EffectiveSettings): SpeechSetupLabel {
  if (spec.route === "managed") return { kind: "managed" };
  if (spec.route === "cloud") return { kind: "cloud" };
  if (spec.route === "local-whisper") {
    return { kind: "localWhisper", model: settings.whisperModel || "" };
  }
  if (settings.transcriptionMode === "self-hosted" && settings.remoteTranscriptionUrl) {
    return { kind: "selfHosted", model: spec.model || settings.remoteTranscriptionModel || "" };
  }
  if (settings.useLocalWhisper) return { kind: "localOther" };
  const providerId = settings.cloudTranscriptionProvider || "openai";
  const provider = getTranscriptionProvider(providerId);
  const modelId = spec.model || settings.cloudTranscriptionModel || "";
  const model = provider?.models?.find((entry) => entry.id === modelId)?.name || modelId;
  return { kind: "provider", name: provider?.name || providerId, model };
}

export function useDictionaryCoverage(): DictionaryCoverage {
  const state = useSettingsStore();
  const policy = usePolicyStore();
  const enterprise = useEnterpriseIdentityStore();
  const learned = useDictionarySourcesStore((s) => s.learned);
  const pinned = useDictionarySourcesStore((s) => s.pinned);
  const usageStatus = useDictionaryUsageStore((s) => s.status);
  const usageWords = useDictionaryUsageStore((s) => s.words);
  const glossaryRules = useGlossaryStore((s) => s.rules);
  const notice = useSpeechDictionaryNotice();

  return useMemo(() => {
    const settings = getSettings();
    const spec = resolveSttHintSpec({
      settings,
      managed: getManagedTranscriptionResolution(),
      providers: getTranscriptionProviders(),
    });
    const words = settings.customDictionary ?? [];
    const fields = buildSttHintFields(spec, {
      words,
      learned: [...learned],
      // In pin order, with the order setting and the usage scores live
      // dictation ranks by: the page shows the order and cut a request uses.
      pinned: [...pinned],
      glossaryTerms: glossaryCanonicalTerms(glossaryRules),
      snippets: (settings.snippets ?? []).map((snippet) => ({ trigger: snippet.trigger })),
      chineseScriptPreference: settings.chineseScriptPreference ?? null,
      speechLanguage: settings.preferredLanguage || "auto",
      hintOrder: normalizeDictionaryHintOrder(settings.dictionaryHintOrder),
      scores: hintScoresForDictionary(hintScoresFromUsage(usageStatus, usageWords), words),
    });
    const planned: CoverageEntry[] = fields.entries.map((entry) => ({
      term: entry.term,
      source: entry.source as HintSource,
      coverage: entry.coverage as HintCoverage,
      rank: entry.rank,
    }));
    // A sherpa model gets no request fields (spec "none"); Orukeet's hotwords
    // are what reaches it.
    const hotwords =
      notice?.kind === "localModelHotwords" && spec.route === "none"
        ? sherpaHotwordCoverage(planned, settings, notice.limit)
        : null;
    const entries = hotwords?.entries ?? planned;
    const notSent = entries.filter((entry) => entry.coverage === "notSent").length;
    return {
      spec,
      entries,
      budget: hotwords?.budget ?? (fields.budget as SpeechBudget),
      notSent,
      sent: entries.length - notSent,
      label: speechSetupLabel(spec, settings),
      evidence: !hotwords && fields.ranking?.evidence === true,
      notice,
    };
    // getSettings and the managed resolution read these stores' states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, policy, enterprise, learned, pinned, usageStatus, usageWords, glossaryRules, notice]);
}

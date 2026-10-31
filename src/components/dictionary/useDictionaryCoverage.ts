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
import type { CoverageEntry } from "../../utils/dictionaryList";
import type { HintCoverage, HintSource } from "../../utils/dictionaryHints";

// What the current speech setup sends of the dictionary: the hint route
// History's Re-transcribe would use (sttHintSpec.ts) and the fields
// buildSttHintFields builds for it, so the list's coverage and cut line are
// read off what a request carries: pins in pin order, the order setting and
// the usage scores live dictation ranks by. Recomputed when any setting,
// source, pin, usage count or glossary rule changes.

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
}

type EffectiveSettings = ReturnType<typeof getSettings>;

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
    const entries: CoverageEntry[] = fields.entries.map((entry) => ({
      term: entry.term,
      source: entry.source as HintSource,
      coverage: entry.coverage as HintCoverage,
      rank: entry.rank,
    }));
    return {
      spec,
      entries,
      budget: fields.budget as SpeechBudget,
      notSent: fields.counts.notSent,
      sent: fields.counts.terms,
      label: speechSetupLabel(spec, settings),
      evidence: fields.ranking?.evidence === true,
    };
    // getSettings and the managed resolution read these stores' states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, policy, enterprise, learned, pinned, usageStatus, usageWords, glossaryRules]);
}

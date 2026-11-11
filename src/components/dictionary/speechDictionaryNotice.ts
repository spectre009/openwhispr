import { useMemo } from "react";
import { selectPolicyEffectiveSettings, useSettingsStore } from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { useManagedScopeResolution } from "../../stores/enterpriseIdentityStore";
import { resolveTranscriptionRoute } from "../../helpers/transcriptionRoute";
import { dictionaryReachesTranscriptionModel } from "../../utils/dictionaryPromptCap";
import { getSherpaHotwordsScore, MAX_SHERPA_HOTWORDS } from "../../utils/sherpaHotwords";
import { getParakeetModelInfo } from "../../models/ModelRegistry";

// When dictation's speech model gets none of the dictionary, or only part of
// it: OpenRouter's speech models drop it (#2105), a local sherpa model ignores
// it until it's measured, and Orukeet takes up to MAX_SHERPA_HOTWORDS entries
// as hotwords (#3159). Resolved the way dictation resolves its route
// (audioManager.resolveBatchRoute, policy-effective settings). A managed
// workspace's deployment, OpenWhispr Cloud and local Whisper get the
// dictionary their own way, so they have no notice. The Dictionary's "Where it
// goes" shows it with the coverage it explains; the lists with teammates'
// words show it under the list.

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type SpeechDictionaryNotice =
  | { kind: "openRouterIgnored" }
  | { kind: "localModelIgnored"; model: string }
  | { kind: "localModelHotwords"; model: string; modelId: string; limit: number };

export function useSpeechDictionaryNotice(): SpeechDictionaryNotice | null {
  const policyState = usePolicySnapshot();
  const enterpriseTranscriptionSetupMode = useSettingsStore(
    (s) => s.enterpriseTranscriptionSetupMode
  );
  const personalDictation =
    useManagedScopeResolution("transcription", enterpriseTranscriptionSetupMode).kind === "manual";
  // Where dictation posts when it uses a bring-your-own-key batch provider.
  const dictationEndpoint = useSettingsStore((settings) => {
    const s = selectPolicyEffectiveSettings(settings, policyState);
    if (s.useLocalWhisper || s.cloudTranscriptionMode === "openwhispr") return null;
    const route = resolveTranscriptionRoute({ settings: s });
    return route.transport === "http-batch" ? route.endpoint : null;
  });
  // The local sherpa model dictation runs, the way audioManager picks it.
  const localSherpaModel = useSettingsStore((settings) => {
    const s = selectPolicyEffectiveSettings(settings, policyState);
    if (!s.useLocalWhisper) return null;
    if (s.localTranscriptionProvider === "nvidia") return s.parakeetModel || null;
    if (s.localTranscriptionProvider === "cohere") return s.cohereModel || null;
    return null;
  });

  return useMemo((): SpeechDictionaryNotice | null => {
    if (!personalDictation) return null;
    if (dictationEndpoint !== null && !dictionaryReachesTranscriptionModel(dictationEndpoint)) {
      return { kind: "openRouterIgnored" };
    }
    if (!localSherpaModel) return null;
    const model = getParakeetModelInfo(localSherpaModel)?.name ?? localSherpaModel;
    return getSherpaHotwordsScore(localSherpaModel) === null
      ? { kind: "localModelIgnored", model }
      : {
          kind: "localModelHotwords",
          model,
          modelId: localSherpaModel,
          limit: MAX_SHERPA_HOTWORDS,
        };
  }, [personalDictation, dictationEndpoint, localSherpaModel]);
}

export function speechDictionaryNoticeText(notice: SpeechDictionaryNotice, t: Translate): string {
  switch (notice.kind) {
    case "openRouterIgnored":
      return t("dictionary.openRouterIgnoredNotice");
    case "localModelIgnored":
      return t("dictionary.localModelIgnoredNotice", { model: notice.model });
    default:
      return t("dictionary.localModelHotwordsLimitNotice", {
        model: notice.model,
        limit: notice.limit,
      });
  }
}

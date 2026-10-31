import { useEffect, useMemo } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useGlossaryStore } from "../../stores/glossaryStore";
import { syncDictionaryTidy, useDictionaryTidyStore } from "../../stores/dictionaryTidyStore";
import { glossaryCanonicalTerms } from "../../utils/glossary";
import { dictionaryWordKey } from "../../utils/dictionaryWordKey.js";
import { CORRECTION_COMMON_WORDS } from "../../utils/correctionCommonWords.js";
import {
  computeTidyGroups,
  preselectedTidyItems,
  type TidyGroup,
} from "../../utils/dictionaryTidy";
import type { DictionaryListItem } from "../../utils/dictionaryList";

// Tidy up's checks for the Dictionary page: the list's items, heard/written,
// main's History aggregates, the bundled common-word list and the spellings
// never to remove (the glossary's and the snippet triggers), turned into
// groups (utils/dictionaryTidy.ts). The page shows the toolbar's count from it,
// so it runs whether or not Tidy up is open.

const LEARNER_COMMON_WORDS: ReadonlySet<string> = new Set(CORRECTION_COMMON_WORDS);

export interface DictionaryTidyModel {
  groups: TidyGroup[];
  /** The common-word list and History's aggregates have been read (or found unavailable). */
  ready: boolean;
  /** Keys of glossary spellings and snippet triggers. */
  protectedKeys: ReadonlySet<string>;
  /** Suggestions that start selected and weren't kept: the toolbar's count. */
  preselectedCount: number;
  /** Days of History the checks read, when they could. */
  days: number;
}

export function useDictionaryTidy(
  items: readonly DictionaryListItem[],
  usageAvailable: boolean
): DictionaryTidyModel {
  const aggregates = useDictionaryTidyStore((s) => s.aggregates);
  const inputsStatus = useDictionaryTidyStore((s) => s.inputsStatus);
  const days = useDictionaryTidyStore((s) => s.days);
  const commonWords = useDictionaryTidyStore((s) => s.commonWords);
  const kept = useDictionaryTidyStore((s) => s.kept);
  const glossaryRules = useGlossaryStore((s) => s.rules);
  const snippets = useSettingsStore((s) => s.snippets);

  useEffect(() => {
    syncDictionaryTidy();
  }, []);

  const protectedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const term of glossaryCanonicalTerms(glossaryRules)) {
      const key = dictionaryWordKey(term);
      if (key) keys.add(key);
    }
    for (const snippet of snippets ?? []) {
      const key = dictionaryWordKey(snippet?.trigger);
      if (key) keys.add(key);
    }
    return keys;
  }, [glossaryRules, snippets]);

  const historyAggregates = inputsStatus === "ready" ? aggregates : null;
  const groups = useMemo(
    () =>
      computeTidyGroups({
        words: items,
        usageAvailable,
        aggregates: historyAggregates,
        commonWords,
        learnerCommonWords: LEARNER_COMMON_WORDS,
        protectedKeys,
      }),
    [items, usageAvailable, historyAggregates, commonWords, protectedKeys]
  );

  const ready = commonWords !== null && inputsStatus !== "idle";
  const preselectedCount = useMemo(
    () => (ready ? preselectedTidyItems(groups).filter((item) => !kept.has(item.id)).length : 0),
    [ready, groups, kept]
  );

  return { groups, ready, protectedKeys, preselectedCount, days };
}

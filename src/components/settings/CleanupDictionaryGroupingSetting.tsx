import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Toggle } from "../ui/toggle";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDictionarySourcesStore } from "../../stores/dictionarySourcesStore";
import { useDictionaryUsageStore } from "../../stores/dictionaryUsageStore";
import {
  loadDictionaryCategoryWords,
  useDictionaryCategoriesStore,
} from "../../stores/dictionaryCategoriesStore";
import { useGlossaryStore } from "../../stores/glossaryStore";
import { glossaryCanonicalTerms } from "../../utils/glossary";
import { effectiveDictionaryCategory } from "../../utils/dictionaryCategories";
import { selectCleanupDictionary } from "../../utils/snippets";

// Settings › Dictation › Cleanup › "Group dictionary words by category"
// (`cleanupDictionaryGrouping`, off by default; mirrored in the Dictionary's
// "Where it goes"): the cleanup prompt keeps its dictionary sentence and then
// lists the words as "People: …; Work terms: …; Everyday words: …; Other: …",
// so the model knows a name is a name. It changes the prompt, so it's a
// choice. OpenWhispr Cloud builds its own prompt and gets the flat list.

const GROUP_KEYS = {
  people: "settingsPage.cleanupDictionaryGrouping.groups.people",
  work: "settingsPage.cleanupDictionaryGrouping.groups.work",
  everyday: "settingsPage.cleanupDictionaryGrouping.groups.everyday",
  other: "settingsPage.cleanupDictionaryGrouping.groups.other",
} as const;

export default function CleanupDictionaryGroupingSetting() {
  const { t } = useTranslation();
  const grouping = useSettingsStore((s) => s.cleanupDictionaryGrouping);
  const setGrouping = useSettingsStore((s) => s.setCleanupDictionaryGrouping);
  const cleanupMode = useSettingsStore((s) => s.cleanupMode);
  const customDictionary = useSettingsStore((s) => s.customDictionary);
  const snippets = useSettingsStore((s) => s.snippets);
  const wordSet = useSettingsStore((s) => s.cleanupDictionaryWords);
  const learned = useDictionarySourcesStore((s) => s.learned);
  const sourcesLoaded = useDictionarySourcesStore((s) => s.loaded);
  const pinned = useDictionarySourcesStore((s) => s.pinned);
  const missed = useDictionaryUsageStore((s) => s.missed);
  const ready = useDictionaryCategoriesStore((s) => s.ready);
  const stored = useDictionaryCategoriesStore((s) => s.stored);
  const commonWords = useDictionaryCategoriesStore((s) => s.commonWords);
  const glossaryRules = useGlossaryStore((s) => s.rules);
  const label = t("settingsPage.cleanupDictionaryGrouping.title");

  useEffect(() => {
    void loadDictionaryCategoryWords();
  }, []);

  // How the current word set would be grouped now (counts only).
  const groups = useMemo(() => {
    if (!ready) return null;
    const selection = selectCleanupDictionary(
      {
        customDictionary,
        snippets,
        cleanupDictionaryWords: wordSet,
        cleanupDictionaryGrouping: true,
      },
      {
        learned: sourcesLoaded ? learned : null,
        pinned,
        missed,
        categories: (word) => effectiveDictionaryCategory(word, stored, commonWords).category,
      },
      glossaryCanonicalTerms(glossaryRules)
    );
    return selection.groups ?? [];
  }, [
    ready,
    customDictionary,
    snippets,
    wordSet,
    sourcesLoaded,
    learned,
    pinned,
    missed,
    stored,
    commonWords,
    glossaryRules,
  ]);

  return (
    <div data-cleanup-dictionary-grouping>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">{label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
            {t("settingsPage.cleanupDictionaryGrouping.description")}
          </p>
        </div>
        <Toggle checked={grouping} onChange={setGrouping} ariaLabel={label} />
      </div>
      {grouping && groups && groups.length > 0 && (
        <p
          className="mt-2 text-[11px] leading-snug tabular-nums text-muted-foreground"
          data-cleanup-grouping-counts
        >
          {groups
            .map((entry) =>
              t(GROUP_KEYS[entry.group], {
                n: entry.words.length,
              })
            )
            .join(" · ")}
        </p>
      )}
      {grouping && !ready && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {t("settingsPage.cleanupDictionaryGrouping.unavailable")}
        </p>
      )}
      {grouping && cleanupMode === "openwhispr" && (
        <p
          className="mt-2 text-[11px] leading-snug text-muted-foreground"
          data-cleanup-grouping-cloud
        >
          {t("settingsPage.cleanupDictionaryGrouping.cloud")}
        </p>
      )}
    </div>
  );
}

import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
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
import {
  CLEANUP_DICTIONARY_SETTINGS,
  estimateDictionaryTokens,
  selectCleanupDictionary,
} from "../../utils/snippets";
import { CLEANUP_SET_KEYS } from "../dictionary/dictionaryLabels";

// Settings › Dictation › Cleanup › "Dictionary words in the cleanup prompt":
// which dictionary words a cleanup request carries, to experiment with. Each
// option shows how many words it would send now and roughly what the list
// costs (≈ characters ÷ 4, glossary spellings and snippet triggers included:
// those always go). The step history records the set each cleanup ran with.
// "All words except everyday words" reads the words' categories, so the
// common-word list the rules use loads when this row shows.

export default function CleanupDictionaryWordsSetting() {
  const { t } = useTranslation();
  const setting = useSettingsStore((s) => s.cleanupDictionaryWords);
  const setSetting = useSettingsStore((s) => s.setCleanupDictionaryWords);
  const customDictionary = useSettingsStore((s) => s.customDictionary);
  const snippets = useSettingsStore((s) => s.snippets);
  const learned = useDictionarySourcesStore((s) => s.learned);
  const sourcesLoaded = useDictionarySourcesStore((s) => s.loaded);
  const pinned = useDictionarySourcesStore((s) => s.pinned);
  const missed = useDictionaryUsageStore((s) => s.missed);
  const categoriesReady = useDictionaryCategoriesStore((s) => s.ready);
  const storedCategories = useDictionaryCategoriesStore((s) => s.stored);
  const commonWords = useDictionaryCategoriesStore((s) => s.commonWords);
  const glossaryRules = useGlossaryStore((s) => s.rules);
  const label = t("settingsPage.cleanupDictionary.title");

  useEffect(() => {
    void loadDictionaryCategoryWords();
  }, []);

  const options = useMemo(() => {
    const glossaryTerms = glossaryCanonicalTerms(glossaryRules);
    const categories = categoriesReady
      ? (word: string) => effectiveDictionaryCategory(word, storedCategories, commonWords).category
      : null;
    const sources = { learned: sourcesLoaded ? learned : null, pinned, missed, categories };
    return CLEANUP_DICTIONARY_SETTINGS.map((option) => {
      const selection = selectCleanupDictionary(
        { customDictionary, snippets, cleanupDictionaryWords: option },
        sources,
        glossaryTerms
      );
      return {
        option,
        words: selection.scope.words,
        tokens: estimateDictionaryTokens(selection.words),
        fallsBack: selection.scope.applied !== option,
      };
    });
  }, [
    customDictionary,
    snippets,
    learned,
    sourcesLoaded,
    pinned,
    missed,
    categoriesReady,
    storedCategories,
    commonWords,
    glossaryRules,
  ]);

  const fallsBack = (option: string) =>
    options.find((entry) => entry.option === option)?.fallsBack === true;

  return (
    <div>
      <p className="text-xs font-medium text-foreground">{label}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
        {t("settingsPage.cleanupDictionary.description")}
      </p>
      <div
        role="radiogroup"
        aria-label={label}
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {options.map(({ option, words, tokens, fallsBack: optionFallsBack }) => {
          const selected = option === setting;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              data-cleanup-dictionary={option}
              onClick={() => setSetting(option)}
              className={`rounded-md border px-3 py-2 text-start transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                selected
                  ? "border-primary bg-primary/10"
                  : "border-border/70 bg-surface-1/60 hover:border-border-hover"
              }`}
            >
              <span className="block text-xs font-semibold text-foreground">
                {t(CLEANUP_SET_KEYS[option])}
              </span>
              <span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">
                {optionFallsBack
                  ? t("settingsPage.cleanupDictionary.sendsAll")
                  : t("settingsPage.cleanupDictionary.count", { count: words, tokens })}
              </span>
            </button>
          );
        })}
      </div>
      {fallsBack("typedPinnedMissed") && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {t("settingsPage.cleanupDictionary.missedUnavailable")}
        </p>
      )}
      {fallsBack("noEveryday") && (
        <p
          className="mt-2 text-[11px] leading-snug text-muted-foreground"
          data-cleanup-categories-unavailable
        >
          {t("settingsPage.cleanupDictionary.categoriesUnavailable")}
        </p>
      )}
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        {t("settingsPage.cleanupDictionary.note")}
      </p>
    </div>
  );
}

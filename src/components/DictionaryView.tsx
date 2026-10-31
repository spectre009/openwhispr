import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ClipboardCheck,
  CornerDownLeft,
  Download,
  NotebookPen,
  PanelRight,
  Plus,
  Search,
  Sparkles,
  Upload,
  Wand2,
  X,
} from "./icons";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { PAGE_CONTENT_WIDTH_CLASS } from "./ui/pageWidth";
import { cn } from "./lib/utils";
import { CARD_SURFACE_CLASS } from "./ui/surfaces";
import { ConfirmDialog } from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useToast } from "./ui/useToast";
import SnippetsView from "./SnippetsView";
import GlossaryView from "./GlossaryView";
import GlossaryRuleDialog from "./GlossaryRuleDialog";
import DictionaryEmptyIllustration from "./DictionaryEmptyIllustration";
import DictionarySuggestions from "./DictionarySuggestions";
import DictionaryWordList from "./dictionary/DictionaryWordList";
import DictionaryWordDetail from "./dictionary/DictionaryWordDetail";
import DictionaryWhereItGoes from "./dictionary/DictionaryWhereItGoes";
import DictionaryTidy from "./dictionary/DictionaryTidy";
import { useDictionaryTidy } from "./dictionary/useDictionaryTidy";
import { CLEANUP_SET_KEYS, type CleanupInclusion } from "./dictionary/dictionaryLabels";
import { useDictionaryCoverage } from "./dictionary/useDictionaryCoverage";
import { getSettings, useSettingsStore } from "../stores/settingsStore";
import {
  setDictionaryPin,
  setDictionaryPins,
  useDictionarySourcesStore,
} from "../stores/dictionarySourcesStore";
import { useDictionaryUsageStore } from "../stores/dictionaryUsageStore";
import { glossaryRuleInput, useGlossaryStore } from "../stores/glossaryStore";
import { getAgentName } from "../utils/agentName";
import { parseDictionaryImportText } from "../helpers/dictionaryImport";
import { glossaryCanonicalTerms } from "../utils/glossary";
import { dictionaryWordKey } from "../utils/dictionaryWordKey.js";
import { selectCleanupDictionary } from "../utils/snippets";
import {
  DICTIONARY_FILTERS,
  DICTIONARY_SORTS,
  USAGE_FILTERS,
  USAGE_SORTS,
  buildDictionaryListItems,
  dictionaryFilterCounts,
  viewDictionaryList,
  type DictionaryFilter,
  type DictionaryListItem,
  type DictionarySort,
} from "../utils/dictionaryList";
import type { GlossaryRuleInput } from "../types/electron";

// The Dictionary page (its Dictionary tab; Glossary and Snippets are their own
// views). Auto-learn's suggestions, where the dictionary goes and what it
// costs, then the list: search, filters with counts, five sorts (send order
// shows where the speech model stops), selection with bulk actions, inline
// renames that keep a word's source, date and pin, and a word's detail beside
// the list (over it below 900 px). Coverage is what the current speech setup
// actually sends (useDictionaryCoverage); heard/written comes from local
// History (counts only). Tidy up (its toolbar button, with how many
// suggestions start selected) replaces the list with its checks and Undo.

const WIDE_PX = 900;

const FILTER_KEYS: Record<DictionaryFilter, string> = {
  all: "dictionary.list.filters.all",
  typed: "dictionary.list.filters.typed",
  learned: "dictionary.list.filters.learned",
  pinned: "dictionary.list.filters.pinned",
  notSent: "dictionary.list.filters.notSent",
  neverHeard: "dictionary.list.filters.neverHeard",
  addedThisWeek: "dictionary.list.filters.addedThisWeek",
};

const SORT_KEYS: Record<DictionarySort, string> = {
  sendOrder: "dictionary.list.sorts.sendOrder",
  recent: "dictionary.list.sorts.recent",
  alpha: "dictionary.list.sorts.alpha",
  mostHeard: "dictionary.list.sorts.mostHeard",
  leastHeard: "dictionary.list.sorts.leastHeard",
};

type ConfirmState =
  | { kind: "clearAll" }
  | { kind: "clearLearned"; words: string[] }
  | { kind: "remove"; words: string[] }
  | { kind: "merge"; from: string; into: string };

function useWideLayout(ref: RefObject<HTMLDivElement | null>): boolean {
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const width = node.getBoundingClientRect().width;
      if (width > 0) setWide(width >= WIDE_PX);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return wide;
}

export default function DictionaryView() {
  const { t, i18n } = useTranslation();
  const customDictionary = useSettingsStore((s) => s.customDictionary);
  const updateCustomDictionary = useSettingsStore((s) => s.updateCustomDictionary);
  const snippets = useSettingsStore((s) => s.snippets);
  const renameDictionaryWord = useSettingsStore((s) => s.renameDictionaryWord);
  const mergeDictionaryWords = useSettingsStore((s) => s.mergeDictionaryWords);
  const markDictionaryWordsTyped = useSettingsStore((s) => s.markDictionaryWordsTyped);
  const cleanupSetting = useSettingsStore((s) => s.cleanupDictionaryWords);
  const cleanupOn = useSettingsStore((s) => s.useCleanupModel);
  const entries = useDictionarySourcesStore((s) => s.entries);
  const learned = useDictionarySourcesStore((s) => s.learned);
  const sourcesLoaded = useDictionarySourcesStore((s) => s.loaded);
  const pinned = useDictionarySourcesStore((s) => s.pinned);
  const usageStatus = useDictionaryUsageStore((s) => s.status);
  const usageReason = useDictionaryUsageStore((s) => s.reason);
  const usageWords = useDictionaryUsageStore((s) => s.words);
  const missed = useDictionaryUsageStore((s) => s.missed);
  const glossaryRules = useGlossaryStore((s) => s.rules);
  const coverage = useDictionaryCoverage();
  const agentName = getAgentName();
  const { toast } = useToast();

  const [newWord, setNewWord] = useState("");
  const [showEmptyInput, setShowEmptyInput] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [filter, setFilter] = useState<DictionaryFilter>("all");
  const [sort, setSort] = useState<DictionarySort>("sendOrder");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedWord, setFocusedWord] = useState<string | null>(null);
  const [detailWord, setDetailWord] = useState<string | null>(null);
  const [editingWord, setEditingWord] = useState<string | null>(null);
  const [whereExpanded, setWhereExpanded] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [glossaryRule, setGlossaryRule] = useState<GlossaryRuleInput | null>(null);
  const [glossaryExisting, setGlossaryExisting] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wide = useWideLayout(containerRef);

  const pendingImportCount = useMemo(() => parseDictionaryImportText(bulkText).length, [bulkText]);

  // Same membership rule as agentNameDictionaryChanges: a stored spelling that
  // differs only by case is still the agent name's entry, so keep it hidden.
  const hiddenKeys = useMemo(() => {
    const key = dictionaryWordKey(agentName);
    return new Set(key ? [key] : []);
  }, [agentName]);

  const usageAvailable = usageStatus === "ready";
  const items = useMemo(
    () =>
      buildDictionaryListItems({
        words: customDictionary,
        entries,
        learned,
        pinned,
        coverage: coverage.entries,
        usage: usageAvailable ? usageWords : null,
        hiddenKeys,
      }),
    [
      customDictionary,
      entries,
      learned,
      pinned,
      coverage.entries,
      usageAvailable,
      usageWords,
      hiddenKeys,
    ]
  );
  const itemsByWord = useMemo(() => new Map(items.map((item) => [item.word, item])), [items]);
  const counts = useMemo(() => dictionaryFilterCounts(items), [items]);
  const learnedWords = useMemo(
    () => items.filter((item) => item.source === "learned").map((item) => item.word),
    [items]
  );

  // ─── Tidy up ───
  const tidy = useDictionaryTidy(items, usageAvailable);
  const [tidyOpen, setTidyOpen] = useState(false);
  const tidyButtonRef = useRef<HTMLButtonElement>(null);
  const openTidy = useCallback(() => {
    setDetailWord(null);
    setTidyOpen(true);
  }, []);
  const closeTidy = useCallback(() => {
    setTidyOpen(false);
    requestAnimationFrame(() => tidyButtonRef.current?.focus({ preventScroll: true }));
  }, []);
  // An emptied dictionary leaves Tidy up for the empty state.
  useEffect(() => {
    if (items.length === 0) setTidyOpen(false);
  }, [items.length]);

  const shownFilter = !usageAvailable && USAGE_FILTERS.has(filter) ? "all" : filter;
  const shownSort = !usageAvailable && USAGE_SORTS.has(sort) ? "sendOrder" : sort;
  const view = useMemo(
    () =>
      viewDictionaryList(items, {
        filter: shownFilter,
        sort: shownSort,
        search: deferredSearch,
        locale: i18n.language,
      }),
    [items, shownFilter, shownSort, deferredSearch, i18n.language]
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const allWords = useMemo(() => items.map((item) => item.word), [items]);

  // A word being renamed or merged, and what it becomes: the stored list can
  // arrive before the rename's answer, so the selection and the detail follow
  // it rather than lose it.
  const movingRef = useRef(new Map<string, string>());

  // Words that left the dictionary leave the selection and the detail.
  useEffect(() => {
    const follow = (word: string | null) => {
      if (!word || itemsByWord.has(word)) return word;
      const next = movingRef.current.get(word);
      return next && itemsByWord.has(next) ? next : null;
    };
    setSelected((current) => {
      if ([...current].every((word) => itemsByWord.has(word))) return current;
      return new Set([...current].map(follow).filter((word): word is string => !!word));
    });
    setDetailWord(follow);
    setFocusedWord(follow);
    setEditingWord((word) => (word && !itemsByWord.has(word) ? null : word));
  }, [itemsByWord]);

  // ─── Adding and importing ───
  const addWords = useCallback(
    (text: string): number => {
      const existing = new Set(customDictionary.map((w) => w.toLowerCase()));
      const words = parseDictionaryImportText(text).filter((w) => {
        if (existing.has(w.toLowerCase())) return false;
        existing.add(w.toLowerCase());
        return true;
      });
      if (words.length > 0) {
        updateCustomDictionary({ add: words });
      }
      return words.length;
    },
    [customDictionary, updateCustomDictionary]
  );

  const handleAdd = useCallback(() => {
    if (addWords(newWord) > 0) {
      setNewWord("");
      setShowEmptyInput(false);
      // The first word moves the input from the empty card to the top of the list.
      requestAnimationFrame(() => addInputRef.current?.focus());
    }
  }, [addWords, newWord]);

  const handleImport = useCallback(() => {
    addWords(bulkText);
    setBulkText("");
    setShowBulkImport(false);
  }, [addWords, bulkText]);

  const handleExport = useCallback(async () => {
    const result = await window.electronAPI?.exportDictionary?.(customDictionary);
    if (result?.error) {
      toast({
        title: t("dictionary.exportFailed"),
        description: result.error,
        variant: "destructive",
      });
    }
  }, [customDictionary, toast, t]);

  // ─── Selection ───
  const anchorRef = useRef<string | null>(null);
  const toggle = useCallback((word: string, options?: { range?: boolean }) => {
    const anchor = anchorRef.current;
    setSelected((current) => {
      const next = new Set(current);
      if (options?.range && anchor && anchor !== word) {
        const list = viewRef.current.items;
        const from = list.findIndex((item) => item.word === anchor);
        const to = list.findIndex((item) => item.word === word);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          for (let i = start; i <= end; i += 1) next.add(list[i].word);
          return next;
        }
      }
      if (next.has(word)) next.delete(word);
      else next.add(word);
      return next;
    });
    if (!options?.range || !anchor) anchorRef.current = word;
  }, []);
  const selectAll = useCallback(() => {
    setSelected(new Set(viewRef.current.items.map((item) => item.word)));
  }, []);
  const clearSelection = useCallback(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  // ─── Detail ───
  const detailRef = useRef(detailWord);
  detailRef.current = detailWord;
  const wideRef = useRef(wide);
  wideRef.current = wide;
  const focusWord = useCallback((word: string) => {
    setFocusedWord(word);
    // Beside the list, the detail follows the focused word.
    if (detailRef.current && wideRef.current) setDetailWord(word);
  }, []);
  const openWord = useCallback((word: string) => {
    setFocusedWord(word);
    setDetailWord(word);
  }, []);
  const closeDetail = useCallback(() => {
    const word = detailRef.current;
    setDetailWord(null);
    if (word) setFocusedWord(word);
    requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
  }, []);
  const escapeFromList = useCallback(() => {
    if (!detailRef.current) return false;
    closeDetail();
    return true;
  }, [closeDetail]);

  // ─── Changes ───
  const followRename = useCallback((from: string, to: string) => {
    setSelected((current) => {
      if (!current.has(from)) return current;
      const next = new Set(current);
      next.delete(from);
      next.add(to);
      return next;
    });
    setDetailWord((word) => (word === from ? to : word));
    setFocusedWord((word) => (word === from ? to : word));
    if (anchorRef.current === from) anchorRef.current = to;
  }, []);

  const rename = useCallback(
    async (from: string, to: string): Promise<boolean> => {
      movingRef.current.set(from, to.trim());
      const result = await renameDictionaryWord(from, to)
        .catch(() => null)
        .finally(() => movingRef.current.delete(from));
      if (result?.success) {
        setEditingWord(null);
        if (result.changed) followRename(from, result.word);
        return true;
      }
      if (result && !result.success && result.code === "EXISTS") {
        setEditingWord(null);
        setConfirm({ kind: "merge", from, into: result.existing ?? to });
        return true;
      }
      toast({ title: t("dictionary.rename.failed"), variant: "destructive" });
      return false;
    },
    [renameDictionaryWord, followRename, toast, t]
  );

  const merge = useCallback(
    async (from: string, into: string) => {
      movingRef.current.set(from, into);
      const result = await mergeDictionaryWords(from, into)
        .catch(() => null)
        .finally(() => movingRef.current.delete(from));
      if (result?.success) {
        followRename(from, result.word);
        toast({ title: t("dictionary.merge.done", { from, into: result.word }) });
      } else {
        toast({ title: t("dictionary.merge.failed"), variant: "destructive" });
      }
    },
    [mergeDictionaryWords, followRename, toast, t]
  );

  const removeWords = useCallback(
    (words: string[]) => {
      if (words.length === 0) return;
      updateCustomDictionary({ remove: words });
      const gone = new Set(words);
      setSelected((current) => new Set([...current].filter((word) => !gone.has(word))));
    },
    [updateCustomDictionary]
  );

  const markTyped = useCallback(
    async (words: string[]) => {
      const learnedOnes = words.filter((word) => itemsByWord.get(word)?.source === "learned");
      if (learnedOnes.length === 0) return;
      const changed = await markDictionaryWordsTyped(learnedOnes).catch(() => 0);
      if (changed > 0) toast({ title: t("dictionary.actions.markedTyped", { count: changed }) });
    },
    [itemsByWord, markDictionaryWordsTyped, toast, t]
  );

  const setPinned = useCallback((word: string, next: boolean) => {
    void setDictionaryPin(word, next);
  }, []);

  const startEdit = useCallback((word: string) => setEditingWord(word), []);
  const refocusList = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
  }, []);
  const cancelEdit = useCallback(() => {
    setEditingWord(null);
    refocusList();
  }, [refocusList]);

  const askRemove = useCallback(
    (word: string) => setConfirm({ kind: "remove", words: [word] }),
    []
  );

  const openGlossaryRule = useCallback(
    (word: string) => {
      const key = dictionaryWordKey(word);
      const existing = glossaryRules.find((rule) => dictionaryWordKey(rule.canonical) === key);
      setGlossaryExisting(!!existing);
      setGlossaryRule(
        existing
          ? glossaryRuleInput(existing)
          : {
              canonical: word,
              spellings: [{ text: "", scope: "anywhere" }],
              apps: [],
              enabled: true,
            }
      );
    },
    [glossaryRules]
  );

  // ─── Cleanup's word set, for the detail ───
  const cleanupSelection = useMemo(() => {
    const glossaryTerms = glossaryCanonicalTerms(glossaryRules);
    const selection = selectCleanupDictionary(
      { customDictionary, snippets, cleanupDictionaryWords: cleanupSetting },
      { learned: sourcesLoaded ? learned : null, pinned, missed },
      glossaryTerms
    );
    return {
      scope: selection.scope,
      keys: new Set(selection.words.map((word) => dictionaryWordKey(word))),
      glossaryKeys: new Set(glossaryTerms.map((term) => dictionaryWordKey(term))),
    };
  }, [
    customDictionary,
    snippets,
    cleanupSetting,
    sourcesLoaded,
    learned,
    pinned,
    missed,
    glossaryRules,
  ]);

  const cleanupInclusion = useCallback(
    (item: DictionaryListItem): CleanupInclusion => {
      const { scope, keys, glossaryKeys } = cleanupSelection;
      const set = t(CLEANUP_SET_KEYS[scope.setting]);
      // Policy-effective, as a dictation's cleanup decides it.
      if (!cleanupOn || getSettings().useCleanupModel !== true) {
        return { included: false, key: "dictionary.detail.cleanup.off" };
      }
      if (glossaryKeys.has(item.key)) {
        return { included: true, key: "dictionary.detail.cleanup.glossary" };
      }
      if (scope.applied === "all") {
        return scope.setting === "all"
          ? { included: true, key: "dictionary.detail.cleanup.all" }
          : { included: true, key: "dictionary.detail.cleanup.fallback", params: { set } };
      }
      if (scope.applied === "none")
        return { included: false, key: "dictionary.detail.cleanup.none" };
      if (keys.has(item.key)) {
        if (item.pinned)
          return { included: true, key: "dictionary.detail.cleanup.pinned", params: { set } };
        if (item.source === "manual") {
          return { included: true, key: "dictionary.detail.cleanup.typed", params: { set } };
        }
        return { included: true, key: "dictionary.detail.cleanup.missed", params: { set } };
      }
      return scope.applied === "typedPinned"
        ? { included: false, key: "dictionary.detail.cleanup.notTypedPinned", params: { set } }
        : { included: false, key: "dictionary.detail.cleanup.notMissed", params: { set } };
    },
    [cleanupSelection, cleanupOn, t]
  );

  const showSendOrder = useCallback(() => {
    setSort("sendOrder");
    setFilter("all");
    setSearch("");
    requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
  }, []);

  const confirmDialog = (() => {
    if (!confirm) return null;
    const close = (open: boolean) => {
      if (!open) setConfirm(null);
    };
    const base = {
      open: true,
      onOpenChange: close,
      cancelText: t("common.cancel"),
    };
    switch (confirm.kind) {
      case "clearAll":
        return (
          <ConfirmDialog
            {...base}
            title={t("dictionary.clearTitle")}
            description={t("dictionary.clearDescription")}
            confirmText={t("dictionary.clearAll")}
            onConfirm={() => removeWords(items.map((item) => item.word))}
            variant="destructive"
          />
        );
      case "clearLearned":
        return (
          <ConfirmDialog
            {...base}
            title={t("dictionary.learned.clearTitle")}
            description={t("dictionary.learned.clearDescription", { n: confirm.words.length })}
            confirmText={t("dictionary.learned.removeAll")}
            onConfirm={() => {
              removeWords(confirm.words);
              setFilter("all");
            }}
            variant="destructive"
          />
        );
      case "remove":
        return (
          <ConfirmDialog
            {...base}
            title={
              confirm.words.length === 1
                ? t("dictionary.remove.titleOne", { word: confirm.words[0] })
                : t("dictionary.remove.title", { count: confirm.words.length })
            }
            description={t("dictionary.remove.description", { count: confirm.words.length })}
            confirmText={t("dictionary.actions.remove")}
            onConfirm={() => removeWords(confirm.words)}
            variant="destructive"
          />
        );
      case "merge":
        return (
          <ConfirmDialog
            {...base}
            title={t("dictionary.merge.title", { into: confirm.into })}
            description={t("dictionary.merge.description", {
              from: confirm.from,
              into: confirm.into,
            })}
            confirmText={t("dictionary.merge.confirm")}
            onConfirm={() => void merge(confirm.from, confirm.into)}
          />
        );
      default:
        return null;
    }
  })();

  const userWordCount = items.length;

  const addWordInput = (
    <div className="relative">
      <Input
        dir="auto"
        ref={addInputRef}
        autoFocus={userWordCount === 0}
        placeholder={t("dictionary.addPlaceholder")}
        aria-label={t("dictionary.addWord")}
        value={newWord}
        onChange={(e) => setNewWord(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleAdd();
          if (e.key === "Escape" && userWordCount === 0) setShowEmptyInput(false);
        }}
        className="h-10 w-full rounded-full! pe-24 text-sm placeholder:text-foreground/45"
      />
      <div className="absolute end-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
        <button
          onClick={handleAdd}
          disabled={!newWord.trim()}
          aria-label={t("dictionary.addWord")}
          className="flex items-center gap-1 text-xs text-foreground/45 transition-colors enabled:hover:text-primary disabled:text-foreground/45"
        >
          {t("dictionary.add")}
          <CornerDownLeft size={12} />
        </button>
        <div className="h-4 w-px bg-foreground/10 dark:bg-white/8" />
        <button
          onClick={() => setShowBulkImport(true)}
          aria-label={t("dictionary.importWords")}
          className="text-foreground/45 transition-colors hover:text-foreground/60"
        >
          <Upload size={14} />
        </button>
      </div>
    </div>
  );

  const emptyState = (
    <div className="flex min-h-64 items-start px-6 py-6">
      <div className="relative z-10 w-full min-w-0 md:w-3/5">
        <h2 className="text-xl font-normal text-foreground">{t("dictionary.emptyTitle")}</h2>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-foreground/50 dark:text-foreground/65">
          {t("dictionary.emptyDescription", { agentName })}
        </p>
        {showEmptyInput ? (
          <div className="mt-6 max-w-md">{addWordInput}</div>
        ) : (
          <Button className="mt-6 px-5 font-normal" onClick={() => setShowEmptyInput(true)}>
            <Plus size={16} />
            {t("dictionary.addFirstWord")}
          </Button>
        )}
      </div>
      <DictionaryEmptyIllustration variant="dictionary" />
    </div>
  );

  const bulkImport = showBulkImport && (
    <div className="rounded-md border border-primary/30 dark:border-primary/40 px-3 pt-2.5 pb-2">
      <Textarea
        dir="auto"
        autoFocus
        value={bulkText}
        onChange={(e) => setBulkText(e.target.value)}
        placeholder={t("dictionary.importPlaceholder")}
        rows={4}
        className="min-h-[72px] resize-none border-0 shadow-none rounded-none bg-transparent p-0 text-xs text-foreground placeholder:text-foreground/45 hover:border-0 focus:border-0 focus:ring-0"
      />
      <div className="flex items-center justify-between pt-1.5">
        <p className="text-xs text-foreground/45">
          {t("dictionary.separateWithCommas")}
          {pendingImportCount > 0 && (
            <span className="text-success">
              {" • "}
              {t("dictionary.wordsReady", { count: pendingImportCount })}
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setBulkText("");
              setShowBulkImport(false);
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={handleImport} disabled={pendingImportCount === 0}>
            {t("dictionary.import")}
          </Button>
        </div>
      </div>
    </div>
  );

  const selectedWords = useMemo(
    () => allWords.filter((word) => selected.has(word)),
    [allWords, selected]
  );
  const anySelectedLearned = selectedWords.some(
    (word) => itemsByWord.get(word)?.source === "learned"
  );
  const anySelectedUnpinned = selectedWords.some((word) => !itemsByWord.get(word)?.pinned);
  const anySelectedPinned = selectedWords.some((word) => itemsByWord.get(word)?.pinned);

  const toolbar = (
    <div className="flex flex-col gap-2.5" data-dictionary-toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            dir="auto"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.preventDefault();
                setSearch("");
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                listRef.current?.focus();
              }
            }}
            placeholder={t("dictionary.list.searchPlaceholder")}
            aria-label={t("dictionary.list.searchLabel")}
            className="h-8 w-full rounded-lg border border-border/70 bg-background ps-8 pe-7 text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15 dark:border-white/10"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label={t("dictionary.list.clearSearch")}
              className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <Select value={shownSort} onValueChange={(value) => setSort(value as DictionarySort)}>
          <SelectTrigger
            className="h-8 w-auto min-w-[10rem] rounded-lg text-xs"
            aria-label={t("dictionary.list.sortLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DICTIONARY_SORTS.map((option) => (
              <SelectItem
                key={option}
                value={option}
                className="text-xs"
                disabled={!usageAvailable && USAGE_SORTS.has(option)}
              >
                {t(SORT_KEYS[option])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          ref={tidyButtonRef}
          size="sm"
          variant="outline"
          data-tidy-open
          onClick={openTidy}
          aria-label={
            tidy.preselectedCount > 0
              ? t("dictionary.tidy.buttonLabel", { count: tidy.preselectedCount })
              : undefined
          }
        >
          <ClipboardCheck size={12} />
          {t("dictionary.tidy.button")}
          {tidy.preselectedCount > 0 && (
            <span
              aria-hidden="true"
              className="rounded-full bg-primary px-1.5 text-[10.5px] font-semibold tabular-nums text-primary-foreground"
            >
              {tidy.preselectedCount}
            </span>
          )}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowBulkImport(true)}>
          <Upload size={12} />
          {t("dictionary.import")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void handleExport()}>
          <Download size={12} />
          {t("dictionary.list.export")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label={t("dictionary.list.filtersLabel")}
          className="flex flex-wrap gap-1.5"
        >
          {DICTIONARY_FILTERS.filter((option) => usageAvailable || !USAGE_FILTERS.has(option)).map(
            (option) => {
              const active = shownFilter === option;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={active}
                  data-dictionary-filter={option}
                  onClick={() => setFilter(option)}
                  title={
                    option === "neverHeard"
                      ? t("dictionary.list.filters.neverHeardHint")
                      : option === "notSent"
                        ? t("dictionary.list.filters.notSentHint")
                        : undefined
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/70 text-foreground/75 hover:border-foreground/30 dark:border-white/10"
                  )}
                >
                  {t(FILTER_KEYS[option])}
                  <span className="ms-1 tabular-nums text-muted-foreground">{counts[option]}</span>
                </button>
              );
            }
          )}
        </div>
        <div className="flex items-center gap-3">
          {shownFilter === "learned" && learnedWords.length > 0 ? (
            <button
              type="button"
              onClick={() => setConfirm({ kind: "clearLearned", words: learnedWords })}
              className="text-xs text-foreground/45 transition-colors hover:text-destructive/70"
            >
              {t("dictionary.learned.removeAll")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirm({ kind: "clearAll" })}
              className="text-xs text-foreground/45 transition-colors hover:text-destructive/70"
            >
              {t("dictionary.clearAll")}
            </button>
          )}
        </div>
      </div>
      {shownFilter === "learned" && learnedWords.length > 0 && (
        <p className="text-xs leading-relaxed text-foreground/45">{t("dictionary.learned.hint")}</p>
      )}
    </div>
  );

  const bulkBar = selectedWords.length > 0 && (
    <div className="pointer-events-none sticky bottom-4 z-10 mt-2 flex justify-center">
      <div
        role="toolbar"
        aria-label={t("dictionary.bulk.label", { count: selectedWords.length })}
        data-dictionary-bulk
        className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-popover px-3 py-2 text-xs shadow-xl dark:bg-surface-3"
      >
        <span className="me-1 font-semibold text-foreground">
          {t("dictionary.bulk.selected", { count: selectedWords.length })}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirm({ kind: "remove", words: selectedWords })}
        >
          {t("dictionary.actions.remove")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!anySelectedLearned}
          onClick={() => void markTyped(selectedWords)}
        >
          {t("dictionary.actions.markTyped")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!anySelectedUnpinned}
          onClick={() => void setDictionaryPins(selectedWords, true)}
        >
          {t("dictionary.actions.pin")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!anySelectedPinned}
          onClick={() => void setDictionaryPins(selectedWords, false)}
        >
          {t("dictionary.actions.unpin")}
        </Button>
        <Button size="sm" variant="ghost" onClick={clearSelection}>
          {t("dictionary.bulk.clear")}
        </Button>
      </div>
    </div>
  );

  const detailItem = detailWord ? itemsByWord.get(detailWord) : undefined;
  const overlay = !!detailItem && !wide;
  const detail = detailItem ? (
    <DictionaryWordDetail
      item={detailItem}
      coverage={coverage}
      cleanup={cleanupInclusion(detailItem)}
      words={allWords}
      itemsByWord={itemsByWord}
      usageUnavailableReason={usageAvailable ? null : (usageReason ?? usageStatus)}
      overlay={overlay}
      onClose={closeDetail}
      onOpenWord={openWord}
      onRename={rename}
      onRemove={askRemove}
      onSetPinned={setPinned}
      onMarkTyped={(word) => void markTyped([word])}
      onMakeGlossaryRule={openGlossaryRule}
    />
  ) : null;

  const list = (
    <div className={cn(CARD_SURFACE_CLASS, "overflow-hidden shadow-sm")}>
      {view.items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
          <p className="text-xs text-muted-foreground">{t("dictionary.list.noMatches")}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSearch("");
              setFilter("all");
            }}
          >
            {t("dictionary.list.clearFilters")}
          </Button>
        </div>
      ) : (
        <DictionaryWordList
          ref={listRef}
          items={view.items}
          dividers={view.dividers}
          selected={selected}
          focusedWord={focusedWord}
          openWord={detailWord}
          editingWord={editingWord}
          label={t("dictionary.list.label", { count: view.items.length })}
          onFocusWord={focusWord}
          onToggle={toggle}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
          onOpen={openWord}
          onStartEdit={startEdit}
          onCommitEdit={rename}
          onCancelEdit={cancelEdit}
          onEditSubmitted={refocusList}
          onSetPinned={setPinned}
          onRemove={askRemove}
          onEscape={escapeFromList}
        />
      )}
    </div>
  );

  return (
    <Tabs defaultValue="dictionary" className="flex flex-col h-full">
      {confirmDialog}
      <GlossaryRuleDialog
        rule={glossaryRule}
        onOpenChange={(open) => {
          if (!open) setGlossaryRule(null);
        }}
        notice={glossaryExisting ? t("dictionary.detail.glossaryExisting") : undefined}
      />

      <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "px-6 pt-6")}>
        <TabsList variant="pill">
          <TabsTrigger value="dictionary" variant="pill">
            <NotebookPen size={17} />
            {t("dictionary.tabDictionary")}
          </TabsTrigger>
          <TabsTrigger value="snippets" variant="pill">
            <PanelRight size={17} />
            {t("dictionary.tabSnippets")}
          </TabsTrigger>
          <TabsTrigger value="glossary" variant="pill">
            <Wand2 size={17} />
            {t("dictionary.tabGlossary")}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="dictionary" className="flex flex-1 min-h-0 mt-0">
        <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1">
          <div
            className="min-h-0 min-w-0 flex-1 overflow-y-auto"
            inert={overlay || undefined}
            aria-hidden={overlay || undefined}
            data-dictionary-scroller
          >
            <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "flex flex-col gap-3 px-6 py-5")}>
              {tidyOpen && userWordCount > 0 ? (
                <DictionaryTidy
                  items={items}
                  model={tidy}
                  usageAvailable={usageAvailable}
                  usageReason={usageAvailable ? null : (usageReason ?? usageStatus)}
                  onClose={closeTidy}
                />
              ) : (
                <>
                  {/* ─── Auto-learn's suggestions, and its setting ─── */}
                  <DictionarySuggestions />

                  {userWordCount > 0 && addWordInput}
                  {bulkImport}

                  {userWordCount > 0 && (
                    <DictionaryWhereItGoes
                      coverage={coverage}
                      expanded={whereExpanded}
                      onExpandedChange={setWhereExpanded}
                      onShowSendOrder={showSendOrder}
                    />
                  )}

                  {/* ─── Agent name (always recognized) ─── */}
                  {userWordCount > 0 && (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/3 px-4 py-3 dark:border-primary/20 dark:bg-primary/6">
                      <div className="flex items-center gap-2 min-w-0">
                        <Sparkles size={11} className="text-primary/70 shrink-0" />
                        <span dir="auto" className="text-xs font-medium text-primary truncate">
                          {agentName}
                        </span>
                      </div>
                      <span className="text-xs text-foreground/45 shrink-0">
                        {t("dictionary.agentDefault")}
                      </span>
                    </div>
                  )}

                  {userWordCount === 0 ? (
                    <div
                      className={cn(
                        CARD_SURFACE_CLASS,
                        "relative overflow-hidden rounded-3xl shadow-sm dark:bg-surface-window"
                      )}
                    >
                      {emptyState}
                    </div>
                  ) : (
                    <>
                      {toolbar}
                      {list}
                      {bulkBar}
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {detail &&
            (wide ? (
              <aside className="flex w-[380px] shrink-0 flex-col border-s border-border/70 dark:border-white/10">
                {detail}
              </aside>
            ) : (
              <div
                className="absolute inset-0 z-20 flex justify-end bg-background/60 backdrop-blur-[1px]"
                onClick={(event) => {
                  if (event.target === event.currentTarget) closeDetail();
                }}
              >
                <aside className="flex h-full w-full max-w-[440px] flex-col border-s border-border/70 shadow-xl dark:border-white/10">
                  {detail}
                </aside>
              </div>
            ))}
        </div>
      </TabsContent>

      <TabsContent value="snippets" className="flex-1 min-h-0 mt-0 overflow-y-auto">
        <SnippetsView />
      </TabsContent>

      <TabsContent value="glossary" className="flex-1 min-h-0 mt-0 overflow-y-auto">
        <GlossaryView />
      </TabsContent>
    </Tabs>
  );
}

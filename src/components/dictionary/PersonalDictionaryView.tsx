import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ClipboardCheck,
  Download,
  Plus,
  Search,
  Sparkles,
  Upload,
  Users,
  X,
} from "../icons";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { PAGE_CONTENT_WIDTH_CLASS } from "../ui/pageWidth";
import { cn } from "../lib/utils";
import { CARD_SURFACE_CLASS } from "../ui/surfaces";
import { ConfirmDialog } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useToast } from "../ui/useToast";
import GlossaryRuleDialog from "../GlossaryRuleDialog";
import DictionaryEmptyIllustration from "../DictionaryEmptyIllustration";
import DictionarySuggestions from "../DictionarySuggestions";
import DictionaryWordList from "./DictionaryWordList";
import DictionaryWordDetail from "./DictionaryWordDetail";
import DictionaryWhereItGoes from "./DictionaryWhereItGoes";
import DictionaryTidy from "./DictionaryTidy";
import DictionaryCategories from "./DictionaryCategories";
import { useDictionaryTidy } from "./useDictionaryTidy";
import { CLEANUP_SET_KEYS, type CleanupInclusion } from "./dictionaryLabels";
import { CATEGORY_DOT_CLASS, CATEGORY_NAME_KEYS } from "./categoryStyles";
import { useDictionaryCoverage } from "./useDictionaryCoverage";
import { getListsOwnerRevision, getSettings, useSettingsStore } from "../../stores/settingsStore";
import {
  reorderDictionaryPins,
  setDictionaryPin,
  setDictionaryPins,
  useDictionarySourcesStore,
} from "../../stores/dictionarySourcesStore";
import { useDictionaryUsageStore } from "../../stores/dictionaryUsageStore";
import { loadCommonWords, useDictionaryTidyStore } from "../../stores/dictionaryTidyStore";
import {
  setDictionaryCategories,
  syncDictionaryCategories,
  useDictionaryCategoriesStore,
} from "../../stores/dictionaryCategoriesStore";
import { cancelCategoryReview } from "../../stores/dictionaryCategoryReviewStore";
import {
  DICTIONARY_CATEGORIES,
  effectiveDictionaryCategory,
  type DictionaryCategory,
} from "../../utils/dictionaryCategories";
import { glossaryRuleInput, useGlossaryStore } from "../../stores/glossaryStore";
import { getAgentName } from "../../utils/agentName";
import { glossaryCanonicalTerms } from "../../utils/glossary";
import { dictionaryWordKey } from "../../utils/dictionaryWordKey.js";
import { selectCleanupDictionary } from "../../utils/snippets";
import { glossaryOfferFor } from "../../utils/dictionaryGlossaryOffer";
import {
  clearDictionaryWordRequest,
  useDictionaryWordRequest,
} from "../../utils/openDictionaryWord";
import GlossaryOfferNotice from "./GlossaryOfferNotice";
import DictionaryHintOrderMenu from "./DictionaryHintOrderMenu";
import {
  DICTIONARY_CATEGORY_FILTERS,
  DICTIONARY_FILTERS,
  DICTIONARY_SORTS,
  USAGE_FILTERS,
  USAGE_SORTS,
  buildDictionaryListItems,
  dictionaryCategoryFilterCounts,
  dictionaryFilterCounts,
  viewDictionaryList,
  type DictionaryCategoryFilter,
  type DictionaryFilter,
  type DictionaryListItem,
  type DictionarySort,
} from "../../utils/dictionaryList";
import type { DictionarySpeechVariant, GlossaryRuleInput } from "../../types/electron";

// The personal dictionary (Dictionary v2): the Dictionary tab's body while
// the open list holds only the user's own words (Personal, or All words
// without teammates' words; the whole page without the shared dictionary).
// DictionaryView owns the page around it: the list picker, the add field and
// bulk import (passed in, laid out here), the import menu (Import a list,
// Import from Dragon) its toolbar's Import opens, the share popover, the Clear
// all dialog and the actions on the stored dictionary (Undo for a bulk removal,
// "a list still has it"). The page remounts it when the lists change hands
// (listsOwner), and a handler from before does nothing. Auto-learn's
// suggestions, where the dictionary goes and what it costs, then the list:
// search, filters with counts, five sorts (send order
// shows where the speech model stops), selection with bulk actions, inline
// renames that keep a word's source, date and pin, and a word's detail beside
// the list (over it below 900 px). Coverage is what the current speech setup
// actually sends (useDictionaryCoverage); heard/written comes from local
// History (counts only). Tidy up (its toolbar button, with how many
// suggestions start selected) replaces the list with its checks and Undo.
// In send order with no filter or search, the list has two sections:
// "Always sent first" (the pins in pin order, which a drag, Alt+↑/↓ or Move
// to top reorders through main, optimistically, announced to screen
// readers) and "Everything else" (ordered by evidence or as added: the
// order setting, mirrored here).

const WIDE_PX = 900;

const FILTER_KEYS: Record<DictionaryFilter, string> = {
  all: "dictionary.list.filters.all",
  typed: "dictionary.list.filters.typed",
  learned: "dictionary.list.filters.learned",
  pinned: "dictionary.list.filters.pinned",
  notSent: "dictionary.list.filters.notSent",
  speechMisses: "dictionary.list.filters.speechMisses",
  neverHeard: "dictionary.list.filters.neverHeard",
  addedThisWeek: "dictionary.list.filters.addedThisWeek",
};

const FILTER_HINT_KEYS: Partial<Record<DictionaryFilter, string>> = {
  notSent: "dictionary.list.filters.notSentHint",
  speechMisses: "dictionary.list.filters.speechMissesHint",
  neverHeard: "dictionary.list.filters.neverHeardHint",
};

const SORT_KEYS: Record<DictionarySort, string> = {
  sendOrder: "dictionary.list.sorts.sendOrder",
  recent: "dictionary.list.sorts.recent",
  alpha: "dictionary.list.sorts.alpha",
  mostHeard: "dictionary.list.sorts.mostHeard",
  leastHeard: "dictionary.list.sorts.leastHeard",
};

type ConfirmState =
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

export interface PersonalDictionaryViewProps {
  /** The user's words this list shows (Personal hides words moved into a team list). */
  words: readonly string[];
  /** The page's add field (with its list chip) and its bulk import, laid out here. */
  addField: ReactNode;
  bulkImport: ReactNode;
  /** The empty state's "Add your first word": focuses the add field. */
  onAddFirstWord: () => void;
  /** Opens the bulk import. */
  onImport: () => void;
  /**
   * Wraps the toolbar's Import button in the page's import menu (Import a
   * list, Import from Dragon); without it the button opens the bulk import.
   */
  importMenu?: (trigger: ReactElement) => ReactNode;
  /** Exports the personal dictionary. */
  onExport: () => void;
  /** Asks to clear the whole list (the page's confirm dialog). */
  onClearAll: () => void;
  /** Removes words after this view confirmed it; a bulk removal offers Undo. */
  onRemoveWords: (words: string[]) => void;
  /**
   * Shares the selection into team lists (the page's share popover), once
   * there is a list to share to; `onShared` clears the selection once all went.
   */
  onShare?: (words: string[], anchor: HTMLElement, onShared: () => void) => void;
  shareOpen?: boolean;
  /** Opens Settings at a destination (`page#settingId`): "Sort into categories" links there. */
  onOpenSettings?: (destination: string) => void;
  /**
   * The lists owner (getListsOwnerRevision) the page opened under. Main writes
   * renames, merges, pins and categories into the active account's list, so a
   * handler from before the lists changed hands does nothing.
   */
  listsOwner?: number;
}

export default function PersonalDictionaryView({
  words,
  addField,
  bulkImport,
  onAddFirstWord,
  onImport,
  importMenu,
  onExport,
  onClearAll,
  onRemoveWords,
  onShare,
  shareOpen = false,
  onOpenSettings,
  listsOwner,
}: PersonalDictionaryViewProps) {
  const { t, i18n } = useTranslation();
  const customDictionary = useSettingsStore((s) => s.customDictionary);
  const sharedDictionaryHints = useSettingsStore((s) => s.sharedDictionaryHints);
  const snippets = useSettingsStore((s) => s.snippets);
  const renameDictionaryWord = useSettingsStore((s) => s.renameDictionaryWord);
  const mergeDictionaryWords = useSettingsStore((s) => s.mergeDictionaryWords);
  const markDictionaryWordsTyped = useSettingsStore((s) => s.markDictionaryWordsTyped);
  const cleanupSetting = useSettingsStore((s) => s.cleanupDictionaryWords);
  const cleanupGrouping = useSettingsStore((s) => s.cleanupDictionaryGrouping);
  const cleanupOn = useSettingsStore((s) => s.useCleanupModel);
  const hintOrder = useSettingsStore((s) => s.dictionaryHintOrder);
  const entries = useDictionarySourcesStore((s) => s.entries);
  const learned = useDictionarySourcesStore((s) => s.learned);
  const sourcesLoaded = useDictionarySourcesStore((s) => s.loaded);
  const pinned = useDictionarySourcesStore((s) => s.pinned);
  const usageStatus = useDictionaryUsageStore((s) => s.status);
  const usageReason = useDictionaryUsageStore((s) => s.reason);
  const usageWords = useDictionaryUsageStore((s) => s.words);
  const missed = useDictionaryUsageStore((s) => s.missed);
  const storedCategories = useDictionaryCategoriesStore((s) => s.stored);
  const categoryWords = useDictionaryCategoriesStore((s) => s.commonWords);
  const categoriesReady = useDictionaryCategoriesStore((s) => s.ready);
  const glossaryRules = useGlossaryStore((s) => s.rules);
  const coverage = useDictionaryCoverage();
  const agentName = getAgentName();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [filter, setFilter] = useState<DictionaryFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<DictionaryCategoryFilter>("all");
  const [sort, setSort] = useState<DictionarySort>("sendOrder");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedWord, setFocusedWord] = useState<string | null>(null);
  const [detailWord, setDetailWord] = useState<string | null>(null);
  const [editingWord, setEditingWord] = useState<string | null>(null);
  const [whereExpanded, setWhereExpanded] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [glossaryRule, setGlossaryRule] = useState<GlossaryRuleInput | null>(null);
  const [glossaryNotice, setGlossaryNotice] = useState<ReactNode>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wide = useWideLayout(containerRef);

  // Same membership rule as agentNameDictionaryChanges: a stored spelling that
  // differs only by case is still the agent name's entry, so keep it hidden.
  const hiddenKeys = useMemo(() => {
    const key = dictionaryWordKey(agentName);
    return new Set(key ? [key] : []);
  }, [agentName]);

  const usageAvailable = usageStatus === "ready";
  // Categories: main's stored choices and the rules (the common-word list,
  // shared with Tidy up), read when the page opens.
  useEffect(() => {
    syncDictionaryCategories({ loadWords: true });
  }, []);
  const categoryOf = useCallback(
    (word: string) => effectiveDictionaryCategory(word, storedCategories, categoryWords),
    [storedCategories, categoryWords]
  );
  const items = useMemo(
    () =>
      buildDictionaryListItems({
        words: [...words],
        entries,
        learned,
        pinned,
        coverage: coverage.entries,
        usage: usageAvailable ? usageWords : null,
        hiddenKeys,
        categoryOf,
      }),
    [
      words,
      entries,
      learned,
      pinned,
      coverage.entries,
      usageAvailable,
      usageWords,
      hiddenKeys,
      categoryOf,
    ]
  );
  const itemsByWord = useMemo(() => new Map(items.map((item) => [item.word, item])), [items]);
  const itemsByWordRef = useRef(itemsByWord);
  itemsByWordRef.current = itemsByWord;
  const counts = useMemo(() => dictionaryFilterCounts(items), [items]);
  const categoryCounts = useMemo(() => dictionaryCategoryFilterCounts(items), [items]);
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
    setCategoriesOpen(false);
    setTidyOpen(true);
  }, []);
  const closeTidy = useCallback(() => {
    setTidyOpen(false);
    requestAnimationFrame(() => tidyButtonRef.current?.focus({ preventScroll: true }));
  }, []);
  // ─── Sort into categories ───
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const categoriesButtonRef = useRef<HTMLButtonElement>(null);
  const openCategories = useCallback(() => {
    setDetailWord(null);
    setTidyOpen(false);
    setCategoriesOpen(true);
  }, []);
  const closeCategories = useCallback(() => {
    setCategoriesOpen(false);
    requestAnimationFrame(() => categoriesButtonRef.current?.focus({ preventScroll: true }));
  }, []);
  // A review in flight belongs to the page: leaving it stops waiting.
  useEffect(() => () => cancelCategoryReview(), []);
  // An emptied dictionary leaves Tidy up and the categories for the empty state.
  useEffect(() => {
    if (items.length === 0) {
      setTidyOpen(false);
      setCategoriesOpen(false);
    }
  }, [items.length]);

  const shownFilter = !usageAvailable && USAGE_FILTERS.has(filter) ? "all" : filter;
  const shownSort = !usageAvailable && USAGE_SORTS.has(sort) ? "sendOrder" : sort;
  const view = useMemo(
    () =>
      viewDictionaryList(items, {
        filter: shownFilter,
        sort: shownSort,
        search: deferredSearch,
        category: categoryFilter,
        locale: i18n.language,
      }),
    [items, shownFilter, shownSort, deferredSearch, categoryFilter, i18n.language]
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
  // A handler from before the lists changed hands (the page remounts this
  // view then) does nothing: main would write into the next account's list.
  const ownsLists = useCallback(
    () => listsOwner === undefined || getListsOwnerRevision() === listsOwner,
    [listsOwner]
  );
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
      if (!ownsLists()) return false;
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
    [ownsLists, renameDictionaryWord, followRename, toast, t]
  );

  const merge = useCallback(
    async (from: string, into: string) => {
      if (!ownsLists()) return;
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
    [ownsLists, mergeDictionaryWords, followRename, toast, t]
  );

  const removeWords = useCallback(
    (removed: string[]) => {
      if (removed.length === 0) return;
      onRemoveWords(removed);
      const gone = new Set(removed);
      setSelected((current) => new Set([...current].filter((word) => !gone.has(word))));
    },
    [onRemoveWords]
  );

  const markTyped = useCallback(
    async (words: string[]) => {
      if (!ownsLists()) return;
      const learnedOnes = words.filter((word) => itemsByWord.get(word)?.source === "learned");
      if (learnedOnes.length === 0) return;
      const changed = await markDictionaryWordsTyped(learnedOnes).catch(() => 0);
      if (changed > 0) toast({ title: t("dictionary.actions.markedTyped", { count: changed }) });
    },
    [ownsLists, itemsByWord, markDictionaryWordsTyped, toast, t]
  );

  const setPinned = useCallback(
    (word: string, next: boolean) => {
      if (ownsLists()) void setDictionaryPin(word, next);
    },
    [ownsLists]
  );
  const pinWords = useCallback(
    (words: string[], next: boolean) => {
      if (ownsLists()) void setDictionaryPins(words, next);
    },
    [ownsLists]
  );

  // ─── Pin order ("Always sent first") ───
  // A screen reader hears where a moved word went; the same text twice is
  // still announced (the counter remounts the line).
  const [announcement, setAnnouncement] = useState<{ text: string; n: number } | null>(null);
  const announce = useCallback(
    (text: string) => setAnnouncement((current) => ({ text, n: (current?.n ?? 0) + 1 })),
    []
  );
  // `index` is the word's new place among the listed pins; the assistant's
  // hidden name, if pinned, keeps its own place in the order main stores.
  const movePinned = useCallback(
    async (word: string, index: number) => {
      if (!ownsLists()) return;
      const { items: shown, pinnedCount } = viewRef.current;
      const section = [...new Set(shown.slice(0, pinnedCount ?? 0).map((item) => item.key))];
      const key = itemsByWordRef.current.get(word)?.key;
      const from = key ? section.indexOf(key) : -1;
      if (!key || from < 0) return;
      const target = Math.max(0, Math.min(section.length - 1, index));
      if (target === from) return;
      section.splice(from, 1);
      section.splice(target, 0, key);
      const listed = new Set(section);
      let next = 0;
      const order = [...useDictionarySourcesStore.getState().pinned].map((pinnedKey) =>
        listed.has(pinnedKey) ? section[next++] : pinnedKey
      );
      announce(t("dictionary.pins.moved", { word, position: target + 1 }));
      const result = await reorderDictionaryPins(order);
      if (!result.success) {
        announce(t("dictionary.pins.reorderFailed"));
        toast({ title: t("dictionary.pins.reorderFailed"), variant: "destructive" });
      }
    },
    [ownsLists, announce, t, toast]
  );
  // "+ Pin a word": pinning is the row's ☆; this takes the keyboard to the
  // first word that isn't pinned.
  const focusUnpinned = useCallback(() => {
    const { items: shown, pinnedCount } = viewRef.current;
    const first = shown[pinnedCount ?? 0] ?? shown[0];
    if (first) setFocusedWord(first.word);
    requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
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
    (word: string, variant?: DictionarySpeechVariant) => {
      const rules = useGlossaryStore.getState().rules;
      if (variant) {
        // From what speech wrote: the spelling's scope follows its evidence.
        const offer = glossaryOfferFor(rules, word, variant.spelling, {
          keptInFinal: variant.keptInFinal,
          commonWords: useDictionaryTidyStore.getState().commonWords,
        });
        setGlossaryNotice(
          <GlossaryOfferNotice
            offer={offer}
            spelling={variant.spelling}
            keptInFinal={variant.keptInFinal}
          />
        );
        setGlossaryRule(offer.rule);
        return;
      }
      const key = dictionaryWordKey(word);
      const existing = rules.find((rule) => dictionaryWordKey(rule.canonical) === key);
      setGlossaryNotice(existing ? t("dictionary.detail.glossaryExisting") : null);
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
    [t]
  );

  // The common-word list a speech variant's scope reads (loaded once).
  useEffect(() => {
    if (detailWord) void loadCommonWords();
  }, [detailWord]);

  // "Open in Dictionary" (History's dictionary card): that word's panel, once
  // it's in the list.
  const wordRequest = useDictionaryWordRequest((state) => state.word);
  const wordRequestId = useDictionaryWordRequest((state) => state.request);
  useEffect(() => {
    if (!wordRequest) return;
    const key = dictionaryWordKey(wordRequest);
    const target =
      itemsByWord.get(wordRequest) ?? items.find((candidate) => candidate.key === key) ?? null;
    if (!target) return;
    clearDictionaryWordRequest();
    setTidyOpen(false);
    setCategoriesOpen(false);
    setSearch("");
    setFilter("all");
    setCategoryFilter("all");
    setFocusedWord(target.word);
    setDetailWord(target.word);
  }, [wordRequest, wordRequestId, itemsByWord, items]);
  // A request the page never found leaves with it.
  useEffect(() => () => clearDictionaryWordRequest(), []);

  // ─── Cleanup's word set, for the detail ───
  const cleanupSelection = useMemo(() => {
    const glossaryTerms = glossaryCanonicalTerms(glossaryRules);
    const selection = selectCleanupDictionary(
      {
        customDictionary,
        snippets,
        sharedDictionaryHints,
        cleanupDictionaryWords: cleanupSetting,
        cleanupDictionaryGrouping: cleanupGrouping,
      },
      {
        learned: sourcesLoaded ? learned : null,
        pinned,
        missed,
        categories: categoriesReady ? (word: string) => categoryOf(word).category : null,
      },
      glossaryTerms
    );
    return {
      scope: selection.scope,
      grouped: !!selection.groups,
      keys: new Set(selection.words.map((word) => dictionaryWordKey(word))),
      glossaryKeys: new Set(glossaryTerms.map((term) => dictionaryWordKey(term))),
    };
  }, [
    customDictionary,
    snippets,
    sharedDictionaryHints,
    cleanupSetting,
    cleanupGrouping,
    sourcesLoaded,
    learned,
    pinned,
    missed,
    categoriesReady,
    categoryOf,
    glossaryRules,
  ]);

  const cleanupInclusion = useCallback(
    (item: DictionaryListItem): CleanupInclusion => {
      const { scope, keys, glossaryKeys, grouped } = cleanupSelection;
      const set = t(CLEANUP_SET_KEYS[scope.setting]);
      // Listed under its category's group when the prompt is grouped.
      const withGroup = (inclusion: CleanupInclusion): CleanupInclusion =>
        inclusion.included && grouped
          ? {
              ...inclusion,
              grouped: t("dictionary.detail.cleanup.grouped", {
                group: t(
                  item.category
                    ? CATEGORY_NAME_KEYS[item.category]
                    : "dictionary.detail.cleanup.groupOther"
                ),
              }),
            }
          : inclusion;
      // Policy-effective, as a dictation's cleanup decides it.
      if (!cleanupOn || getSettings().useCleanupModel !== true) {
        return { included: false, key: "dictionary.detail.cleanup.off" };
      }
      if (glossaryKeys.has(item.key)) {
        return withGroup({ included: true, key: "dictionary.detail.cleanup.glossary" });
      }
      if (scope.applied === "all") {
        if (scope.setting === "all") {
          return withGroup({ included: true, key: "dictionary.detail.cleanup.all" });
        }
        return withGroup({
          included: true,
          key:
            scope.setting === "noEveryday"
              ? "dictionary.detail.cleanup.fallbackCategories"
              : "dictionary.detail.cleanup.fallback",
          params: { set },
        });
      }
      if (scope.applied === "none")
        return { included: false, key: "dictionary.detail.cleanup.none" };
      if (scope.applied === "noEveryday") {
        return keys.has(item.key)
          ? withGroup({
              included: true,
              key: "dictionary.detail.cleanup.notEveryday",
              params: { set },
            })
          : { included: false, key: "dictionary.detail.cleanup.everyday", params: { set } };
      }
      if (keys.has(item.key)) {
        if (item.pinned)
          return withGroup({
            included: true,
            key: "dictionary.detail.cleanup.pinned",
            params: { set },
          });
        if (item.source === "manual") {
          return withGroup({
            included: true,
            key: "dictionary.detail.cleanup.typed",
            params: { set },
          });
        }
        return withGroup({
          included: true,
          key: "dictionary.detail.cleanup.missed",
          params: { set },
        });
      }
      return scope.applied === "typedPinned"
        ? { included: false, key: "dictionary.detail.cleanup.notTypedPinned", params: { set } }
        : { included: false, key: "dictionary.detail.cleanup.notMissed", params: { set } };
    },
    [cleanupSelection, cleanupOn, t]
  );

  // A category picked from a row's or the panel's pill: the user's choice;
  // Automatic removes it.
  const setCategory = useCallback(
    (word: string, category: DictionaryCategory | null) => {
      if (!ownsLists()) return;
      void setDictionaryCategories([{ word, category, source: "user" }]).then((result) => {
        if (!result.success) {
          toast({ title: t("dictionary.categories.setFailed"), variant: "destructive" });
        }
      });
    },
    [ownsLists, toast, t]
  );

  const showSendOrder = useCallback(() => {
    setSort("sendOrder");
    setFilter("all");
    setCategoryFilter("all");
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

  const emptyState = (
    <div className="flex min-h-64 items-start px-6 py-6">
      <div className="relative z-10 w-full min-w-0 md:w-3/5">
        <h2 className="text-xl font-normal text-foreground">{t("dictionary.emptyTitle")}</h2>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-foreground/50 dark:text-foreground/65">
          {t("dictionary.emptyDescription", { agentName })}
        </p>
        <Button className="mt-6 px-5 font-normal" onClick={onAddFirstWord}>
          <Plus size={16} />
          {t("dictionary.addFirstWord")}
        </Button>
      </div>
      <DictionaryEmptyIllustration variant="dictionary" />
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
  // "Set category" for the selection: the user's choice (Automatic: removed).
  const setSelectedCategory = async (category: DictionaryCategory | null) => {
    if (selectedWords.length === 0 || !ownsLists()) return;
    const result = await setDictionaryCategories(
      selectedWords.map((word) => ({ word, category, source: "user" as const }))
    );
    if (result.success) {
      toast({
        title: category
          ? t("dictionary.categories.bulk.done", {
              count: selectedWords.length - result.refused,
              category: t(CATEGORY_NAME_KEYS[category]),
            })
          : t("dictionary.categories.bulk.doneAutomatic", {
              count: selectedWords.length - result.refused,
            }),
      });
    } else {
      toast({ title: t("dictionary.categories.setFailed"), variant: "destructive" });
    }
  };

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
          ref={categoriesButtonRef}
          size="sm"
          variant="outline"
          data-categories-open
          onClick={openCategories}
          aria-label={t("dictionary.categories.buttonLabel", {
            count: categoriesReady ? categoryCounts.unsorted : 0,
          })}
        >
          <span aria-hidden="true">🗂</span>
          {t("dictionary.categories.button")}
          {categoriesReady && categoryCounts.unsorted > 0 && (
            <span
              aria-hidden="true"
              data-categories-unsorted-count
              className="rounded-full bg-muted px-1.5 text-[10.5px] font-semibold tabular-nums text-foreground/80 dark:bg-white/10"
            >
              {categoryCounts.unsorted}
            </span>
          )}
        </Button>
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
        {importMenu ? (
          importMenu(
            <Button size="sm" variant="outline" data-dictionary-import-menu>
              <Upload size={12} />
              {t("dictionary.importMenu")}
              <ChevronDown size={11} aria-hidden="true" />
            </Button>
          )
        ) : (
          <Button size="sm" variant="outline" onClick={onImport}>
            <Upload size={12} />
            {t("dictionary.importWords")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          aria-label={t("dictionary.exportDictionary")}
          onClick={onExport}
        >
          <Download size={12} />
          {t("dictionary.list.export")}
        </Button>
      </div>
      <div
        role="group"
        aria-label={t("dictionary.categories.filtersLabel")}
        data-dictionary-category-filters
        className="flex flex-wrap items-center gap-1.5"
      >
        <span aria-hidden="true" className="me-1 text-[11px] text-muted-foreground">
          {t("dictionary.categories.filtersTitle")}
        </span>
        {DICTIONARY_CATEGORY_FILTERS.map((option) => {
          const active = categoryFilter === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              data-dictionary-category-filter={option}
              onClick={() => setCategoryFilter(option)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                active
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/70 text-foreground/75 hover:border-foreground/30 dark:border-white/10"
              )}
            >
              {option !== "all" && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    CATEGORY_DOT_CLASS[option]
                  )}
                />
              )}
              {option === "all" ? t(FILTER_KEYS.all) : t(CATEGORY_NAME_KEYS[option])}
              <span className="ms-0.5 tabular-nums text-muted-foreground">
                {option === "all" || categoriesReady ? categoryCounts[option] : "—"}
              </span>
            </button>
          );
        })}
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
                    FILTER_HINT_KEYS[option] ? t(FILTER_HINT_KEYS[option] as string) : undefined
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
              aria-label={t("dictionary.clearAll")}
              onClick={onClearAll}
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
        {onShare && (
          <Button
            size="sm"
            variant="outline"
            aria-haspopup="dialog"
            aria-expanded={shareOpen}
            data-bulk-share
            onClick={(event) => onShare(selectedWords, event.currentTarget, clearSelection)}
          >
            <Users size={12} />
            {t("dictionary.shared.selection.shareWith")}
            <ChevronDown size={11} aria-hidden="true" />
          </Button>
        )}
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
          onClick={() => pinWords(selectedWords, true)}
        >
          {t("dictionary.actions.pin")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!anySelectedPinned}
          onClick={() => pinWords(selectedWords, false)}
        >
          {t("dictionary.actions.unpin")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" data-bulk-set-category>
              {t("dictionary.categories.bulk.set")}
              <ChevronDown size={11} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            {DICTIONARY_CATEGORIES.map((option) => (
              <DropdownMenuItem
                key={option}
                data-bulk-category={option}
                className="text-xs"
                onSelect={() => void setSelectedCategory(option)}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "me-1.5 inline-block h-1.5 w-1.5 rounded-full",
                    CATEGORY_DOT_CLASS[option]
                  )}
                />
                {t(CATEGORY_NAME_KEYS[option])}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-bulk-category="auto"
              className="text-xs"
              onSelect={() => void setSelectedCategory(null)}
            >
              {t("dictionary.categories.bulk.automatic")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
      onSetCategory={setCategory}
      onMakeGlossaryRule={openGlossaryRule}
    />
  ) : null;

  // Send order over the whole list: "Always sent first", then "Everything else".
  const sectioned = view.pinnedCount !== null;
  // How "Everything else" is ordered: as added, by evidence, or by evidence
  // once there are usage counts (stored order until then).
  const orderState =
    hintOrder === "added"
      ? "added"
      : coverage.evidence || usageAvailable
        ? "evidence"
        : "evidenceUnavailable";
  const pinnedHeader = sectioned && (
    <div
      data-dictionary-pins-header
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border/60 px-3 py-2.5 dark:border-white/10"
    >
      <h3 className="text-[13px] font-semibold text-foreground">
        <span aria-hidden="true" className="me-1.5">
          📌
        </span>
        {t("dictionary.pins.sectionTitle")}
      </h3>
      <span className="text-[11.5px] text-muted-foreground">
        {t("dictionary.pins.sectionHint")}
      </span>
      <span className="grow" />
      <button
        type="button"
        data-pin-a-word
        onClick={focusUnpinned}
        className="rounded text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {t("dictionary.pins.pinAWord")}
      </button>
    </div>
  );
  const sections = sectioned
    ? {
        pinnedCount: view.pinnedCount ?? 0,
        emptyPinned: t("dictionary.pins.empty"),
        restHeader: (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-semibold text-foreground">
              {t("dictionary.order.restTitle")}
            </span>
            <span
              className="text-[11.5px] text-muted-foreground"
              data-dictionary-order-description={orderState}
            >
              {t(`dictionary.order.${orderState}`)}
            </span>
            <span className="grow" />
            <DictionaryHintOrderMenu />
          </div>
        ),
      }
    : null;

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
              setCategoryFilter("all");
            }}
          >
            {t("dictionary.list.clearFilters")}
          </Button>
        </div>
      ) : (
        <>
          {pinnedHeader}
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
            onSetCategory={setCategory}
            sections={sections}
            onMovePinned={movePinned}
          />
        </>
      )}
      <div role="status" aria-live="polite" className="sr-only" data-dictionary-pin-announcer>
        {announcement && <span key={announcement.n}>{announcement.text}</span>}
      </div>
    </div>
  );

  return (
    <>
      {confirmDialog}
      <GlossaryRuleDialog
        rule={glossaryRule}
        onOpenChange={(open) => {
          if (!open) setGlossaryRule(null);
        }}
        notice={glossaryNotice ?? undefined}
      />

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
            ) : categoriesOpen && userWordCount > 0 ? (
              <DictionaryCategories
                items={items}
                onClose={closeCategories}
                onOpenSettings={onOpenSettings}
              />
            ) : (
              <>
                {/* ─── Auto-learn's suggestions, and its setting ─── */}
                <DictionarySuggestions />

                {addField}
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
    </>
  );
}

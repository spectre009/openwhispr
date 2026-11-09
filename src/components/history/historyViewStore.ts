import { create } from "zustand";
import type { HistoryReviewRequest, HistoryReviewStage } from "../../types/electron";

// What the History view is showing, kept outside the view so it survives
// switching to another view and back, and so "Open in History" can select a
// dictation before the view mounts. Review drafts live here too: nothing is
// written to main before Save, and a draft survives switching rows and views.
// Only the view preferences (the panes' split, playback speed, "back 2 s on
// resume" and the list's folded state) are kept in localStorage.

export type HistoryKindFilter = "all" | "failed" | "cleanupChanged" | "flagged" | "dictionaryFixed";

/** The wide layout's reference pane. */
export type HistoryReferenceTab = "heard" | "steps" | "dictionary";
/** What "What speech heard" compares the heard text with. */
export type HistoryHeardView = "heard" | "afterSpeech" | "correction";
/** The user's own choice for the list beside a wide detail; null: it folds while reviewing. */
export type HistoryListChoice = "collapsed" | "expanded" | null;

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5] as const;
export const SPLIT_MIN = 0.3;
export const SPLIT_MAX = 0.7;

const PREF_KEYS = {
  split: "historyView.split",
  rate: "historyView.playbackRate",
  backOnResume: "historyView.backOnResume",
  listChoice: "historyView.listChoice",
} as const;

function readPref(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string | null) {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not kept: the preference lasts until the window closes.
  }
}

export const clampSplit = (ratio: number) =>
  Number.isFinite(ratio) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio)) : 0.5;

function storedSplit(): number {
  const raw = readPref(PREF_KEYS.split);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? clampSplit(value) : 0.5;
}

function storedRate(): number {
  const value = Number(readPref(PREF_KEYS.rate));
  return (PLAYBACK_RATES as readonly number[]).includes(value) ? value : 1;
}

function storedListChoice(): HistoryListChoice {
  const value = readPref(PREF_KEYS.listChoice);
  return value === "collapsed" || value === "expanded" ? value : null;
}

/** A 👎 review being written: the form's fields, until it's saved or cancelled. */
export interface ReviewDraft {
  id: number;
  /** Main's opaque owner tag: drafts never cross sign-ins. */
  owner: string;
  /** The version of the row the form was opened on; a new one drops the draft. */
  revision: string;
  stage: HistoryReviewStage | null;
  expectedText: string;
  note: string;
  /** What the form started from, to tell whether anything changed. */
  initial: { stage: HistoryReviewStage | null; expectedText: string; note: string };
}

export type ReviewDraftFields = Pick<ReviewDraft, "stage" | "expectedText" | "note">;

interface HistoryViewState {
  /** The search field's text; the list searches it after a short pause. */
  query: string;
  filter: HistoryKindFilter;
  /** The App filter (an exe name), combined with `filter`. */
  app: string | null;
  /** "Show in History" from a dictionary word: rows whose raw or final text has it. */
  dictionaryWord: string | null;
  selectedId: number | null;
  /** Narrow layouts: the detail is open over the list. */
  detailOpen: boolean;
  /** Bumped by every "Open in History", so the view reveals the row even when already selected. */
  openRequest: number;
  /** Step cards show what changed, or the plain text. */
  textView: "changes" | "text";
  /** Review drafts by `reviewDraftKey(owner, id)`. */
  drafts: Record<string, ReviewDraft>;
  /** "Review last dictation" waiting for the view to apply it. */
  pendingReview: HistoryReviewRequest | null;
  /** The dictation the review hotkey opened, while its review is open. */
  hotkeyReview: { id: number; requestId: number; focused: boolean } | null;
  /** A notice over the view: the review hotkey found no dictation to open. */
  notice: "lastNotFound" | null;
  /** The view shows no dictation until one is picked (the hotkey found none). */
  holdSelection: boolean;
  referenceTab: HistoryReferenceTab;
  heardView: HistoryHeardView;
  /** The start pane's share of the wide layout's two panes (kept). */
  splitRatio: number;
  /** The player's speed (kept). */
  playbackRate: number;
  /** Resuming after a pause starts 2 s earlier (kept). */
  backOnResume: boolean;
  /** The list's folded state the user chose (kept). */
  listChoice: HistoryListChoice;
}

export const useHistoryViewStore = create<HistoryViewState>()(() => ({
  query: "",
  filter: "all",
  app: null,
  dictionaryWord: null,
  selectedId: null,
  detailOpen: false,
  openRequest: 0,
  textView: "changes",
  drafts: {},
  pendingReview: null,
  hotkeyReview: null,
  notice: null,
  holdSelection: false,
  referenceTab: "heard",
  heardView: "heard",
  splitRatio: storedSplit(),
  playbackRate: storedRate(),
  backOnResume: readPref(PREF_KEYS.backOnResume) !== "false",
  listChoice: storedListChoice(),
}));

export function setHistoryTextView(textView: "changes" | "text") {
  useHistoryViewStore.setState({ textView });
}

export function setHistoryReferenceTab(referenceTab: HistoryReferenceTab) {
  useHistoryViewStore.setState({ referenceTab });
}

export function setHistoryHeardView(heardView: HistoryHeardView) {
  useHistoryViewStore.setState({ heardView });
}

export function setHistorySplitRatio(ratio: number, { persist = true } = {}) {
  const splitRatio = clampSplit(ratio);
  useHistoryViewStore.setState({ splitRatio });
  if (persist) writePref(PREF_KEYS.split, String(splitRatio));
}

export function setHistoryPlaybackRate(playbackRate: number) {
  if (!(PLAYBACK_RATES as readonly number[]).includes(playbackRate)) return;
  useHistoryViewStore.setState({ playbackRate });
  writePref(PREF_KEYS.rate, String(playbackRate));
}

export function setHistoryBackOnResume(backOnResume: boolean) {
  useHistoryViewStore.setState({ backOnResume });
  writePref(PREF_KEYS.backOnResume, String(backOnResume));
}

export function setHistoryListChoice(listChoice: HistoryListChoice) {
  useHistoryViewStore.setState({ listChoice });
  writePref(PREF_KEYS.listChoice, listChoice);
}

export function setHistoryQuery(query: string) {
  useHistoryViewStore.setState({ query });
}

/** "All" clears the App filter and a dictionary word too. */
export function setHistoryFilter(filter: HistoryKindFilter) {
  useHistoryViewStore.setState(
    filter === "all" ? { filter, app: null, dictionaryWord: null } : { filter }
  );
}

export function setHistoryApp(app: string | null) {
  useHistoryViewStore.setState({ app });
}

export function setHistoryDictionaryWord(dictionaryWord: string | null) {
  useHistoryViewStore.setState({ dictionaryWord });
}

/**
 * "Show in History" from a dictionary word: only the dictations with that
 * word, the other search and filters cleared, the newest one shown.
 */
export function showHistoryForDictionaryWord(word: string) {
  useHistoryViewStore.setState((state) => ({
    query: "",
    filter: "all",
    app: null,
    dictionaryWord: word,
    selectedId: null,
    detailOpen: false,
    openRequest: state.openRequest + 1,
    holdSelection: false,
    notice: null,
  }));
}

export function clearHistorySearch() {
  useHistoryViewStore.setState({ query: "", filter: "all", app: null, dictionaryWord: null });
}

export function selectHistoryItem(id: number | null, { open = false } = {}) {
  useHistoryViewStore.setState((state) => ({
    selectedId: id,
    detailOpen: id === null ? false : open || state.detailOpen,
    ...(id === null ? {} : { holdSelection: false, notice: null }),
  }));
}

export function setHistoryDetailOpen(detailOpen: boolean) {
  useHistoryViewStore.setState({ detailOpen });
}

/** "Open in History": select the dictation and show its detail, whatever the list shows. */
export function requestHistoryItem(id: number) {
  useHistoryViewStore.setState((state) => ({
    selectedId: id,
    detailOpen: true,
    openRequest: state.openRequest + 1,
    holdSelection: false,
    notice: null,
  }));
}

export function setHistoryNotice(notice: HistoryViewState["notice"]) {
  useHistoryViewStore.setState({ notice });
}

// ─── Reviews ────────────────────────────────────────────────────────────

export function reviewDraftKey(owner: string, id: number): string {
  return `${owner}:${id}`;
}

export const sameStage = (a: HistoryReviewStage | null, b: HistoryReviewStage | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.seq === b.seq);

/** Whether the user changed anything since the form opened. */
export function isReviewDraftChanged(draft: ReviewDraft | null | undefined): boolean {
  if (!draft) return false;
  return (
    !sameStage(draft.stage, draft.initial.stage) ||
    draft.expectedText !== draft.initial.expectedText ||
    draft.note !== draft.initial.note
  );
}

export function startReviewDraft(
  owner: string,
  id: number,
  revision: string,
  fields: ReviewDraftFields
) {
  const key = reviewDraftKey(owner, id);
  useHistoryViewStore.setState((state) => ({
    drafts: { ...state.drafts, [key]: { id, owner, revision, ...fields, initial: { ...fields } } },
  }));
}

export function updateReviewDraft(key: string, fields: Partial<ReviewDraftFields>) {
  useHistoryViewStore.setState((state) => {
    const draft = state.drafts[key];
    return draft ? { drafts: { ...state.drafts, [key]: { ...draft, ...fields } } } : {};
  });
}

export function discardReviewDraft(key: string) {
  useHistoryViewStore.setState((state) => {
    if (!(key in state.drafts)) return {};
    const { [key]: _discarded, ...drafts } = state.drafts;
    return { drafts };
  });
}

/** "Review last dictation" arrived: the view applies it (asking first if a draft elsewhere changed). */
export function requestHistoryReview(request: HistoryReviewRequest) {
  useHistoryViewStore.setState({ pendingReview: request });
}

/** Opens the requested dictation with its review, or says none was found. */
export function applyHistoryReview(request: HistoryReviewRequest) {
  useHistoryViewStore.setState((state) =>
    request.id === null
      ? {
          pendingReview: null,
          hotkeyReview: null,
          selectedId: null,
          detailOpen: false,
          holdSelection: true,
          notice: "lastNotFound",
        }
      : {
          pendingReview: null,
          hotkeyReview: { id: request.id, requestId: request.requestId, focused: false },
          selectedId: request.id,
          detailOpen: true,
          openRequest: state.openRequest + 1,
          holdSelection: false,
          notice: null,
        }
  );
}

export function dropHistoryReviewRequest() {
  useHistoryViewStore.setState({ pendingReview: null });
}

export function markHotkeyReviewFocused(requestId: number) {
  useHistoryViewStore.setState((state) =>
    state.hotkeyReview?.requestId === requestId
      ? { hotkeyReview: { ...state.hotkeyReview, focused: true } }
      : {}
  );
}

/** The hotkey-opened review was saved or cancelled. */
export function endHotkeyReview() {
  useHistoryViewStore.setState({ hotkeyReview: null });
}

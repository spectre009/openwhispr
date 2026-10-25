import { create } from "zustand";
import type { HistoryReviewRequest, HistoryReviewStage } from "../../types/electron";

// What the History view is showing, kept outside the view so it survives
// switching to another view and back, and so "Open in History" can select a
// dictation before the view mounts. Review drafts live here too: nothing is
// written to main before Save, and a draft survives switching rows and views.

export type HistoryKindFilter = "all" | "failed" | "cleanupChanged" | "flagged";

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
}

export const useHistoryViewStore = create<HistoryViewState>()(() => ({
  query: "",
  filter: "all",
  app: null,
  selectedId: null,
  detailOpen: false,
  openRequest: 0,
  textView: "changes",
  drafts: {},
  pendingReview: null,
  hotkeyReview: null,
  notice: null,
  holdSelection: false,
}));

export function setHistoryTextView(textView: "changes" | "text") {
  useHistoryViewStore.setState({ textView });
}

export function setHistoryQuery(query: string) {
  useHistoryViewStore.setState({ query });
}

/** "All" clears the App filter too. */
export function setHistoryFilter(filter: HistoryKindFilter) {
  useHistoryViewStore.setState(filter === "all" ? { filter, app: null } : { filter });
}

export function setHistoryApp(app: string | null) {
  useHistoryViewStore.setState({ app });
}

export function clearHistorySearch() {
  useHistoryViewStore.setState({ query: "", filter: "all", app: null });
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

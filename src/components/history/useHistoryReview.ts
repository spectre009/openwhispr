import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { stepKindLabel } from "../ui/transcriptionStepLabels";
import type {
  HistoryFeedback,
  HistoryFeedbackSaveRequest,
  HistoryItemResult,
  HistoryReviewStage,
  HistoryVerdict,
  TranscriptionStepRecord,
} from "../../types/electron";
import {
  discardReviewDraft,
  endHotkeyReview,
  isReviewDraftChanged,
  markHotkeyReviewFocused,
  reviewDraftKey,
  sameStage,
  startReviewDraft,
  updateReviewDraft,
  useHistoryViewStore,
  type ReviewDraft,
  type ReviewDraftFields,
} from "./historyViewStore";

// One dictation's review in the History detail: 👍 saves at once, 👎 opens
// "What went wrong?" as a draft kept in the view's store until Save or
// Cancel. Main decides the owner, checks the revision the form was opened on
// and refuses while history isn't durable. The review hotkey's request opens
// the form with 👎 preselected; saving or Esc there also hides the panel.

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** As main's cap (dictationFeedback.js); a longer note is cut there. */
export const MAX_REVIEW_NOTE_CHARS = 500;
type LoadedItem = Extract<HistoryItemResult, { success: true }>;

export interface ReviewConfirm {
  title: string;
  description: string;
  confirmText: string;
  cancelText?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export interface ReviewStageChip {
  stage: HistoryReviewStage;
  label: string;
  /** The digit that picks it (1–9, 0 for "Not sure"); null past nine. */
  digit: string | null;
}

/**
 * The steps a review can blame: the row's recorded steps in order (a kind
 * recorded twice shows twice, by seq), then Delivery, then Not sure.
 */
export function reviewStageChips(
  steps: TranscriptionStepRecord[],
  t: Translate
): ReviewStageChip[] {
  const chips = [
    ...steps.map((step, seq) => ({
      stage: { kind: step.kind, seq },
      label: stepKindLabel(step, t),
    })),
    { stage: { kind: "delivery", seq: null }, label: t("historyView.review.stages.delivery") },
  ].map((chip, index) => ({ ...chip, digit: index < 9 ? String(index + 1) : null }));
  chips.push({
    stage: { kind: "unsure", seq: null },
    label: t("historyView.review.stages.unsure"),
    digit: "0",
  });
  return chips;
}

/** Whether a saved review says more than its verdict. */
const hasDetails = (feedback: HistoryFeedback | null) =>
  !!feedback && (!!feedback.stage || !!feedback.expectedText || !!feedback.note);

// Typing, picking from a list or composing text: the review's letters and digits stay out.
const TYPING_TARGET =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="combobox"], [role="textbox"]';
export const OPEN_DIALOG =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/** Whether a key event's target is in the History view (or nothing has focus) and the view isn't covered. */
export function historyViewHas(target: EventTarget | null): boolean {
  const root = document.querySelector("[data-history-view]");
  if (!root || root.closest("[inert]")) return false;
  if (!(target instanceof Node)) return false;
  return root.contains(target) || target === document.body || target === document.documentElement;
}

export type ReviewError = "historyOff" | "failed";
export type ReviewNotice = "draftDropped" | "stale";

export interface HistoryReviewController {
  canReview: boolean;
  /** Pressed state: the open draft's (bad), else the saved verdict. */
  verdict: HistoryVerdict | null;
  draft: ReviewDraft | null;
  feedback: HistoryFeedback | null;
  /** The review hotkey opened this dictation's review: Save & close, and Esc hides the panel. */
  hotkey: boolean;
  saving: boolean;
  error: ReviewError | null;
  notice: ReviewNotice | null;
  chips: ReviewStageChip[];
  chipsRef: RefObject<HTMLDivElement | null>;
  rateGood: () => void;
  openBad: () => void;
  pickStage: (stage: HistoryReviewStage) => void;
  setExpectedText: (text: string) => void;
  setNote: (note: string) => void;
  save: () => void;
  cancel: () => void;
  remove: () => void;
  dismissNotice: () => void;
}

export function useHistoryReview({
  result,
  reload,
  confirm,
  onHidePanel,
}: {
  result: LoadedItem;
  /** Re-reads the dictation (it changed under the review). */
  reload: () => void;
  confirm: (options: ReviewConfirm) => void;
  /** Runs before the review hotkey's flow hides the panel (stops playback). */
  onHidePanel?: () => void;
}): HistoryReviewController {
  const { t } = useTranslation();
  const { item, revision, owner } = result;
  const id = item.id;
  const key = owner ? reviewDraftKey(owner, id) : null;
  const draft = useHistoryViewStore((state) => (key ? (state.drafts[key] ?? null) : null));
  const hotkeyReview = useHistoryViewStore((state) => state.hotkeyReview);
  const hotkey = hotkeyReview?.id === id;
  // What this view saved or deleted since main last answered; main's answer wins once it changes.
  const [local, setLocal] = useState<{ from: LoadedItem; feedback: HistoryFeedback | null }>();
  const feedback = local?.from === result ? local.feedback : (result.feedback ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ReviewError | null>(null);
  const [notice, setNotice] = useState<ReviewNotice | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const canReview =
    !!owner && !!revision && (item.status === "completed" || item.status === "failed");
  const finalText = item.status === "completed" ? item.text : "";
  const chips = useMemo(
    () => reviewStageChips(result.status === "captured" ? result.steps : [], t),
    [result, t]
  );

  const fieldsFrom = useCallback(
    (saved: HistoryFeedback | null): ReviewDraftFields =>
      saved?.verdict === "bad"
        ? {
            stage: saved.stage,
            expectedText: saved.expectedText ?? finalText,
            note: saved.note ?? "",
          }
        : { stage: null, expectedText: finalText, note: "" },
    [finalText]
  );

  // True once the first chip actually has focus.
  const focusFirstChip = useCallback(() => {
    const chip = chipsRef.current?.querySelector<HTMLElement>("button");
    if (!chip) return false;
    chip.focus();
    return chip.ownerDocument.activeElement === chip;
  }, []);

  const hidePanel = () => {
    onHidePanel?.();
    void window.electronAPI?.hideControlPanel?.();
  };

  // A retry (or any rewrite) made a new version: the draft was about the old one.
  useEffect(() => {
    if (key && draft && draft.revision !== revision) {
      discardReviewDraft(key);
      setNotice("draftDropped");
    }
  }, [key, draft, revision]);

  // Opened by the review hotkey: 👎 preselected as an unsaved draft, the first
  // step chip focused (marked done only once it has focus; the form may still
  // be moving into place).
  useEffect(() => {
    if (!hotkeyReview || hotkeyReview.id !== id || !canReview || !owner || !revision) return;
    if (!draft) {
      startReviewDraft(owner, id, revision, fieldsFrom(feedback));
      return;
    }
    if (hotkeyReview.focused) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      if (focusFirstChip()) markHotkeyReviewFocused(hotkeyReview.requestId);
      else if (++tries < 10) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [hotkeyReview, id, canReview, owner, revision, draft, feedback, fieldsFrom, focusFirstChip]);

  const submit = async (request: HistoryFeedbackSaveRequest, closeAfter: boolean) => {
    const saveFeedback = window.electronAPI?.saveHistoryFeedback;
    if (!saveFeedback) {
      setError("failed");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const reply = await saveFeedback(request);
      if (reply?.success) {
        setLocal({ from: result, feedback: reply.feedback });
        setNotice(null);
        // The hotkey's request ends first, so its draft isn't opened again.
        if (closeAfter) endHotkeyReview();
        if (key) discardReviewDraft(key);
        if (closeAfter) hidePanel();
        return;
      }
      const code = reply && "code" in reply ? reply.code : "FAILED";
      if (code === "HISTORY_OFF") setError("historyOff");
      else if (code === "STALE") {
        if (key) discardReviewDraft(key);
        setNotice("stale");
        reload();
      } else if (code === "NOT_FOUND") reload();
      else setError("failed");
    } catch {
      setError("failed");
    } finally {
      setSaving(false);
    }
  };

  const rateGood = () => {
    if (!canReview || !revision || saving) return;
    // 👍 again takes the rating back.
    if (!draft && feedback?.verdict === "good") {
      void removeNow();
      return;
    }
    const go = () =>
      void submit(
        { id, revision, verdict: "good", stage: null, expectedText: null, note: null },
        hotkey
      );
    if (hasDetails(feedback) || isReviewDraftChanged(draft)) {
      confirm({
        title: t("historyView.review.confirmGood.title"),
        description: t("historyView.review.confirmGood.description"),
        confirmText: t("historyView.review.confirmGood.confirm"),
        onConfirm: go,
      });
      return;
    }
    go();
  };

  const openBad = () => {
    if (!canReview || !owner || !revision) return;
    if (!draft) startReviewDraft(owner, id, revision, fieldsFrom(feedback));
    requestAnimationFrame(focusFirstChip);
  };

  const pickStage = (stage: HistoryReviewStage) => {
    if (!key || !draft) return;
    updateReviewDraft(key, { stage: sameStage(draft.stage, stage) ? null : stage });
  };

  const save = () => {
    if (!draft || saving) return;
    void submit(
      {
        id,
        revision: draft.revision,
        verdict: "bad",
        stage: draft.stage,
        expectedText: draft.expectedText,
        note: draft.note,
      },
      hotkey
    );
  };

  const cancel = () => {
    if (!draft && !hotkey) return;
    const finish = () => {
      if (hotkey) endHotkeyReview();
      if (key) discardReviewDraft(key);
      setError(null);
      if (hotkey) hidePanel();
    };
    if (isReviewDraftChanged(draft)) {
      confirm({
        title: t("historyView.review.confirmDiscard.title"),
        description: t("historyView.review.confirmDiscard.description"),
        confirmText: t("historyView.review.confirmDiscard.confirm"),
        cancelText: t("historyView.review.confirmDiscard.keep"),
        destructive: true,
        onConfirm: finish,
      });
      return;
    }
    finish();
  };

  const removeNow = async () => {
    try {
      const reply = await window.electronAPI?.deleteHistoryFeedback?.(id);
      if (reply?.success) setLocal({ from: result, feedback: null });
      else setError("failed");
    } catch {
      setError("failed");
    }
  };

  const remove = () => {
    if (!hasDetails(feedback)) {
      void removeNow();
      return;
    }
    confirm({
      title: t("historyView.review.confirmDelete.title"),
      description: t("historyView.review.confirmDelete.description"),
      confirmText: t("historyView.review.confirmDelete.confirm"),
      destructive: true,
      onConfirm: () => void removeNow(),
    });
  };

  const controller: HistoryReviewController = {
    canReview,
    verdict: draft ? "bad" : (feedback?.verdict ?? null),
    draft,
    feedback,
    hotkey,
    saving,
    error,
    notice,
    chips,
    chipsRef,
    rateGood,
    openBad,
    pickStage,
    setExpectedText: (text) => key && updateReviewDraft(key, { expectedText: text }),
    setNote: (note) => key && updateReviewDraft(key, { note }),
    save,
    cancel,
    remove,
    dismissNotice: () => setNotice(null),
  };

  useReviewShortcuts(controller);
  return controller;
}

/**
 * The History view's review keys: G 👍, B 👎, 1–9 and 0 pick a step,
 * Ctrl+Enter saves, Esc cancels. Never while typing (Ctrl+Enter excepted
 * inside the review's own fields), in a select, under a dialog or while
 * composing text; ↑/↓ stay with the list.
 */
function useReviewShortcuts(controller: HistoryReviewController) {
  const latest = useRef(controller);
  useLayoutEffect(() => {
    latest.current = controller;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (!historyViewHas(event.target)) return;
      if (document.querySelector(OPEN_DIALOG)) return;
      const review = latest.current;
      const target = event.target instanceof Element ? event.target : null;
      const typing = !!target?.closest(TYPING_TARGET);
      const inForm = !!target?.closest("[data-review-form]");

      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey) {
        if (review.draft && (!typing || inForm)) {
          event.preventDefault();
          review.save();
        }
        return;
      }
      if (typing || event.altKey || event.ctrlKey || event.metaKey) return;

      if (event.key === "Escape") {
        if (review.draft || review.hotkey) {
          event.preventDefault();
          review.cancel();
        }
        return;
      }
      const letter = event.key.toLowerCase();
      if (letter === "g") {
        event.preventDefault();
        review.rateGood();
      } else if (letter === "b") {
        event.preventDefault();
        review.openBad();
      } else if (/^[0-9]$/.test(event.key) && review.draft) {
        const chip = review.chips.find((candidate) => candidate.digit === event.key);
        if (!chip) return;
        event.preventDefault();
        review.pickStage(chip.stage);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

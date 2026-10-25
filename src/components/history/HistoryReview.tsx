import type { KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AutoGrowTextarea } from "../ui/AutoGrowTextarea";
import { Keyboard, Loader2, ThumbsDown, ThumbsUp, X } from "../icons";
import { getCachedPlatform } from "../../utils/platform";
import { sameStage } from "./historyViewStore";
import { MAX_REVIEW_NOTE_CHARS, type HistoryReviewController } from "./useHistoryReview";

// The review's pieces in the History detail: the 👍 / 👎 buttons in its
// header, the "What went wrong?" form, a saved review, and the banner over a
// dictation the review hotkey opened.

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      dir="ltr"
      className="rounded border border-border/70 bg-background px-1 font-mono text-[10px] leading-4 text-muted-foreground dark:border-white/15"
    >
      {children}
    </kbd>
  );
}

const saveChord = () => (getCachedPlatform() === "darwin" ? "⌘ Enter" : "Ctrl+Enter");

// A field's Esc leaves the field; the next one closes the form.
function blurOnEscape(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.blur();
}

export function ReviewButtons({ review }: { review: HistoryReviewController }) {
  const { t } = useTranslation();
  const button = (verdict: "good" | "bad") => {
    const pressed = review.verdict === verdict;
    const Icon = verdict === "good" ? ThumbsUp : ThumbsDown;
    return (
      <button
        type="button"
        aria-pressed={pressed}
        disabled={!review.canReview || review.saving}
        onClick={verdict === "good" ? review.rateGood : review.openBad}
        title={t(verdict === "good" ? "historyView.review.rateGood" : "historyView.review.rateBad")}
        aria-label={t(
          verdict === "good" ? "historyView.review.rateGood" : "historyView.review.rateBad"
        )}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50",
          pressed
            ? verdict === "good"
              ? "border-success/60 bg-success/12 text-success"
              : "border-destructive/60 bg-destructive/10 text-destructive"
            : "border-border/70 text-muted-foreground hover:text-foreground dark:border-white/10"
        )}
      >
        <Icon size={13} />
        <Kbd>{verdict === "good" ? "G" : "B"}</Kbd>
      </button>
    );
  };
  return (
    <div role="group" aria-label={t("historyView.review.label")} className="flex gap-1.5">
      {button("good")}
      {button("bad")}
    </div>
  );
}

function HistoryOffNote({ onOpenPrivacy }: { onOpenPrivacy: () => void }) {
  const { t } = useTranslation();
  return (
    <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-300/90">
      {t("historyView.review.historyOff")}{" "}
      <button type="button" onClick={onOpenPrivacy} className="font-medium underline">
        {t("historyView.historyOff.link")}
      </button>
    </p>
  );
}

export function ReviewForm({
  review,
  historyOn,
  onOpenPrivacy,
}: {
  review: HistoryReviewController;
  historyOn: boolean;
  onOpenPrivacy: () => void;
}) {
  const { t } = useTranslation();
  const { draft } = review;
  if (!draft) return null;
  return (
    <section
      data-review-form
      aria-labelledby="history-review-title"
      className="mt-5 rounded-xl border border-border/80 bg-card p-4 dark:border-white/12 dark:bg-surface-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3
          id="history-review-title"
          className="flex items-center gap-2 text-sm font-medium text-foreground"
        >
          <ThumbsDown size={14} className="text-destructive" />
          {t("historyView.review.title")}
        </h3>
        <span className="ms-auto text-[11px] text-muted-foreground/80">
          {t("historyView.review.privacy")}
        </span>
      </div>
      {(!historyOn || review.error === "historyOff") && (
        <HistoryOffNote onOpenPrivacy={onOpenPrivacy} />
      )}

      <p id="history-review-stage" className="mt-3 text-xs text-muted-foreground">
        {t("historyView.review.stageQuestion")}{" "}
        <span className="text-muted-foreground/70">{t("historyView.review.stageHint")}</span>
      </p>
      <div
        ref={review.chipsRef}
        role="radiogroup"
        aria-labelledby="history-review-stage"
        className="mt-1.5 flex flex-wrap gap-1.5"
      >
        {review.chips.map((chip) => {
          const selected = sameStage(draft.stage, chip.stage);
          return (
            <button
              key={`${chip.stage.kind}:${chip.stage.seq ?? ""}`}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => review.pickStage(chip.stage)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                selected
                  ? "border-destructive/60 bg-destructive/10 text-foreground"
                  : "border-border/70 bg-muted/30 text-foreground/90 hover:bg-muted/60 dark:border-white/10"
              )}
            >
              {chip.digit && <Kbd>{chip.digit}</Kbd>}
              {chip.label}
            </button>
          );
        })}
      </div>
      {/* Stage 3: suggestions to fix the chosen step go here. */}

      <label htmlFor="history-review-expected" className="mt-4 block text-xs text-muted-foreground">
        {t("historyView.review.expectedQuestion")}{" "}
        <span className="text-muted-foreground/70">{t("historyView.review.expectedHint")}</span>
      </label>
      <AutoGrowTextarea
        id="history-review-expected"
        dir="auto"
        value={draft.expectedText}
        onChange={(event) => review.setExpectedText(event.target.value)}
        onKeyDown={blurOnEscape}
        minRows={2}
        className="mt-1.5 text-sm leading-relaxed"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          dir="auto"
          value={draft.note}
          onChange={(event) => review.setNote(event.target.value)}
          onKeyDown={blurOnEscape}
          maxLength={MAX_REVIEW_NOTE_CHARS}
          placeholder={t("historyView.review.notePlaceholder")}
          aria-label={t("historyView.review.noteLabel")}
          className="h-8 min-w-[12rem] flex-1 text-sm"
        />
        <Button variant="ghost" size="sm" onClick={review.cancel}>
          {t("common.cancel")}
          <Kbd>Esc</Kbd>
        </Button>
        <Button size="sm" onClick={review.save} disabled={review.saving}>
          {review.saving && <Loader2 size={13} className="animate-spin" />}
          {t(review.hotkey ? "historyView.review.saveAndClose" : "historyView.review.save")}
          <Kbd>{saveChord()}</Kbd>
        </Button>
      </div>
      {review.error === "failed" && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {t("historyView.review.saveError")}
        </p>
      )}
    </section>
  );
}

/** A review saved for this version of the dictation, with Edit and Delete review. */
export function SavedReview({ review }: { review: HistoryReviewController }) {
  const { t } = useTranslation();
  const { feedback, draft } = review;
  if (!feedback || draft) return null;
  const bad = feedback.verdict === "bad";
  const stage = feedback.stage
    ? (review.chips.find((chip) => sameStage(chip.stage, feedback.stage))?.label ??
      feedback.stage.kind)
    : null;
  return (
    <section
      aria-label={t("historyView.review.label")}
      className="mt-5 rounded-xl border border-border/70 bg-card/50 p-3.5 dark:border-white/10 dark:bg-surface-2/60"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          {bad ? (
            <ThumbsDown size={14} className="text-destructive" />
          ) : (
            <ThumbsUp size={14} className="text-success" />
          )}
          {t(bad ? "historyView.review.saved.bad" : "historyView.review.saved.good")}
        </p>
        <span className="ms-auto flex gap-1.5">
          {bad && (
            <Button variant="outline" size="sm" onClick={review.openBad}>
              {t("historyView.review.edit")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={review.remove}>
            {t("historyView.review.delete")}
          </Button>
        </span>
      </div>
      {stage && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("historyView.review.saved.stage")}{" "}
          <span dir="auto" className="text-foreground/90">
            {stage}
          </span>
        </p>
      )}
      {feedback.expectedText && (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground">{t("historyView.review.saved.expected")}</p>
          <p
            dir="auto"
            className="mt-1 whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground"
          >
            {feedback.expectedText}
          </p>
        </div>
      )}
      {feedback.note && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("historyView.review.saved.note")}{" "}
          <span dir="auto" className="text-foreground/90">
            {feedback.note}
          </span>
        </p>
      )}
      {review.error === "failed" && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {t("historyView.review.saveError")}
        </p>
      )}
    </section>
  );
}

/** Over a dictation the review hotkey opened: nothing is kept until Save. */
export function HotkeyReviewBanner() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary/40 bg-primary/8 px-3 py-2 text-[12.5px] text-foreground"
    >
      <Keyboard size={14} className="shrink-0 text-primary" />
      <span className="min-w-0 flex-1">{t("historyView.review.hotkey.banner")}</span>
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Kbd>Esc</Kbd>
        {t("historyView.review.hotkey.escape")}
      </span>
    </div>
  );
}

/** The draft was dropped: the dictation changed under it. */
export function ReviewNotice({ review }: { review: HistoryReviewController }) {
  const { t } = useTranslation();
  if (!review.notice) return null;
  return (
    <div
      role="status"
      className="mt-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-[12.5px] text-foreground"
    >
      <span className="min-w-0 flex-1">
        {t(
          review.notice === "stale" ? "historyView.review.stale" : "historyView.review.draftDropped"
        )}
      </span>
      <button
        type="button"
        onClick={review.dismissNotice}
        aria-label={t("common.dismiss")}
        className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X size={12} />
      </button>
    </div>
  );
}

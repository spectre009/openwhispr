import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import ClampedText from "../ui/ClampedText";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { StepPrompt } from "../ui/TranscriptionSteps";
import { stepKindLabel, stepOutcomeLabel, styleStepFacts } from "../ui/transcriptionStepLabels";
import { showInFolderLabelKey, useAddToTestSet } from "../ui/historyActions";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Copy,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  TestTube,
  Trash2,
} from "../icons";
import { useStyleStore } from "../../stores/styleStore";
import { findStyle, styleIdFromRouteKind, type StyleLibrary } from "../../config/styles/library";
import { stepChanges } from "../../utils/stepChanges";
import { normalizeDbDate } from "../../utils/dateFormatting";
import { formatMmSs } from "../../utils/formatDuration";
import { useUiLocale } from "../../hooks/useUiLocale";
import type {
  HistoryItem,
  HistoryItemResult,
  HistoryStepChange,
  TranscriptionStepRecord,
} from "../../types/electron";
import HistoryAudioPlayer from "./HistoryAudioPlayer";
import HistoryDiffText from "./HistoryDiffText";
import {
  HotkeyReviewBanner,
  ReviewButtons,
  ReviewForm,
  ReviewNotice,
  SavedReview,
} from "./HistoryReview";
import { setHistoryTextView, useHistoryViewStore } from "./historyViewStore";
import { useHistoryReview, type ReviewConfirm } from "./useHistoryReview";

// One dictation in full, read by id (history-get-item): the final text and its
// actions, the kept audio, then what each saved step did to the text, each
// compared with the text it received. A dictation from before step history
// shows what was heard against the final output, never which step changed it.
// Its review (👍 / 👎, What went wrong?) follows the steps, or comes before
// them when the review hotkey opened it.

type LoadedItem = Extract<HistoryItemResult, { success: true }>;
type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "notFound" }
  | { status: "ready"; result: LoadedItem };

const CARD_CLASS =
  "rounded-lg border border-border/70 bg-card/50 p-3.5 dark:border-white/10 dark:bg-surface-2/60";

const TAG_CLASS: Record<HistoryStepChange, string> = {
  changed: "border-primary/40 text-primary",
  same: "border-border text-muted-foreground/80 dark:border-white/15",
  failed: "border-destructive/40 text-destructive",
  skipped: "border-border text-muted-foreground/80 dark:border-white/15",
  fallback: "border-warning/50 text-warning",
};

const OUTCOME_NOTE: Partial<Record<HistoryStepChange, string>> = {
  failed: "historyView.steps.failedNote",
  fallback: "historyView.steps.fallbackNote",
  skipped: "historyView.steps.skippedNote",
};

function ChangeTag({ change }: { change: HistoryStepChange | null }) {
  const { t } = useTranslation();
  if (!change) return null;
  const label =
    change === "changed"
      ? t("historyView.steps.changed")
      : change === "same"
        ? t("historyView.steps.same")
        : stepOutcomeLabel(change, t);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 text-[10.5px] leading-4",
        TAG_CLASS[change]
      )}
    >
      {label}
    </span>
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function PlainText({ text }: { text: string }) {
  return (
    <p dir="auto" className="whitespace-pre-wrap wrap-break-word">
      {text}
    </p>
  );
}

function StepCard({
  step,
  change,
  input,
  view,
  styleLibrary,
  cardRef,
}: {
  step: TranscriptionStepRecord;
  change: HistoryStepChange | null;
  input: string | null;
  view: "changes" | "text";
  styleLibrary: StyleLibrary;
  cardRef: (node: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const facts = [
    ...styleStepFacts(step, styleLibrary, t),
    step.provider,
    step.model,
    step.ms !== null && step.ms !== undefined
      ? t("controlPanel.history.steps.durationMs", { ms: step.ms })
      : null,
  ].filter((fact): fact is string => !!fact);
  const outcomeNote = change ? OUTCOME_NOTE[change] : undefined;
  const rules = step.kind === "glossary" && step.outcome === "ok" ? step.detail?.rulesFired : null;

  let body: ReactNode = null;
  if (outcomeNote) {
    body = <p className="text-xs text-muted-foreground">{t(outcomeNote)}</p>;
  } else if (typeof step.output === "string") {
    body =
      view === "changes" && input !== null && change === "changed" ? (
        <HistoryDiffText before={input} after={step.output} />
      ) : (
        <PlainText text={step.output} />
      );
  }

  return (
    <section ref={cardRef} tabIndex={-1} className={cn(CARD_CLASS, "scroll-mt-4 outline-none")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-sm font-medium text-foreground">{stepKindLabel(step, t)}</h4>
        <ChangeTag change={change} />
        {facts.length > 0 && (
          <span dir="auto" className="ms-auto text-[11px] text-muted-foreground/80">
            {facts.join(" · ")}
          </span>
        )}
      </div>
      {body && <div className="mt-2 text-sm leading-relaxed text-foreground">{body}</div>}
      {rules && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {rules.length === 0 ? (
            <span className="text-[11px] text-muted-foreground/80">
              {t("historyView.steps.noCorrections")}
            </span>
          ) : (
            rules.map((rule, index) => (
              <span
                key={`${rule.ruleId ?? "rule"}-${index}`}
                className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 text-[11.5px] dark:border-white/10"
              >
                <span dir="auto">{rule.from}</span>
                <ArrowRight size={11} className="text-muted-foreground rtl:-scale-x-100" />
                <span dir="auto">{rule.to}</span>
              </span>
            ))
          )}
        </div>
      )}
      <StepPrompt step={step} />
      {step.errorCode && (
        <p className="mt-1 text-[11px] text-muted-foreground/80">
          {t("controlPanel.history.steps.errorCode", { code: step.errorCode })}
        </p>
      )}
    </section>
  );
}

function TextViewToggle() {
  const { t } = useTranslation();
  const view = useHistoryViewStore((state) => state.textView);
  const options = [
    { value: "changes" as const, label: t("historyView.steps.viewChanges") },
    { value: "text" as const, label: t("historyView.steps.viewText") },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t("historyView.steps.viewLabel")}
      className="inline-flex overflow-hidden rounded-md border border-border/70 dark:border-white/10"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={view === option.value}
          onClick={() => setHistoryTextView(option.value)}
          className={cn(
            "px-2.5 py-1 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
            view === option.value
              ? "bg-muted text-foreground dark:bg-white/10"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SectionHeading({ title }: { title: string }) {
  return (
    <div className="mt-6 mb-2 flex items-center gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <span className="grow" />
      <TextViewToggle />
    </div>
  );
}

function StepsSection({
  result,
  app,
  styleLibrary,
}: {
  result: LoadedItem;
  app: string | null;
  styleLibrary: StyleLibrary;
}) {
  const { t } = useTranslation();
  const view = useHistoryViewStore((state) => state.textView);
  const { steps } = result;
  const changes = useMemo(() => stepChanges(steps), [steps]);
  const cards = useRef<(HTMLElement | null)[]>([]);
  const maxMs = Math.max(1, ...steps.map((step) => step.ms ?? 0));

  const jumpTo = (index: number) => {
    const card = cards.current[index];
    if (!card) return;
    card.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    card.focus({ preventScroll: true });
  };

  return (
    <>
      <ol
        aria-label={t("historyView.steps.title")}
        className="mt-5 flex overflow-x-auto rounded-lg border border-border/70 dark:border-white/10"
      >
        {steps.map((step, index) => (
          <li
            key={index}
            className="min-w-[7.5rem] flex-1 border-s border-border/70 first:border-s-0 dark:border-white/10"
          >
            <button
              type="button"
              onClick={() => jumpTo(index)}
              aria-label={t("historyView.steps.goTo", { step: stepKindLabel(step, t) })}
              className="relative block h-full w-full px-3 pt-2 pb-2.5 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 dark:hover:bg-white/5"
            >
              <span className="block truncate text-[11px] text-muted-foreground">
                {stepKindLabel(step, t)}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                <ChangeTag change={changes[index]?.change ?? null} />
                {step.ms !== null && step.ms !== undefined && (
                  <span className="text-[11px] tabular-nums text-muted-foreground/80">
                    {t("controlPanel.history.steps.durationMs", { ms: step.ms })}
                  </span>
                )}
              </span>
              <span
                aria-hidden="true"
                className="absolute bottom-0 start-0 h-[3px] bg-primary/50"
                style={{ width: `${Math.max(3, Math.round((100 * (step.ms ?? 0)) / maxMs))}%` }}
              />
            </button>
          </li>
        ))}
        <li className="min-w-[7.5rem] flex-1 border-s border-border/70 px-3 py-2 dark:border-white/10">
          <span className="block truncate text-[11px] text-muted-foreground">
            {t("historyView.steps.final")}
          </span>
          {app ? (
            <span dir="ltr" className="mt-1 block truncate text-xs text-foreground/90">
              {app}
            </span>
          ) : (
            <span className="mt-1 block truncate text-xs text-muted-foreground/80">
              {t("historyView.detail.appNotRecorded")}
            </span>
          )}
        </li>
      </ol>

      <SectionHeading title={t("historyView.steps.title")} />
      <div className="space-y-2">
        {steps.map((step, index) => {
          const input = changes[index]?.input;
          return (
            <StepCard
              key={index}
              step={step}
              change={changes[index]?.change ?? null}
              input={input === null || input === undefined ? null : (steps[input].output ?? null)}
              view={view}
              styleLibrary={styleLibrary}
              cardRef={(node) => {
                cards.current[index] = node;
              }}
            />
          );
        })}
        <section className={CARD_CLASS}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="text-sm font-medium text-foreground">{t("historyView.steps.final")}</h4>
            <span className="ms-auto text-[11px] text-muted-foreground/80">
              {app ? (
                <BidiInterpolatedText
                  text={t("historyView.steps.sentTo", { app: BIDI_VALUE_TOKEN })}
                  value={app}
                />
              ) : (
                t("historyView.steps.sentToUnknown")
              )}
            </span>
          </div>
        </section>
      </div>
    </>
  );
}

/** A dictation from before step history (or saved under another sign-in): heard vs final. */
function WithoutSteps({ item, otherOwner }: { item: HistoryItem; otherOwner: boolean }) {
  const { t } = useTranslation();
  const view = useHistoryViewStore((state) => state.textView);
  const raw = item.rawText;
  const compared = view === "changes" && raw !== null && raw !== item.text;
  return (
    <>
      <SectionHeading title={t("historyView.steps.withoutStepsTitle")} />
      <p className="mb-2 text-xs italic text-muted-foreground">
        {t(otherOwner ? "controlPanel.history.steps.otherOwner" : "historyView.steps.notRecorded")}
      </p>
      <div className="space-y-2">
        {raw !== null && (
          <section className={CARD_CLASS}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h4 className="text-sm font-medium text-foreground">
                {t("historyView.steps.heard")}
              </h4>
              <span className="text-[11px] text-muted-foreground/80">
                {t("historyView.steps.heardHint")}
              </span>
            </div>
            <div className="mt-2 text-sm leading-relaxed text-foreground">
              <PlainText text={raw} />
            </div>
          </section>
        )}
        <section className={CARD_CLASS}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="text-sm font-medium text-foreground">{t("historyView.steps.final")}</h4>
            {raw !== null && (
              <span className="ms-auto text-[11px] text-muted-foreground/80">
                {t(
                  raw === item.text
                    ? "historyView.steps.sameAsHeard"
                    : "historyView.steps.whoChanged"
                )}
              </span>
            )}
          </div>
          <div className="mt-2 text-sm leading-relaxed text-foreground">
            {compared && raw !== null ? (
              <HistoryDiffText before={raw} after={item.text} />
            ) : (
              <PlainText text={item.text} />
            )}
          </div>
        </section>
      </div>
    </>
  );
}

interface HistoryDetailProps {
  id: number;
  /** Bumped by the view when main reports this row changed. */
  revision: number;
  /** Narrow layouts: back to the list. */
  onBack?: () => void;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onRetry: (id: number, routeKind: string | null) => Promise<void>;
  onShowAudioInFolder: (id: number) => void;
  /** Local history is on, so a review can be kept. */
  historyOn: boolean;
  onOpenPrivacy: () => void;
  /** Asks first, in the view's confirm dialog. */
  confirm: (options: ReviewConfirm) => void;
}

export default function HistoryDetail({
  id,
  revision,
  onBack,
  onCopy,
  onDelete,
  onRetry,
  onShowAudioInFolder,
  historyOn,
  onOpenPrivacy,
  confirm,
}: HistoryDetailProps) {
  const { t } = useTranslation();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [retrying, setRetrying] = useState(false);
  // Bumped when a review finds the dictation changed under it.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const read = window.electronAPI?.getHistoryItem;
    if (!read) {
      setLoad({ status: "error" });
      return;
    }
    read(id).then(
      (reply) => {
        if (cancelled) return;
        if (reply?.success) setLoad({ status: "ready", result: reply });
        else {
          const code = (reply as { code?: string } | null)?.code;
          setLoad({ status: code === "NOT_FOUND" ? "notFound" : "error" });
        }
      },
      () => {
        if (!cancelled) setLoad({ status: "error" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [id, revision, reloads]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  const retry = useCallback(
    async (routeKind: string | null) => {
      if (retrying) return;
      setRetrying(true);
      try {
        await onRetry(id, routeKind);
      } finally {
        setRetrying(false);
      }
    },
    [id, onRetry, retrying]
  );

  const back = onBack ? (
    <div className="shrink-0 border-b border-border/70 px-3 py-2 dark:border-white/10">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="rtl:-scale-x-100" />
        {t("historyView.detail.back")}
      </Button>
    </div>
  ) : null;

  if (load.status !== "ready") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {back}
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {load.status === "loading" ? (
            <Loader2 size={16} className="animate-spin text-primary" />
          ) : (
            t(
              load.status === "notFound"
                ? "historyView.detail.notFound"
                : "historyView.detail.loadError"
            )
          )}
        </div>
      </div>
    );
  }

  return (
    <LoadedDetail
      result={load.result}
      back={back}
      retrying={retrying}
      onRetry={retry}
      onCopy={onCopy}
      onDelete={onDelete}
      onShowAudioInFolder={onShowAudioInFolder}
      historyOn={historyOn}
      onOpenPrivacy={onOpenPrivacy}
      confirm={confirm}
      reload={reload}
    />
  );
}

function LoadedDetail({
  result,
  back,
  retrying,
  onRetry,
  onCopy,
  onDelete,
  onShowAudioInFolder,
  historyOn,
  onOpenPrivacy,
  confirm,
  reload,
}: {
  result: LoadedItem;
  back: ReactNode;
  retrying: boolean;
  onRetry: (routeKind: string | null) => Promise<void>;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onShowAudioInFolder: (id: number) => void;
  historyOn: boolean;
  onOpenPrivacy: () => void;
  confirm: (options: ReviewConfirm) => void;
  reload: () => void;
}) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const addToTestSet = useAddToTestSet();
  const styleLibrary = useStyleStore((state) => state.library);
  const review = useHistoryReview({ result, reload, confirm });
  const { item } = result;
  const captured = result.status === "captured" && result.steps.length > 0;
  const app = captured ? (result.context?.targetApp ?? null) : null;
  const completed = item.status === "completed";
  const failed = item.status === "failed";
  const date = item.timestamp ? normalizeDbDate(item.timestamp) : null;
  const when =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
      : null;
  const audioLength =
    item.audioDurationMs && item.audioDurationMs > 0
      ? formatMmSs(Math.round(item.audioDurationMs / 1000))
      : null;
  const styleId = styleIdFromRouteKind(item.routeKind);
  const style = styleId ? findStyle(styleLibrary, styleId) : undefined;
  const styleLabel = styleId
    ? style
      ? `${style.emoji ? `${style.emoji} ` : ""}${style.name}`
      : t("controlPanel.history.steps.deletedStyle")
    : null;
  const canPin = completed && !!item.rawText?.trim();
  // Opened by the review hotkey, the review comes before the steps; otherwise after them.
  const reviewSection = (
    <>
      <ReviewNotice review={review} />
      <ReviewForm review={review} historyOn={historyOn} onOpenPrivacy={onOpenPrivacy} />
      <SavedReview review={review} />
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {back}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 pt-5 pb-12">
          {review.hotkey && <HotkeyReviewBanner />}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <div className="min-w-0 flex-[1_1_18rem]">
              {failed ? (
                <p className="flex items-center gap-2 text-base font-medium text-destructive">
                  <AlertCircle size={16} className="shrink-0" />
                  {t("controlPanel.history.transcriptionFailed")}
                </p>
              ) : item.status === "discarded" ? (
                <p className="text-base text-muted-foreground">
                  {t("controlPanel.history.discarded.recording")}
                </p>
              ) : item.text ? (
                <ClampedText collapsedRem={10}>
                  <p
                    dir="auto"
                    className="whitespace-pre-wrap wrap-break-word text-base font-medium leading-relaxed text-foreground"
                  >
                    {item.text}
                  </p>
                </ClampedText>
              ) : (
                <p className="text-base italic text-muted-foreground">
                  {t("historyView.list.noText")}
                </p>
              )}
              <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {when && <span>{when}</span>}
                <span>
                  {app ? (
                    <BidiInterpolatedText
                      text={t("historyView.detail.inApp", { app: BIDI_VALUE_TOKEN })}
                      value={app}
                    />
                  ) : (
                    t("historyView.detail.appNotRecorded")
                  )}
                </span>
                {audioLength && (
                  <span>
                    <BidiInterpolatedText
                      text={t("historyView.detail.audioLength", { duration: BIDI_VALUE_TOKEN })}
                      value={audioLength}
                    />
                  </span>
                )}
                {styleLabel && <span dir="auto">{styleLabel}</span>}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <ReviewButtons review={review} />
              {completed && item.text && (
                <Button variant="outline" size="sm" onClick={() => onCopy(item.text)}>
                  <Copy size={13} />
                  {t("common.copy")}
                </Button>
              )}
              {item.hasAudio && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={retrying}
                  onClick={() => void onRetry(item.routeKind)}
                >
                  {retrying ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <RotateCcw size={13} />
                  )}
                  {t("controlPanel.history.retryTranscription")}
                </Button>
              )}
              {canPin && (
                <Button variant="outline" size="sm" onClick={() => void addToTestSet(item.id)}>
                  <TestTube size={13} />
                  {t("controlPanel.history.testSet.add")}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("controlPanel.history.moreActions")}
                    className="size-8 rounded-full"
                  >
                    <MoreHorizontal size={15} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {item.hasAudio && (
                    <DropdownMenuItem
                      className="gap-2.5"
                      onSelect={() => onShowAudioInFolder(item.id)}
                    >
                      <FolderOpen size={14} className="shrink-0 opacity-70" />
                      {t(showInFolderLabelKey())}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="gap-2.5 text-destructive focus:bg-destructive/8 focus:text-destructive"
                    onSelect={() => onDelete(item.id)}
                  >
                    <Trash2 size={14} className="shrink-0 opacity-70" />
                    {t("controlPanel.history.deleteItem")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {item.hasAudio && <HistoryAudioPlayer id={item.id} durationMs={item.audioDurationMs} />}

          {failed && (
            <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3.5">
              {item.errorMessage && (
                <p dir="auto" className="text-sm leading-relaxed text-foreground/90">
                  {item.errorMessage}
                </p>
              )}
              {item.errorCode && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("controlPanel.history.steps.errorCode", { code: item.errorCode })}
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                {t(
                  item.hasAudio
                    ? "historyView.detail.failedRetry"
                    : "historyView.detail.failedNoAudio"
                )}
              </p>
            </div>
          )}

          {review.hotkey && reviewSection}

          {captured ? (
            <StepsSection result={result} app={app} styleLibrary={styleLibrary} />
          ) : (
            completed && <WithoutSteps item={item} otherOwner={result.status === "otherOwner"} />
          )}

          {!review.hotkey && reviewSection}
        </div>
      </div>
    </div>
  );
}

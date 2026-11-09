import { useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { StepFailure, StepPrompt } from "../ui/TranscriptionSteps";
import {
  stepKindLabel,
  stepOutcomeLabel,
  stepReusedLabel,
  styleStepFacts,
  dictionaryScopeFact,
} from "../ui/transcriptionStepLabels";
import { ArrowRight, ThumbsDown } from "../icons";
import type { StyleLibrary } from "../../config/styles/library";
import { stepChanges } from "../../utils/stepChanges";
import type {
  HistoryItem,
  HistoryItemResult,
  HistoryStepChange,
  TranscriptionStepRecord,
} from "../../types/electron";
import HistoryDiffText from "./HistoryDiffText";
import { setHistoryTextView, useHistoryViewStore } from "./historyViewStore";
import { SelectionActions } from "./HistoryFixes";
import { useStepTextSelection, type HistoryFixesController } from "./useHistoryFixes";

// What each saved step of a dictation did, for the History detail: the step
// strip (one node per step, then the final output; a node jumps to its card)
// and one card per step, compared with the text it received. A dictation from
// before step history shows what was heard against the final output, never
// which step changed it. Both layouts use these; the wide one shows the cards
// in its Steps tab.

type LoadedItem = Extract<HistoryItemResult, { success: true }>;

export const CARD_CLASS =
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

export function ChangeTag({ change }: { change: HistoryStepChange | null }) {
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

export function PlainText({ text }: { text: string }) {
  return (
    <p dir="auto" className="whitespace-pre-wrap wrap-break-word">
      {text}
    </p>
  );
}

// A step (or the final output) a 👎 review names: the mockup's red treatment.
export const BLAMED_CARD_CLASS =
  "border-destructive/60 bg-destructive/5 dark:border-destructive/60 dark:bg-destructive/10";

export function FlaggedTag() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/50 px-1.5 text-[10.5px] leading-4 text-destructive">
      <ThumbsDown size={10} />
      {t("historyView.fixes.flagged")}
    </span>
  );
}

function StepCard({
  index,
  step,
  change,
  input,
  view,
  styleLibrary,
  blamed,
  cardRef,
  onRerunCleanup,
  rerunBusy,
  rerunning,
  markWords,
}: {
  index: number;
  step: TranscriptionStepRecord;
  change: HistoryStepChange | null;
  input: string | null;
  view: "changes" | "text";
  styleLibrary: StyleLibrary;
  blamed: boolean;
  cardRef: (node: HTMLElement | null) => void;
  /** A failed cleanup, style or translation step offers Re-run cleanup. */
  onRerunCleanup?: () => void;
  /** A re-run of this dictation is going; `rerunning`: it's Re-run cleanup. */
  rerunBusy: boolean;
  rerunning: boolean;
  /** Dictionary words fixed after speech: marked where this step put them in. */
  markWords?: readonly string[];
}) {
  const { t } = useTranslation();
  const reused = stepReusedLabel(step, t);
  const facts = [
    ...styleStepFacts(step, styleLibrary, t),
    dictionaryScopeFact(step, t),
    step.provider,
    step.model,
    step.ms !== null && step.ms !== undefined
      ? t("controlPanel.history.steps.durationMs", { ms: step.ms })
      : null,
  ].filter((fact): fact is string => !!fact);
  const outcomeNote = change ? OUTCOME_NOTE[change] : undefined;
  const rules = step.kind === "glossary" && step.outcome === "ok" ? step.detail?.rulesFired : null;

  let body: ReactNode = null;
  // The step's own text (not an outcome note): words selected in it can start a fix.
  let isText = false;
  if (outcomeNote) {
    body = <p className="text-xs text-muted-foreground">{t(outcomeNote)}</p>;
  } else if (typeof step.output === "string") {
    isText = true;
    body =
      view === "changes" && input !== null && change === "changed" ? (
        <HistoryDiffText
          before={input}
          after={step.output}
          markWords={step.kind === "cleanup" || step.kind === "style" ? markWords : undefined}
        />
      ) : (
        <PlainText text={step.output} />
      );
  }

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      data-blamed={blamed || undefined}
      className={cn(CARD_CLASS, "scroll-mt-4 outline-none", blamed && BLAMED_CARD_CLASS)}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-sm font-medium text-foreground">{stepKindLabel(step, t)}</h4>
        <ChangeTag change={change} />
        {reused && (
          <span className="inline-flex shrink-0 items-center rounded-full border border-border px-1.5 text-[10.5px] leading-4 text-muted-foreground/80 dark:border-white/15">
            {reused}
          </span>
        )}
        {blamed && <FlaggedTag />}
        {facts.length > 0 && (
          <span dir="auto" className="ms-auto text-[11px] text-muted-foreground/80">
            {facts.join(" · ")}
          </span>
        )}
      </div>
      {reused && (
        <p className="mt-1 text-[11px] text-muted-foreground/80">
          {t(
            step.detail?.reused === "stored"
              ? "historyView.steps.reusedNote"
              : "historyView.steps.reusedUnknownNote"
          )}
        </p>
      )}
      {body && (
        <div
          data-step-output={isText ? index : undefined}
          className="mt-2 text-sm leading-relaxed text-foreground"
        >
          {body}
        </div>
      )}
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
      <StepFailure
        step={step}
        onRerunCleanup={onRerunCleanup}
        busy={rerunBusy}
        running={rerunning}
      />
      <StepPrompt step={step} />
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

function SectionHeading({ title, className }: { title: string; className?: string }) {
  return (
    <div className={cn("mt-6 mb-2 flex items-center gap-2", className)}>
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <span className="grow" />
      <TextViewToggle />
    </div>
  );
}

/** One node per recorded step, then the final output; a node jumps to its step's card. */
export function StepStrip({
  steps,
  app,
  blamed,
  onJump,
  className,
}: {
  steps: TranscriptionStepRecord[];
  app: string | null;
  blamed: number | "delivery" | null;
  onJump: (index: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const changes = useMemo(() => stepChanges(steps), [steps]);
  const maxMs = Math.max(1, ...steps.map((step) => step.ms ?? 0));
  const finalBlamed = blamed === "delivery";
  return (
    <ol
      aria-label={t("historyView.steps.title")}
      className={cn(
        "flex overflow-x-auto rounded-lg border border-border/70 dark:border-white/10",
        className
      )}
    >
      {steps.map((step, index) => {
        const flagged = blamed === index;
        const label = stepKindLabel(step, t);
        return (
          <li
            key={index}
            data-blamed={flagged || undefined}
            className="min-w-[7.5rem] flex-1 border-s border-border/70 first:border-s-0 dark:border-white/10"
          >
            <button
              type="button"
              onClick={() => onJump(index)}
              aria-label={t(flagged ? "historyView.fixes.flaggedGoTo" : "historyView.steps.goTo", {
                step: label,
              })}
              className={cn(
                "relative block h-full w-full px-3 pt-2 pb-2.5 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 dark:hover:bg-white/5",
                flagged && "bg-destructive/10 hover:bg-destructive/15 dark:bg-destructive/15"
              )}
            >
              <span
                className={cn(
                  "flex items-center gap-1 truncate text-[11px]",
                  flagged ? "text-destructive" : "text-muted-foreground"
                )}
              >
                <span className="truncate">{label}</span>
                {flagged && <ThumbsDown size={10} className="shrink-0" />}
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
        );
      })}
      <li
        data-blamed={finalBlamed || undefined}
        className={cn(
          "min-w-[7.5rem] flex-1 border-s border-border/70 px-3 py-2 dark:border-white/10",
          finalBlamed && "bg-destructive/10 dark:bg-destructive/15"
        )}
      >
        <span
          className={cn(
            "flex items-center gap-1 truncate text-[11px]",
            finalBlamed ? "text-destructive" : "text-muted-foreground"
          )}
        >
          <span className="truncate">{t("historyView.steps.final")}</span>
          {finalBlamed && (
            <>
              <ThumbsDown size={10} className="shrink-0" />
              <span className="sr-only">{t("historyView.fixes.flagged")}</span>
            </>
          )}
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
  );
}

/** Asks the cards to show one of them; `nonce` makes a repeated jump to the same card count. */
export interface StepJump {
  index: number;
  nonce: number;
}

/** Scrolls to a card and focuses it. */
function jumpToCard(card: HTMLElement | null | undefined) {
  if (!card) return;
  card.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  card.focus({ preventScroll: true });
}

/** The step cards, then the final output's; words selected in a step's text can start a fix. */
export function StepCards({
  result,
  app,
  styleLibrary,
  fixes,
  onRerunCleanup,
  rerunBusy,
  rerunning,
  markWords,
  cardsRef,
  jump,
  onJumped,
  headingClassName,
}: {
  result: LoadedItem;
  app: string | null;
  styleLibrary: StyleLibrary;
  fixes: HistoryFixesController;
  onRerunCleanup?: () => void;
  rerunBusy: boolean;
  rerunning: boolean;
  markWords: readonly string[];
  /** The cards by step, for a strip beside them to jump to. */
  cardsRef?: MutableRefObject<(HTMLElement | null)[]>;
  /** A strip elsewhere asked for a card (the wide layout's Steps tab); `onJumped` once shown. */
  jump?: StepJump | null;
  onJumped?: () => void;
  headingClassName?: string;
}) {
  const { t } = useTranslation();
  const view = useHistoryViewStore((state) => state.textView);
  const { steps } = result;
  const changes = useMemo(() => stepChanges(steps), [steps]);
  const outputs = useMemo(() => steps.map((step) => step.output), [steps]);
  const ownCards = useRef<(HTMLElement | null)[]>([]);
  const cards = cardsRef ?? ownCards;
  const cardsBox = useRef<HTMLDivElement>(null);
  const { blamed } = fixes;
  const finalBlamed = blamed === "delivery";
  useStepTextSelection(cardsBox, fixes, outputs);

  useEffect(() => {
    if (!jump) return;
    jumpToCard(cards.current[jump.index]);
    onJumped?.();
  }, [jump, cards, onJumped]);

  return (
    <>
      <SectionHeading title={t("historyView.steps.title")} className={headingClassName} />
      <div ref={cardsBox} className="relative">
        <div className="space-y-2">
          {steps.map((step, index) => {
            const input = changes[index]?.input;
            return (
              <StepCard
                key={index}
                index={index}
                step={step}
                change={changes[index]?.change ?? null}
                input={input === null || input === undefined ? null : (steps[input].output ?? null)}
                view={view}
                styleLibrary={styleLibrary}
                blamed={blamed === index}
                cardRef={(node) => {
                  cards.current[index] = node;
                }}
                onRerunCleanup={onRerunCleanup}
                rerunBusy={rerunBusy}
                rerunning={rerunning}
                markWords={markWords}
              />
            );
          })}
          <section
            data-blamed={finalBlamed || undefined}
            className={cn(CARD_CLASS, finalBlamed && BLAMED_CARD_CLASS)}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h4 className="text-sm font-medium text-foreground">
                {t("historyView.steps.final")}
              </h4>
              {finalBlamed && <FlaggedTag />}
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
        <SelectionActions fixes={fixes} />
      </div>
    </>
  );
}

/** The stacked layout's steps: the strip, then the cards it jumps to. */
export function StepsSection(
  props: Omit<Parameters<typeof StepCards>[0], "cardsRef" | "jump" | "onJumped">
) {
  const cards = useRef<(HTMLElement | null)[]>([]);
  return (
    <>
      <StepStrip
        steps={props.result.steps}
        app={props.app}
        blamed={props.fixes.blamed}
        onJump={(index) => jumpToCard(cards.current[index])}
        className="mt-5"
      />
      <StepCards {...props} cardsRef={cards} />
    </>
  );
}

/** A dictation from before step history (or saved under another sign-in): heard vs final. */
export function WithoutSteps({
  item,
  otherOwner,
  finalBlamed,
  headingClassName,
}: {
  item: HistoryItem;
  otherOwner: boolean;
  /** A 👎 review blames the delivery. */
  finalBlamed: boolean;
  headingClassName?: string;
}) {
  const { t } = useTranslation();
  const view = useHistoryViewStore((state) => state.textView);
  const raw = item.rawText;
  const compared = view === "changes" && raw !== null && raw !== item.text;
  return (
    <>
      <SectionHeading
        title={t("historyView.steps.withoutStepsTitle")}
        className={headingClassName}
      />
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
        <section
          data-blamed={finalBlamed || undefined}
          className={cn(CARD_CLASS, finalBlamed && BLAMED_CARD_CLASS)}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="text-sm font-medium text-foreground">{t("historyView.steps.final")}</h4>
            {finalBlamed && <FlaggedTag />}
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

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./button";
import { Input } from "./input";
import { AutoGrowTextarea } from "./AutoGrowTextarea";
import ClampedText from "./ClampedText";
import { Toggle } from "./toggle";
import { Progress } from "./progress";
import { ConfirmDialog } from "./dialog";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Info,
  Loader2,
  Pencil,
  Play,
  Trash2,
  X,
} from "../icons";
import { cn } from "../lib/utils";
import type { PromptLibraryEditor } from "../../hooks/usePromptLibraryEditor";
import type { PromptTestCase, PromptTestStyleChecks } from "../../types/electron";
import {
  STARTER_TEST_CASES,
  styleStarterCases,
  type StarterTestCase,
} from "../../config/promptTestStarters";
import type { RecordingStyle } from "../../config/styles/library";
import {
  buildRunCases,
  buildStyleRunCases,
  clearTestCases,
  clearTestResults,
  deleteTestCase,
  followTestCases,
  hideStarter,
  setRepetitions,
  showStarters,
  startStyleTestRun,
  startTestRun,
  stopTestRun,
  storageNoticeKey,
  styleTestTarget,
  updateTestCase,
  usePromptTestSetStore,
  visibleStarters,
  type TestRunInfo,
} from "../../stores/promptTestSetStore";
import {
  ESTIMATED_SECONDS_PER_REQUEST,
  MAX_RUN_CASES,
  PROMPT_SIDES,
  REPETITION_CHOICES,
  estimateRequests,
  needsAttention,
  sidePassed,
  isCompared,
  summarizeRun,
  type CaseResult,
  type PromptSide,
  type RequestOutcome,
} from "../../services/promptTestRunner";
import { pinDictationCleanupRequest } from "../../services/cleanupWithPrompt";
import { getProviderDisplayName, resolveInferenceProvider } from "../../models/ModelRegistry";
import { getSettings, useSettingsStore } from "../../stores/settingsStore";
import { describeProviderError } from "../../utils/describeProviderError";
import { diffWords, type WordDiffSegment } from "../../utils/wordDiff";
import type { OutputChecks, StyleCountCheckKind } from "../../utils/promptTestChecks";
import { requestOpenHistoryItem } from "../../utils/openHistoryItem";

// Prompt Studio → Test → Test set (cleanup prompts): the owner's cases plus
// the built-in starters, run through prompt A (in use) and B (selected or
// draft), with the results side by side. A style's Test uses the same view
// with the style's cases, A as one step and B as two steps, and the bullet
// and numbered-item checks. The store owns cases and runs.

function hostOf(url: string | undefined): string {
  const value = (url || "").trim();
  if (!value) return "";
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).host;
  } catch {
    return value;
  }
}

function caseLabel(testCase: PromptTestCase): string {
  if (testCase.label) return testCase.label;
  const text = testCase.rawText.replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function seconds(ms: number | null | undefined): string {
  return typeof ms === "number" ? (ms / 1000).toFixed(1) : "–";
}

function linesToList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Where cleanup requests go with the settings as they are now. */
function useCleanupDestination(t: TFunction) {
  // Subscribed only so the description follows changes; it is built from getSettings().
  useSettingsStore(
    useShallow((s) => [
      s.useCleanupModel,
      s.cleanupMode,
      s.cleanupProvider,
      s.cleanupModel,
      s.cleanupRemoteUrl,
      s.cleanupCloudBaseUrl,
      s.cleanupCloudMode,
      s.isSignedIn,
    ])
  );
  const settings = getSettings();
  const request = pinDictationCleanupRequest(settings);
  const providerId = request.config.provider
    ? resolveInferenceProvider(request.config.provider, request.model)
    : "";
  const local = providerId === "local";
  const label = local
    ? t("promptStudio.testSet.destination.local")
    : providerId === "lan"
      ? t("promptStudio.testSet.destination.selfHosted", {
          host: hostOf(settings.cleanupRemoteUrl),
        })
      : providerId === "openwhispr"
        ? t("promptStudio.test.openwhisprCloud")
        : providerId === "custom"
          ? t("promptStudio.testSet.destination.custom", {
              host: hostOf(settings.cleanupCloudBaseUrl),
            })
          : getProviderDisplayName(providerId);
  const model =
    request.model || (providerId === "openwhispr" ? t("promptStudio.test.openwhisprCloud") : "");
  const blocked = !settings.useCleanupModel
    ? t("promptStudio.test.disabledReasoning")
    : !providerId || (!request.model && providerId !== "openwhispr" && providerId !== "lan")
      ? t("promptStudio.test.noModelSelected")
      : null;
  // A style runs whenever the cleanup scope has a model, cleanup switched on or not.
  const styleBlocked =
    !providerId || (!request.model && providerId !== "openwhispr" && providerId !== "lan")
      ? t("promptStudio.test.noModelSelected")
      : null;
  return { label, model, local, blocked, styleBlocked };
}

/** A style under test: its editor's copy, unsaved changes included. */
export interface StyleTestSubject {
  style: RecordingStyle;
  /** The editor holds changes not saved yet. */
  isDraft: boolean;
}

type PromptTestSetProps =
  | { editor: PromptLibraryEditor; agentName: string; style?: undefined }
  | { style: StyleTestSubject; agentName: string; editor?: undefined };

// Measured warm (style lab): about 1.7 s for one step and 3.2 s for two.
const STYLE_SECONDS_PER_PAIR = 4.9;

export default function PromptTestSet(props: PromptTestSetProps) {
  const { agentName } = props;
  const editor = props.editor ?? null;
  const subject = props.style ?? null;
  const styleId = subject?.style.id ?? null;
  const target = styleId ? styleTestTarget(styleId) : "cleanup";
  const { t } = useTranslation();
  const state = usePromptTestSetStore(
    useShallow((s) => ({
      loaded: s.loaded,
      cases: s.cases,
      durable: s.durable,
      storageReason: s.storageReason,
      hiddenStarters: s.hiddenStarters,
      repetitions: s.repetitions,
      run: s.run,
    }))
  );
  const destination = useCleanupDestination(t);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [onlyAttention, setOnlyAttention] = useState(false);

  useEffect(() => {
    followTestCases();
  }, []);

  const starterLabel = (starter: StarterTestCase) => t(starter.labelKey);
  const ownCases = state.cases.filter((testCase) => testCase.target === target);
  const starters = visibleStarters(state.hiddenStarters, styleId);
  const labels = { starter: starterLabel, stored: caseLabel };
  const runCases = styleId
    ? buildStyleRunCases(state.cases, state.hiddenStarters, styleId, labels)
    : buildRunCases(state.cases, state.hiddenStarters, labels);
  const modeStarters = styleId ? styleStarterCases(styleId) : STARTER_TEST_CASES;
  const hiddenIds = modeStarters
    .filter((starter) => state.hiddenStarters.includes(starter.id))
    .map((starter) => starter.id);
  const hiddenCount = hiddenIds.length;

  // One run at a time across the cleanup set and every style's.
  const run = state.run && state.run.kind === target ? state.run : null;
  const otherRunning =
    state.run !== null && state.run.kind !== target && state.run.progress.phase !== "finished";
  const running = run !== null && run.progress.phase !== "finished";
  const requests = estimateRequests(runCases.length, state.repetitions);
  const estimatedSeconds = Math.round(
    styleId
      ? (requests / PROMPT_SIDES.length) * STYLE_SECONDS_PER_PAIR
      : requests * ESTIMATED_SECONDS_PER_REQUEST
  );
  const duration =
    estimatedSeconds < 60
      ? t("promptStudio.testSet.run.durationSeconds", { seconds: estimatedSeconds })
      : t("promptStudio.testSet.run.durationMinutes", {
          minutes: Math.round(estimatedSeconds / 60),
        });

  const activeName = editor ? editor.displayName(editor.library.activeId) : "";
  const selectedName = editor ? editor.displayName(editor.selectedId) : "";
  const nameA = subject ? t("styles.test.oneStep") : activeName;
  const nameB = subject
    ? t("styles.test.twoSteps")
    : editor?.isDirty
      ? t("promptStudio.testSet.run.draftName", { name: selectedName })
      : selectedName;
  const samePrompt = !!editor && editor.isSelectedActive && !editor.isDirty;
  const candidateIsEmpty = subject
    ? !subject.style.instruction.trim() || !subject.style.name.trim()
    : !!editor && !editor.isDefaultSelected && !editor.editorText.trim();

  const blocked = (subject ? destination.styleBlocked : destination.blocked)
    ? subject
      ? destination.styleBlocked
      : destination.blocked
    : candidateIsEmpty
      ? t(subject ? "styles.test.incomplete" : "promptStudio.library.emptyPrompt")
      : runCases.length === 0
        ? t("promptStudio.testSet.run.noCases")
        : otherRunning
          ? t("styles.test.otherRunRunning")
          : null;

  const start = () => {
    if (blocked || running) return;
    if (subject) {
      void startStyleTestRun({
        cases: runCases,
        style: subject.style,
        names: { a: nameA, b: nameB },
        agentName,
        destination: { provider: destination.label, model: destination.model },
      });
      return;
    }
    if (!editor) return;
    void startTestRun({
      cases: runCases,
      promptB: editor.isDefaultSelected
        ? { mode: "builtin" }
        : { mode: "text", text: editor.editorText },
      names: { a: activeName, b: nameB },
      agentName,
      destination: { provider: destination.label, model: destination.model },
    });
  };

  return (
    <div className="divide-y divide-border/60 dark:divide-border-subtle">
      <div className="px-5 py-4 space-y-2">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t(subject ? "styles.test.setIntro" : "promptStudio.testSet.intro")}
        </p>
        <div className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 px-4 py-3">
          <Info className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("promptStudio.testSet.copiesNotice")}
          </p>
        </div>
        {state.loaded && !state.durable && (
          <div className="flex items-start gap-2.5 rounded-lg border border-warning/20 bg-warning/5 dark:bg-warning/10 px-4 py-3">
            <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(storageNoticeKey(state.storageReason))}
            </p>
          </div>
        )}
      </div>

      {/* ── Cases ── */}
      <div className="px-5 py-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs font-medium text-foreground">
            {t("promptStudio.testSet.casesTitle", { n: runCases.length })}
          </p>
          <div className="flex items-center gap-1">
            {hiddenCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => showStarters(hiddenIds)}
              >
                {t("promptStudio.testSet.actions.showHidden", { n: hiddenCount })}
              </Button>
            )}
            {ownCases.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-destructive"
                disabled={running}
                onClick={() => setConfirmClear(true)}
              >
                {t("promptStudio.testSet.actions.removeAll")}
              </Button>
            )}
          </div>
        </div>
        {ownCases.length === 0 && (
          <p className="text-xs text-muted-foreground/80 mb-2">
            {t(subject ? "styles.test.emptyCases" : "promptStudio.testSet.emptyCases")}
          </p>
        )}
        <ul className="space-y-1.5">
          {ownCases.map((testCase) =>
            editingId === testCase.id ? (
              <CaseEditor
                key={testCase.id}
                testCase={testCase}
                styleChecks={!!subject}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <CaseRow
                key={testCase.id}
                label={caseLabel(testCase)}
                source={testCase.source}
                durable={testCase.durable}
                targetApp={testCase.targetApp}
                checks={
                  testCase.mustContain.length +
                  testCase.mustNotContain.length +
                  countStyleChecks(testCase.styleChecks)
                }
                disabled={running}
                onEdit={() => setEditingId(testCase.id)}
                onRemove={() => void deleteTestCase(testCase.id)}
                onOpenInHistory={
                  testCase.sourceTranscriptionId !== null
                    ? () => requestOpenHistoryItem(testCase.sourceTranscriptionId as number)
                    : undefined
                }
              />
            )
          )}
          {starters.map((starter) => (
            <CaseRow
              key={starter.id}
              label={starterLabel(starter)}
              source="starter"
              durable
              targetApp={starter.targetApp}
              checks={
                starter.mustContain.length +
                starter.mustNotContain.length +
                countStyleChecks(starter.styleChecks)
              }
              disabled={running}
              onHide={() => hideStarter(starter.id)}
            />
          ))}
        </ul>
      </div>

      {/* ── Run ── */}
      <div className="px-5 py-4 space-y-3">
        <div className="space-y-1">
          <p dir="auto" className="text-xs text-foreground">
            {subject
              ? t("styles.test.sideA")
              : t("promptStudio.testSet.run.promptA", { name: activeName })}
          </p>
          <p dir="auto" className="text-xs text-foreground">
            {subject
              ? t("styles.test.sideB")
              : t("promptStudio.testSet.run.promptB", { name: nameB })}
          </p>
          {subject?.isDraft && (
            <p className="text-xs text-muted-foreground/80">{t("styles.test.runsDraft")}</p>
          )}
          {samePrompt && (
            <p className="text-xs text-muted-foreground/80">
              {t("promptStudio.testSet.run.samePrompt")}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            {t("promptStudio.testSet.run.repetitions")}
          </p>
          <div className="flex gap-1">
            {REPETITION_CHOICES.map((choice) => (
              <Button
                key={choice}
                size="sm"
                variant={state.repetitions === choice ? "default" : "outline"}
                className="h-7 w-8 px-0 text-xs"
                disabled={running}
                onClick={() => setRepetitions(choice)}
              >
                {choice}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-1 text-xs text-muted-foreground leading-relaxed">
          <p>
            {subject
              ? t("styles.test.estimate", {
                  cases: Math.min(runCases.length, MAX_RUN_CASES),
                  runs: state.repetitions,
                  requests,
                  duration,
                })
              : t("promptStudio.testSet.run.estimate", {
                  cases: Math.min(runCases.length, MAX_RUN_CASES),
                  runs: state.repetitions,
                  requests,
                  duration,
                })}
          </p>
          {runCases.length > MAX_RUN_CASES && (
            <p className="text-warning">
              {t("promptStudio.testSet.run.capNote", {
                max: MAX_RUN_CASES,
                left: runCases.length - MAX_RUN_CASES,
              })}
            </p>
          )}
          <p>
            {t("promptStudio.testSet.run.model")}{" "}
            <span dir="ltr" className="font-mono text-foreground">
              {destination.model || t("promptStudio.test.none")}
            </span>
          </p>
          <p>
            {t("promptStudio.testSet.run.destination")}{" "}
            <span dir="auto" className="font-medium text-foreground">
              {destination.label}
            </span>
          </p>
          {!destination.local && (
            <p className="text-warning">{t("promptStudio.testSet.run.usageWarning")}</p>
          )}
          <p>{t("promptStudio.testSet.run.dictationFirst")}</p>
        </div>

        {running ? (
          <Button
            onClick={stopTestRun}
            variant="outline"
            size="sm"
            className="w-full"
            disabled={run?.progress.stopReason === "user"}
          >
            <X className="w-3.5 h-3.5 me-2" />
            {t("promptStudio.testSet.run.stop")}
          </Button>
        ) : (
          <Button onClick={start} disabled={blocked !== null} size="sm" className="w-full">
            <Play className="w-3.5 h-3.5 me-2" />
            {t("promptStudio.testSet.run.start")}
          </Button>
        )}
        {!running && blocked && <p className="text-xs text-muted-foreground/80">{blocked}</p>}
      </div>

      {run && (
        <RunResults run={run} onlyAttention={onlyAttention} onToggleAttention={setOnlyAttention} />
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t(subject ? "styles.test.removeAllTitle" : "promptStudio.testSet.removeAllTitle")}
        description={t(
          subject ? "styles.test.removeAllDescription" : "promptStudio.testSet.removeAllDescription"
        )}
        confirmText={t("promptStudio.testSet.actions.removeAll")}
        cancelText={t("promptStudio.testSet.actions.cancel")}
        variant="destructive"
        onConfirm={() => void clearTestCases(target)}
      />
    </div>
  );
}

/** How many bullet and numbered-item counts a case sets. */
function countStyleChecks(checks: Partial<PromptTestStyleChecks> | null | undefined): number {
  if (!checks) return 0;
  return Object.values(checks).filter((value) => typeof value === "number").length;
}

interface CaseRowProps {
  label: string;
  source: PromptTestCase["source"] | "starter";
  durable: boolean;
  targetApp: string | null;
  checks: number;
  disabled: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
  onHide?: () => void;
  onOpenInHistory?: () => void;
}

function CaseRow({
  label,
  source,
  durable,
  targetApp,
  checks,
  disabled,
  onEdit,
  onRemove,
  onHide,
  onOpenInHistory,
}: CaseRowProps) {
  const { t } = useTranslation();
  const badge = "text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded";
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border/60 dark:border-border-subtle px-3 py-2">
      <div className="min-w-0 flex-1">
        <p dir="auto" className="truncate text-xs text-foreground">
          {label}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className={cn(badge, "bg-muted text-muted-foreground")}>
            {t(`promptStudio.testSet.source.${source}`)}
          </span>
          {!durable && (
            <span className={cn(badge, "bg-warning/10 text-warning")}>
              {t("promptStudio.testSet.sessionOnly")}
            </span>
          )}
          {targetApp && (
            <span className={cn(badge, "bg-primary/10 text-primary normal-case")}>
              {t("promptStudio.testSet.targetApp")} <bdi dir="ltr">{targetApp}</bdi>
            </span>
          )}
          {checks > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {t("promptStudio.testSet.checksCount", { n: checks })}
            </span>
          )}
        </div>
      </div>
      {onOpenInHistory && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("promptStudio.testSet.actions.openInHistory")}
          title={t("promptStudio.testSet.actions.openInHistory")}
          onClick={onOpenInHistory}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </Button>
      )}
      {onEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("promptStudio.testSet.actions.edit")}
          title={t("promptStudio.testSet.actions.edit")}
          disabled={disabled}
          onClick={onEdit}
        >
          <Pencil className="w-3.5 h-3.5" />
        </Button>
      )}
      {onRemove && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive"
          aria-label={t("promptStudio.testSet.actions.delete")}
          title={t("promptStudio.testSet.actions.delete")}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      )}
      {onHide && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={disabled}
          onClick={onHide}
        >
          {t("promptStudio.testSet.actions.hide")}
        </Button>
      )}
    </li>
  );
}

const STYLE_CHECK_FIELDS: ReadonlyArray<{ key: StyleCountCheckKind; labelKey: string }> = [
  { key: "bulletsMin", labelKey: "promptStudio.testSet.edit.bulletsMin" },
  { key: "bulletsMax", labelKey: "promptStudio.testSet.edit.bulletsMax" },
  { key: "numberedMin", labelKey: "promptStudio.testSet.edit.numberedMin" },
  { key: "numberedMax", labelKey: "promptStudio.testSet.edit.numberedMax" },
];

function countText(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "";
}

function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function CaseEditor({
  testCase,
  styleChecks: showStyleChecks = false,
  onDone,
}: {
  testCase: PromptTestCase;
  /** A style's case: the bullet and numbered-item counts are editable too. */
  styleChecks?: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(testCase.label ?? "");
  const [targetApp, setTargetApp] = useState(testCase.targetApp ?? "");
  const [mustContain, setMustContain] = useState(testCase.mustContain.join("\n"));
  const [mustNotContain, setMustNotContain] = useState(testCase.mustNotContain.join("\n"));
  const [matchCase, setMatchCase] = useState(testCase.matchCase);
  const [counts, setCounts] = useState<Record<StyleCountCheckKind, string>>(() => ({
    bulletsMin: countText(testCase.styleChecks?.bulletsMin),
    bulletsMax: countText(testCase.styleChecks?.bulletsMax),
    numberedMin: countText(testCase.styleChecks?.numberedMin),
    numberedMax: countText(testCase.styleChecks?.numberedMax),
  }));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await updateTestCase(testCase.id, {
      label,
      targetApp,
      mustContain: linesToList(mustContain),
      mustNotContain: linesToList(mustNotContain),
      matchCase,
      styleChecks: {
        bulletsMin: parseCount(counts.bulletsMin),
        bulletsMax: parseCount(counts.bulletsMax),
        numberedMin: parseCount(counts.numberedMin),
        numberedMax: parseCount(counts.numberedMax),
      },
    });
    setSaving(false);
    onDone();
  };

  return (
    <li className="space-y-2 rounded-lg border border-primary/30 px-3 py-3">
      <ClampedText collapsedRem={6}>
        <pre dir="auto" className="whitespace-pre-wrap text-xs text-muted-foreground">
          {testCase.rawText}
        </pre>
      </ClampedText>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">
          {t("promptStudio.testSet.edit.label")}
        </span>
        <Input
          dir="auto"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("promptStudio.testSet.edit.labelPlaceholder")}
          className="h-8 text-xs"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">
          {t("promptStudio.testSet.edit.targetApp")}
        </span>
        <Input
          dir="ltr"
          value={targetApp}
          onChange={(e) => setTargetApp(e.target.value)}
          placeholder="Code.exe"
          className="h-8 text-xs font-mono"
        />
        <span className="block text-[11px] text-muted-foreground/80">
          {t("promptStudio.testSet.edit.targetAppHint")}
        </span>
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">
            {t("promptStudio.testSet.edit.mustContain")}
          </span>
          <AutoGrowTextarea
            dir="auto"
            value={mustContain}
            onChange={(e) => setMustContain(e.target.value)}
            minRows={3}
            className="text-xs"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">
            {t("promptStudio.testSet.edit.mustNotContain")}
          </span>
          <AutoGrowTextarea
            dir="auto"
            value={mustNotContain}
            onChange={(e) => setMustNotContain(e.target.value)}
            minRows={3}
            className="text-xs"
          />
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground/80">
        {t("promptStudio.testSet.edit.checksHint")}
      </p>
      {showStyleChecks && (
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {STYLE_CHECK_FIELDS.map((field) => (
              <label key={field.key} className="block space-y-1">
                <span className="text-xs text-muted-foreground">{t(field.labelKey)}</span>
                <Input
                  dir="ltr"
                  type="number"
                  min={0}
                  max={100}
                  value={counts[field.key]}
                  onChange={(e) => setCounts((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  className="h-8 text-xs"
                />
              </label>
            ))}
          </div>
          <span className="block text-[11px] text-muted-foreground/80">
            {t("promptStudio.testSet.edit.countsHint")}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Toggle
          checked={matchCase}
          onChange={setMatchCase}
          ariaLabel={t("promptStudio.testSet.edit.matchCase")}
        />
        <span className="text-xs text-muted-foreground">
          {t("promptStudio.testSet.edit.matchCase")}
        </span>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onDone}>
          {t("promptStudio.testSet.actions.cancel")}
        </Button>
        <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={() => void save()}>
          {t("promptStudio.testSet.actions.save")}
        </Button>
      </div>
    </li>
  );
}

const STOP_REASON_KEYS = {
  user: "promptStudio.testSet.results.stopReason.user",
  account: "promptStudio.testSet.results.stopReason.account",
  auth: "promptStudio.testSet.results.stopReason.auth",
  quota: "promptStudio.testSet.results.stopReason.quota",
  config: "promptStudio.testSet.results.stopReason.config",
  rateLimit: "promptStudio.testSet.results.stopReason.rateLimit",
  errors: "promptStudio.testSet.results.stopReason.errors",
  settings: "promptStudio.testSet.results.stopReason.settings",
} as const;

function RunResults({
  run,
  onlyAttention,
  onToggleAttention,
}: {
  run: TestRunInfo;
  onlyAttention: boolean;
  onToggleAttention: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const { progress } = run;
  const finished = progress.phase === "finished";
  const summary = summarizeRun(progress.results, progress.stopReason);
  const shown = onlyAttention ? progress.results.filter(needsAttention) : progress.results;
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const names: Record<PromptSide, string> = { A: run.promptA.name, B: run.promptB.name };

  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">
          {t("promptStudio.testSet.results.title")}
        </p>
        {finished && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearTestResults}>
            {t("promptStudio.testSet.results.clear")}
          </Button>
        )}
      </div>

      {!finished && (
        <div className="space-y-1.5">
          <Progress value={percent} />
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t("promptStudio.testSet.progress.count", {
              done: progress.done,
              total: progress.total,
            })}
            {progress.phase === "pausedForDictation" && (
              <span className="text-warning">{t("promptStudio.testSet.progress.paused")}</span>
            )}
            {progress.phase === "waiting" && (
              <span className="text-warning">{t("promptStudio.testSet.progress.waiting")}</span>
            )}
          </p>
        </div>
      )}

      {finished && summary.partial && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/20 bg-warning/5 dark:bg-warning/10 px-4 py-3">
          <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("promptStudio.testSet.results.partial", {
              completed: summary.requests.completed,
              total: progress.total,
            })}{" "}
            {progress.stopReason ? t(STOP_REASON_KEYS[progress.stopReason]) : null}
          </p>
        </div>
      )}

      <div className="rounded-lg border border-border/60 dark:border-border-subtle px-4 py-3 space-y-1 text-xs text-muted-foreground">
        <p dir="auto">{t("promptStudio.testSet.results.sides", { a: names.A, b: names.B })}</p>
        <p>
          {t("promptStudio.testSet.results.compared", {
            compared: summary.compared,
            cases: summary.cases,
          })}
        </p>
        <p className="text-foreground">
          {t("promptStudio.testSet.results.passed", {
            a: summary.sides.A.passed,
            b: summary.sides.B.passed,
            compared: summary.compared,
          })}
        </p>
        <p>
          {t("promptStudio.testSet.results.differ", {
            differ: summary.differ,
            compared: summary.compared,
          })}
        </p>
        <p>
          {t("promptStudio.testSet.results.median", {
            a: seconds(summary.sides.A.medianMs),
            b: seconds(summary.sides.B.medianMs),
          })}
        </p>
        <p>
          {t("promptStudio.testSet.results.fillers", {
            a: summary.sides.A.withFillers,
            b: summary.sides.B.withFillers,
          })}
        </p>
        <p>
          {t("promptStudio.testSet.results.requests", {
            completed: summary.requests.completed,
            errors: summary.requests.error,
            cancelled: summary.requests.cancelled,
            skipped: summary.requests.skipped,
          })}
        </p>
        <p className="text-muted-foreground/70">{t("promptStudio.testSet.results.sessionOnly")}</p>
      </div>

      <div className="flex items-center gap-2">
        <Toggle
          checked={onlyAttention}
          onChange={onToggleAttention}
          ariaLabel={t("promptStudio.testSet.results.filter")}
        />
        <span className="text-xs text-muted-foreground">
          {t("promptStudio.testSet.results.filter")}
        </span>
      </div>

      {onlyAttention && finished && shown.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("promptStudio.testSet.results.noneShown")}
        </p>
      )}
      <ul className="space-y-3">
        {shown.map((result) => (
          <CaseResultRow key={result.caseId} result={result} />
        ))}
      </ul>
    </div>
  );
}

function Highlighted({ segments }: { segments: WordDiffSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "same" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <mark
            key={index}
            className={cn(
              "rounded-sm px-0.5 text-foreground",
              segment.kind === "removed" ? "bg-destructive/15" : "bg-success/20"
            )}
          >
            {segment.text}
          </mark>
        )
      )}
    </>
  );
}

function firstOutput(runs: RequestOutcome[], index: number): string | null {
  const paired = runs[index];
  if (paired?.status === "completed" && typeof paired.output === "string") return paired.output;
  const any = runs.find((run) => run.status === "completed" && typeof run.output === "string");
  return any?.output ?? null;
}

function CaseResultRow({ result }: { result: CaseResult }) {
  const { t } = useTranslation();
  const compared = isCompared(result);
  const verdict = (side: PromptSide) =>
    !compared ? null : sidePassed(result, side) ? "pass" : "fail";
  const corrected = result.input.corrected !== result.input.raw;

  return (
    <li className="rounded-lg border border-border/60 dark:border-border-subtle px-3 py-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p dir="auto" className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {result.label}
        </p>
        {!compared && (
          <span className="text-[10px] uppercase tracking-wide text-warning">
            {t("promptStudio.testSet.results.notCompared")}
          </span>
        )}
        {PROMPT_SIDES.map((side) => {
          const outcome = verdict(side);
          if (!outcome) return null;
          return (
            <span
              key={side}
              className={cn(
                "text-[10px] font-medium px-1.5 py-px rounded",
                outcome === "pass"
                  ? "bg-success/15 text-success"
                  : "bg-destructive/10 text-destructive"
              )}
            >
              {side}:{" "}
              {outcome === "pass"
                ? t("promptStudio.testSet.results.pass")
                : t("promptStudio.testSet.results.fail")}
            </span>
          );
        })}
      </div>

      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("promptStudio.testSet.results.input")}
          {result.input.targetApp && (
            <>
              {" · "}
              {t("promptStudio.testSet.targetApp")} <bdi dir="ltr">{result.input.targetApp}</bdi>
            </>
          )}
        </p>
        <p dir="auto" className="text-xs text-muted-foreground whitespace-pre-wrap">
          {result.input.raw}
        </p>
        {corrected ? (
          <>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("promptStudio.testSet.results.corrected")}
            </p>
            <p dir="auto" className="text-xs text-foreground whitespace-pre-wrap">
              {result.input.corrected}
            </p>
          </>
        ) : (
          <p className="text-[10px] text-muted-foreground/70">
            {t("promptStudio.testSet.results.notCorrected")}
          </p>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {PROMPT_SIDES.map((side) => {
          const other: PromptSide = side === "A" ? "B" : "A";
          return (
            <div key={side} className="space-y-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {side}
              </p>
              {result.runs[side].map((run, index) => (
                <RunCell
                  key={index}
                  index={index}
                  run={run}
                  side={side}
                  otherOutput={firstOutput(result.runs[other], index)}
                />
              ))}
            </div>
          );
        })}
      </div>

      {result.referenceText && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {t("promptStudio.testSet.results.reference")}
          </summary>
          <p dir="auto" className="mt-1 whitespace-pre-wrap">
            {result.referenceText}
          </p>
        </details>
      )}
    </li>
  );
}

function ChecksList({ checks }: { checks: OutputChecks }) {
  const { t } = useTranslation();
  const items: Array<{ key: string; label: string; ok: boolean | null }> = [
    {
      key: "repeat",
      label: t("promptStudio.testSet.results.check.notRepeated"),
      ok: checks.notDuplicated,
    },
    ...checks.mustContain.map((check, index) => ({
      key: `c${index}`,
      label: t("promptStudio.testSet.results.check.contains", { text: check.text }),
      ok: check.ok,
    })),
    ...checks.mustNotContain.map((check, index) => ({
      key: `n${index}`,
      label: t("promptStudio.testSet.results.check.notContains", { text: check.text }),
      ok: check.ok,
    })),
    ...(checks.structure ?? []).map((check) => ({
      key: `s-${check.kind}`,
      label: t(`promptStudio.testSet.results.check.${check.kind}`, {
        limit: check.limit,
        actual: check.actual ?? "–",
      }),
      ok: check.ok,
    })),
  ];
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li
          key={item.key}
          className={cn(
            "flex items-center gap-1 text-[11px]",
            item.ok === true
              ? "text-success"
              : item.ok === false
                ? "text-destructive"
                : "text-muted-foreground"
          )}
        >
          {item.ok === true ? (
            <Check className="w-3 h-3 shrink-0" />
          ) : item.ok === false ? (
            <X className="w-3 h-3 shrink-0" />
          ) : (
            <span className="w-3 shrink-0 text-center">–</span>
          )}
          <span dir="auto">
            {item.label}
            {item.ok === null && ` (${t("promptStudio.testSet.results.check.notChecked")})`}
          </span>
        </li>
      ))}
      {checks.fillers.length > 0 && (
        <li className="text-[11px] text-warning">
          {t("promptStudio.testSet.results.fillersFound", { words: checks.fillers.join(", ") })}
        </li>
      )}
    </ul>
  );
}

function RunCell({
  index,
  run,
  side,
  otherOutput,
}: {
  index: number;
  run: RequestOutcome;
  side: PromptSide;
  otherOutput: string | null;
}) {
  const { t } = useTranslation();
  const header = (
    <p className="text-[10px] text-muted-foreground">
      {t("promptStudio.testSet.results.run", { n: index + 1 })}
      {typeof run.ms === "number" &&
        ` · ${t("promptStudio.testSet.results.time", { seconds: seconds(run.ms) })}`}
    </p>
  );

  if (run.status === "completed") {
    let body;
    if (run.rejected) {
      body = (
        <p className="text-xs text-destructive">
          {t("promptStudio.testSet.results.status.repeated")}
        </p>
      );
    } else {
      const output = run.output ?? "";
      const segments =
        otherOutput === null
          ? [{ text: output, kind: "same" as const }]
          : side === "A"
            ? diffWords(output, otherOutput).a
            : diffWords(otherOutput, output).b;
      body = (
        <p dir="auto" className="text-xs text-foreground whitespace-pre-wrap">
          <Highlighted segments={segments} />
        </p>
      );
    }
    return (
      <div className="rounded-md bg-muted/30 dark:bg-surface-raised/30 px-2.5 py-2 space-y-1.5">
        {header}
        {body}
        {run.checks && <ChecksList checks={run.checks} />}
      </div>
    );
  }

  const description =
    run.status !== "error"
      ? t(`promptStudio.testSet.results.status.${run.status}`)
      : run.code === "EMPTY_REPLY"
        ? t("promptStudio.testSet.results.status.emptyReply")
        : run.code === "TRUNCATED"
          ? t("promptStudio.testSet.results.status.truncated")
          : `${t("promptStudio.testSet.results.status.error")}: ${
              describeProviderError(run, t).description || run.code || ""
            }`;
  return (
    <div className="rounded-md border border-dashed border-border/60 px-2.5 py-2 space-y-1">
      {header}
      <p
        dir="auto"
        className={cn(
          "text-xs",
          run.status === "error" ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {description}
      </p>
    </div>
  );
}

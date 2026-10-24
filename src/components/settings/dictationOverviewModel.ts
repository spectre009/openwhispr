import {
  selectPolicyEffectiveSettings,
  selectResolvedLLMConfig,
  type SettingsState,
} from "../../stores/settingsStore";
import type { PolicyDecisionSnapshot } from "../../stores/policyRules";
import {
  PLAIN_STYLE_ID,
  findStyle,
  type DictationStyle,
  type StyleHotkeyBinding,
  type StyleLibrary,
} from "../../config/styles/library";
import { activeGlossaryRules, type GlossaryRule } from "../../utils/glossary";
import { formatHotkeyListLabel } from "../../utils/hotkeys";
import type {
  TranscriptionItem,
  TranscriptionStepRecord,
  TranscriptionStepsResult,
} from "../../types/electron";
import { stepKindLabel, stepOutcomeLabel } from "../ui/transcriptionStepLabels";
import { describeLlm } from "./search/searchContext";
import type { Translate } from "./search/searchIndex";
import type { ElsewhereLocation } from "./search/types";
import { activePromptName } from "./featurePageStatus";
import { SETTINGS_PAGES, type SettingsPageId } from "./settingsPages";
import type { PickerText } from "./modelPicker/options";
import {
  describeSttSelection,
  sttSelectionIssue,
  type SttPickerContext,
} from "./modelPicker/sttOptions";

/**
 * Dictation › Overview, as data: the pipeline strip's six nodes from the
 * current settings (the same resolvers the feature pages and pickers use), and
 * the last dictation's saved steps as columns. Pure, so the values are tested
 * without rendering. Nothing here writes a setting or logs dictated text.
 */

export type OverviewNodeId =
  "recognition" | "dictionary" | "cleanup" | "style" | "personality" | "output";

/** Where a node opens: a Settings page, or an app page outside Settings. */
export type OverviewTarget =
  { kind: "page"; page: SettingsPageId } | { kind: "elsewhere"; location: ElsewhereLocation };

export interface OverviewNode {
  id: OverviewNodeId;
  title: string;
  /** The current setting, e.g. provider · model. */
  value: string;
  /** One line under it, e.g. the prompt in use. */
  status: string;
  /** Why it can't run as set up (Recognition's picker warning). */
  warning?: string;
  /** Switched off: drawn dimmed, still opens its page. */
  off?: boolean;
  /** Not built yet: drawn dimmed, not a button. */
  planned?: boolean;
  target?: OverviewTarget;
}

export interface DictationPipelineInput {
  /** The raw store state; policy is applied here, as the feature pages apply it. */
  settings: SettingsState;
  policy: PolicyDecisionSnapshot;
  /** Recognition's picker context (useSttPickerContext("dictation")). */
  stt: SttPickerContext;
  styleLibrary: StyleLibrary;
  styleBindings: readonly StyleHotkeyBinding[];
  glossaryRules: readonly GlossaryRule[] | null | undefined;
  /** Auto-learn from corrections (a localStorage preference SettingsPage owns, not a store field). */
  autoLearn: boolean;
  t: Translate;
}

function pickerText(t: Translate, value: PickerText | undefined): string {
  if (!value) return "";
  return "text" in value ? value.text : t(value.key, value.params);
}

/** A style as lists show it: emoji, then name. */
export function styleLabel(style: Pick<DictationStyle, "emoji" | "name">): string {
  return `${style.emoji ? `${style.emoji} ` : ""}${style.name}`;
}

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/** The strip, in order: Recognition → Dictionary & glossary → Cleanup → Style → Personality → Output. */
export function buildDictationPipeline(input: DictationPipelineInput): OverviewNode[] {
  const { settings, policy, stt, styleLibrary, styleBindings, t } = input;
  const effective = selectPolicyEffectiveSettings(settings, policy);
  const onOff = (on: boolean) => t(on ? "settingsNav.switch.on" : "settingsNav.switch.off");
  const settingState = (titleKey: string, on: boolean) =>
    t("settingsOverview.pipeline.settingState", { setting: t(titleKey), state: onOff(on) });

  // Recognition: what the picker's button says, and its can't-run warning.
  const summary = describeSttSelection("dictation", stt);
  const issue = sttSelectionIssue("dictation", stt);
  const recognition: OverviewNode = {
    id: "recognition",
    title: t(SETTINGS_PAGES.recognition.titleKey),
    value: pickerText(t, summary.title),
    status: pickerText(t, summary.sub),
    target: { kind: "page", page: "recognition" },
  };
  if (issue) recognition.warning = t(issue.reasonKey, issue.reasonParams);

  const dictionary: OverviewNode = {
    id: "dictionary",
    title: t("settingsNav.elsewhere.dictionary"),
    value: t("settingsOverview.pipeline.dictionary.counts", {
      words: count(settings.customDictionary),
      rules: activeGlossaryRules(input.glossaryRules as GlossaryRule[] | null).length,
      snippets: count(settings.snippets),
    }),
    status: t("settingsOverview.pipeline.dictionary.status"),
    target: { kind: "elsewhere", location: { view: "dictionary" } },
  };

  // Cleanup: as its page header shows it (provider · model, the prompt in use).
  const cleanupOn = effective.useCleanupModel;
  const cleanupModel = describeLlm(selectResolvedLLMConfig(effective, "dictationCleanup"), t);
  const cleanup: OverviewNode = {
    id: "cleanup",
    title: t(SETTINGS_PAGES.cleanup.titleKey),
    value: cleanupOn ? cleanupModel.display : onOff(false),
    status: cleanupOn
      ? t("settingsNav.pills.prompt", {
          name: activePromptName(settings.promptLibraries?.cleanup, t),
        })
      : t("settingsOverview.pipeline.cleanup.offStatus"),
    off: !cleanupOn,
    target: { kind: "page", page: "cleanup" },
  };

  // Style: what the dictation hotkey applies, and how many styles are on or have a key.
  const hotkeyStyle =
    styleLibrary.dictationStyleId === PLAIN_STYLE_ID
      ? undefined
      : findStyle(styleLibrary, styleLibrary.dictationStyleId);
  const style: OverviewNode = {
    id: "style",
    title: t("controlPanel.history.steps.kinds.style"),
    value: t("settingsOverview.pipeline.style.value", {
      hotkey: formatHotkeyListLabel(settings.dictationKey),
      style: hotkeyStyle ? styleLabel(hotkeyStyle) : t("styles.plain.name"),
    }),
    status: t("settingsOverview.pipeline.style.status", {
      on: styleLibrary.styles.filter((entry) => entry.enabled).length,
      total: styleLibrary.styles.length,
      keys: styleBindings.length,
    }),
    target: { kind: "page", page: "styles" },
  };

  const personality: OverviewNode = {
    id: "personality",
    title: t("settingsOverview.pipeline.personality.title"),
    value: t("settingsOverview.pipeline.personality.value"),
    status: t("settingsOverview.pipeline.personality.status"),
    planned: true,
  };

  const output: OverviewNode = {
    id: "output",
    title: t(SETTINGS_PAGES.output.titleKey),
    value: settingState("settingsPage.general.clipboard.autoPaste", !!settings.autoPasteEnabled),
    status: settingState("settingsPage.dictionary.autoLearnTitle", input.autoLearn),
    target: { kind: "page", page: "output" },
  };

  return [recognition, dictionary, cleanup, style, personality, output];
}

// ── Last dictation ────────────────────────────────────────────────────────

/** The newest completed dictation in History's list (newest first), if any. */
export function pickLastDictation(
  transcriptions: readonly TranscriptionItem[] | null | undefined
): TranscriptionItem | undefined {
  return (transcriptions ?? []).find((item) => item.status === "completed" && !item.deleted_at);
}

export interface GlossarySegment {
  text: string;
  /** What the glossary replaced ("removed") and what it wrote ("added"). */
  change?: "removed" | "added";
}

type FiredRule = NonNullable<NonNullable<TranscriptionStepRecord["detail"]>["rulesFired"]>[number];

/**
 * The speech-to-text text with the glossary's corrections marked: each fired
 * rule's spoken text struck, its canonical form after it. Null when the saved
 * offsets don't line up with the text (then the column shows the corrected
 * text as is).
 */
export function glossaryDiffSegments(
  input: string | null | undefined,
  fired: readonly FiredRule[] | null | undefined
): GlossarySegment[] | null {
  if (typeof input !== "string" || !Array.isArray(fired) || fired.length === 0) return null;
  const edits = [...fired].sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
  const segments: GlossarySegment[] = [];
  let at = 0;
  for (const edit of edits) {
    const { from, to, index } = edit;
    if (typeof from !== "string" || !from || typeof to !== "string") return null;
    if (typeof index !== "number" || !Number.isInteger(index) || index < at) return null;
    if (input.slice(index, index + from.length) !== from) return null;
    if (index > at) segments.push({ text: input.slice(at, index) });
    segments.push({ text: from, change: "removed" });
    segments.push({ text: to, change: "added" });
    at = index + from.length;
  }
  if (at < input.length) segments.push({ text: input.slice(at) });
  return segments;
}

export interface LastDictationColumn {
  key: string;
  label: string;
  /** "Failed", "Skipped", "Kept previous text"; null when the step simply ran. */
  outcome: string | null;
  /** The step's text (glossary: `segments` when its corrections can be marked). */
  text?: string;
  segments?: GlossarySegment[];
  /** Said instead of text ("No corrections"). */
  note?: string;
  /** Style, model, time: what View steps lists beside the name. */
  facts: string[];
}

/**
 * The saved steps side by side, named as History › View steps names them,
 * then what was pasted (the target app and the total time). A finalize step
 * that changed nothing is left out.
 */
export function lastDictationColumns(
  result: TranscriptionStepsResult,
  { t, styleLibrary }: { t: Translate; styleLibrary: StyleLibrary }
): LastDictationColumn[] {
  const columns: LastDictationColumn[] = [];
  let sttText: string | null = null;
  let previousText: string | null = null;
  let totalMs = 0;

  for (const [index, step] of result.steps.entries()) {
    if (typeof step.ms === "number" && Number.isFinite(step.ms)) totalMs += step.ms;
    const output = typeof step.output === "string" ? step.output : null;
    if (step.kind === "stt") sttText = output;
    if (step.kind === "finalize" && step.outcome === "ok" && output === previousText) continue;

    const facts: string[] = [];
    if (step.kind === "style" && step.detail?.styleId) {
      const style = findStyle(styleLibrary, step.detail.styleId);
      facts.push(style ? styleLabel(style) : t("controlPanel.history.steps.deletedStyle"));
      if (step.detail.runMode === "one-step") facts.push(t("styles.runMode.oneStep"));
      else if (step.detail.runMode === "two-step") facts.push(t("styles.runMode.twoSteps"));
    }
    if (step.model) facts.push(step.model);
    if (typeof step.ms === "number" && step.kind !== "finalize") {
      facts.push(t("controlPanel.history.steps.durationMs", { ms: step.ms }));
    }

    const column: LastDictationColumn = {
      key: `${step.kind}-${index}`,
      label: stepKindLabel(step, t),
      outcome: stepOutcomeLabel(step.outcome, t),
      facts,
    };
    if (step.kind === "glossary" && step.outcome === "ok") {
      const fired = step.detail?.rulesFired ?? [];
      if (fired.length === 0) column.note = t("settingsOverview.last.noCorrections");
      else {
        const segments = glossaryDiffSegments(sttText, fired);
        if (segments) column.segments = segments;
        else if (output !== null) column.text = output;
        facts.unshift(t("controlPanel.history.steps.corrections", { n: fired.length }));
      }
    } else if (step.outcome !== "skipped" && output !== null) {
      column.text = output;
    }
    if (output !== null && step.outcome !== "skipped") previousText = output;
    columns.push(column);
  }

  const pastedFacts: string[] = [];
  const targetApp = result.context?.targetApp;
  if (targetApp) pastedFacts.push(t("controlPanel.history.steps.targetApp", { app: targetApp }));
  if (totalMs > 0) {
    pastedFacts.push(t("settingsOverview.last.total", { seconds: (totalMs / 1000).toFixed(1) }));
  }
  columns.push({
    key: "pasted",
    label: t("settingsOverview.last.pasted"),
    outcome: null,
    facts: pastedFacts,
  });
  return columns;
}

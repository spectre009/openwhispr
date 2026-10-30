import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  AlertTriangle,
  AudioLines,
  BookOpen,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  Loader2,
  Pencil,
  User,
  Wand2,
} from "../icons";
import { cn } from "../lib/utils";
import ClampedText from "../ui/ClampedText";
import { useSettingsStore } from "../../stores/settingsStore";
import { useStyleStore } from "../../stores/styleStore";
import { useGlossaryStore } from "../../stores/glossaryStore";
import { useTranscriptions } from "../../stores/transcriptionStore";
import { effectiveLocalHistoryEnabled } from "../../stores/policyRules";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { useHotkeyModeInfo } from "../../hooks/useHotkeyModeInfo";
import { findStyle, type StyleLibrary } from "../../config/styles/library";
import { formatHotkeyLabel, formatHotkeyListLabel, parseHotkeyList } from "../../utils/hotkeys";
import { getCachedPlatform } from "../../utils/platform";
import { requestOpenHistoryItem } from "../../utils/openHistoryItem";
import type { TranscriptionStepsResult } from "../../types/electron";
import { SettingsLink } from "./ManageKeysLink";
import { HotkeyKbd } from "./HotkeyTable";
import { useSettingsVisible } from "./useSettingsVisible";
import { useSttPickerContext } from "./modelPicker/useSttPickerContext";
import type { Translate } from "./search/searchIndex";
import type { ElsewhereLocation } from "./search/types";
import type { SettingsPageId } from "./settingsPages";
import {
  buildDictationPipeline,
  lastDictationColumns,
  pickLastDictation,
  styleLabel,
  type LastDictationColumn,
  type OverviewNode,
  type OverviewNodeId,
  type OverviewTarget,
} from "./dictationOverviewModel";

// Dictation › Overview: what happens between the hotkey and the pasted text,
// each step showing its current setting and opening its page; the last
// dictation's saved steps (step history, as History › View steps reads them);
// and the dictation and style hotkeys. Read-only: nothing here writes a
// setting, and dictated text is shown, never logged.

const NODE_ICONS: Record<OverviewNodeId, ComponentType<{ className?: string }>> = {
  recognition: AudioLines,
  dictionary: BookOpen,
  cleanup: Wand2,
  style: Pencil,
  personality: User,
  output: ClipboardCheck,
};

const cardClass =
  "rounded-xl border border-border/70 bg-card dark:border-border-subtle dark:bg-surface-2";

function SectionHeading({
  title,
  description,
  aside,
}: {
  title: string;
  description?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        <h3 className="text-xs font-semibold tracking-tight text-foreground">{title}</h3>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">{description}</p>
        )}
      </div>
      {aside}
    </div>
  );
}

function PipelineNode({
  node,
  onOpen,
}: {
  node: OverviewNode;
  onOpen: (target: OverviewTarget) => void;
}) {
  const Icon = NODE_ICONS[node.id];
  const leaves = node.target?.kind === "elsewhere";
  const body = (
    <>
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 text-xs font-semibold leading-snug text-foreground wrap-break-word">
          {node.title}
        </span>
        {leaves && (
          <ExternalLink
            aria-hidden="true"
            className="h-3 w-3 shrink-0 text-muted-foreground/60 rtl:-scale-x-100"
          />
        )}
      </span>
      <span dir="auto" className="text-[11.5px] leading-snug text-foreground/85 wrap-break-word">
        {node.value}
      </span>
      {node.warning && (
        <span className="flex items-start gap-1 text-[11px] leading-snug text-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{node.warning}</span>
        </span>
      )}
      <span
        dir="auto"
        className="mt-auto pt-1 text-[11px] leading-snug text-muted-foreground wrap-break-word"
      >
        {node.status}
      </span>
    </>
  );
  const shape =
    "flex min-h-28 w-full min-w-0 flex-col gap-1 rounded-lg border p-3 text-start outline-none transition-colors";
  if (node.planned || !node.target) {
    return (
      <div
        data-overview-node={node.id}
        aria-disabled="true"
        className={cn(shape, "border-dashed border-border/70 opacity-60 dark:border-white/15")}
      >
        {body}
      </div>
    );
  }
  const target = node.target;
  return (
    <button
      type="button"
      data-overview-node={node.id}
      onClick={() => onOpen(target)}
      className={cn(
        shape,
        "cursor-pointer bg-surface-1 hover:border-primary/50 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-surface-1",
        node.off
          ? "border-dashed border-border/70 opacity-70 dark:border-white/15"
          : "border-border/70 dark:border-border-subtle"
      )}
    >
      {body}
    </button>
  );
}

function StepColumn({ column }: { column: LastDictationColumn }) {
  return (
    <div data-step-column={column.key} className="min-w-0 bg-card px-3 py-2.5 dark:bg-surface-2">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="text-[11px] font-medium text-muted-foreground">{column.label}</span>
        {column.outcome && (
          <span className="rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {column.outcome}
          </span>
        )}
      </div>
      {column.segments ? (
        <ClampedText collapsedRem={7} className="mt-1">
          <p dir="auto" className="whitespace-pre-wrap wrap-break-word text-xs leading-relaxed">
            {column.segments.map((segment, index) =>
              segment.change === "removed" ? (
                <del key={index} className="text-destructive/80 decoration-destructive/60">
                  {segment.text}
                </del>
              ) : segment.change === "added" ? (
                <ins key={index} className="font-medium text-success no-underline">
                  {segment.text}
                </ins>
              ) : (
                <span key={index}>{segment.text}</span>
              )
            )}
          </p>
        </ClampedText>
      ) : column.text !== undefined ? (
        <ClampedText collapsedRem={7} className="mt-1">
          <p dir="auto" className="whitespace-pre-wrap wrap-break-word text-xs leading-relaxed">
            {column.text}
          </p>
        </ClampedText>
      ) : column.note ? (
        <p className="mt-1 text-xs italic text-muted-foreground/80">{column.note}</p>
      ) : null}
      {column.facts.length > 0 && (
        <p dir="auto" className="mt-1.5 text-[11px] leading-snug text-muted-foreground/80">
          {column.facts.join(" · ")}
        </p>
      )}
    </div>
  );
}

type StepsState =
  | { key: string; status: "loading" }
  | { key: string; status: "failed" }
  | { key: string; status: "loaded"; result: TranscriptionStepsResult };

/** The newest dictation's saved steps, side by side, read on demand like View steps. */
function LastDictationCard({
  historyOn,
  styleLibrary,
}: {
  historyOn: boolean;
  styleLibrary: StyleLibrary;
}) {
  const { t, i18n } = useTranslation();
  const translate = t as unknown as Translate;
  const visible = useSettingsVisible();
  const last = pickLastDictation(useTranscriptions());
  const id = last?.id;
  // A retry rewrites the row's text and its steps: reload then (as View steps does).
  const revision = last?.text ?? "";
  const key = id === undefined ? "" : `${id}`;
  const [steps, setSteps] = useState<StepsState | null>(null);
  const loadedRef = useRef<{ id: number; revision: string } | null>(null);

  useEffect(() => {
    if (!historyOn || id === undefined || !visible) return;
    const loaded = loadedRef.current;
    if (loaded && loaded.id === id && loaded.revision === revision) return;
    loadedRef.current = { id, revision };
    let cancelled = false;
    let settled = false;
    const load = window.electronAPI?.getTranscriptionSteps;
    if (!load) {
      setSteps({ key: `${id}`, status: "failed" });
      return;
    }
    setSteps({ key: `${id}`, status: "loading" });
    load(id).then(
      (reply) => {
        settled = true;
        if (cancelled) return;
        setSteps(
          reply?.success
            ? { key: `${id}`, status: "loaded", result: reply }
            : { key: `${id}`, status: "failed" }
        );
      },
      () => {
        settled = true;
        if (!cancelled) setSteps({ key: `${id}`, status: "failed" });
      }
    );
    return () => {
      cancelled = true;
      // Superseded before it answered (hidden, or a newer dictation): read it again next time.
      if (!settled && loadedRef.current?.id === id && loadedRef.current.revision === revision) {
        loadedRef.current = null;
      }
    };
  }, [historyOn, id, revision, visible]);

  const columns = useMemo(
    () =>
      steps?.status === "loaded" &&
      steps.result.status === "captured" &&
      steps.result.steps.length > 0
        ? lastDictationColumns(steps.result, { t: translate, styleLibrary })
        : null,
    [steps, translate, styleLibrary]
  );

  let body: ReactNode;
  let state: string;
  if (!historyOn) {
    state = "historyOff";
    body = (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-xs text-muted-foreground">{t("settingsOverview.last.historyOff")}</p>
        <SettingsLink destination="privacyData#privacy.history">
          {t("settingsOverview.last.openPrivacy")}
        </SettingsLink>
      </div>
    );
  } else if (!last) {
    state = "none";
    body = <p className="text-xs text-muted-foreground">{t("settingsOverview.last.none")}</p>;
  } else if (!steps || steps.key !== key || steps.status === "loading") {
    state = "loading";
    body = (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("controlPanel.history.steps.loading")}
      </p>
    );
  } else if (steps.status === "failed") {
    state = "failed";
    body = (
      <p className="text-xs text-muted-foreground">{t("controlPanel.history.steps.loadError")}</p>
    );
  } else if (!columns) {
    state = steps.result.status === "otherOwner" ? "otherOwner" : "notCaptured";
    body = (
      <p className="text-xs italic text-muted-foreground/80">
        {t(
          steps.result.status === "otherOwner"
            ? "controlPanel.history.steps.otherOwner"
            : "controlPanel.history.steps.notCaptured"
        )}
      </p>
    );
  } else {
    state = "captured";
    body = (
      <div
        className="grid gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60 dark:border-border-subtle dark:bg-border-subtle"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(9.5rem, 1fr))" }}
      >
        {columns.map((column) => (
          <StepColumn key={column.key} column={column} />
        ))}
      </div>
    );
  }

  // Saved in UTC without a zone, as History reads it.
  const stamp = last?.timestamp || last?.created_at || "";
  const when = stamp ? new Date(stamp.endsWith("Z") ? stamp : `${stamp}Z`) : null;
  const whenLabel =
    when && !Number.isNaN(when.getTime())
      ? when.toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" })
      : null;

  return (
    <section data-setting-id="dictation.overview.lastDictation" data-last-dictation={state}>
      <SectionHeading
        title={t("settingsOverview.last.title")}
        description={whenLabel && historyOn ? whenLabel : undefined}
        aside={
          last && historyOn ? (
            <button
              type="button"
              onClick={() => requestOpenHistoryItem(last.id)}
              className="inline-flex items-center gap-1 text-xs text-link underline decoration-link/30 transition-colors hover:decoration-link/60"
            >
              {t("promptStudio.testSet.actions.openInHistory")}
              <ExternalLink aria-hidden="true" className="h-3 w-3 rtl:-scale-x-100" />
            </button>
          ) : undefined
        }
      />
      <div className={cn(cardClass, "p-4")}>{body}</div>
    </section>
  );
}

/** The dictation hotkey (and its mode) and the style hotkeys; set on the Hotkeys page. */
function HotkeysCard({
  dictationKey,
  activationMode,
  styleLibrary,
  styleBindings,
  onOpenHotkeys,
}: {
  dictationKey: string;
  activationMode: string;
  styleLibrary: StyleLibrary;
  styleBindings: readonly { hotkey: string; styleId: string }[];
  onOpenHotkeys: () => void;
}) {
  const { t } = useTranslation();
  const { isUsingNativeShortcut } = useHotkeyModeInfo("settings-overview", dictationKey);
  // The Hotkeys page hides the mode where the shortcut is native (as there).
  const showMode = !isUsingNativeShortcut || getCachedPlatform() === "linux";
  const keys = parseHotkeyList(dictationKey);
  return (
    <section data-overview-hotkeys="">
      <SectionHeading
        title={t("settingsModal.sections.hotkeys.label")}
        aside={
          <button
            type="button"
            onClick={onOpenHotkeys}
            className="inline-flex items-center gap-0.5 text-xs text-link underline decoration-link/30 transition-colors hover:decoration-link/60"
          >
            {t("settingsOverview.hotkeys.all")}
            <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 rtl:rotate-180" />
          </button>
        }
      />
      <div
        className={cn(
          cardClass,
          "divide-y divide-border/60 text-xs dark:divide-border-subtle [&>div]:px-4 [&>div]:py-3"
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-medium text-foreground">
            {t("settingsPage.general.hotkey.title")}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {keys.length > 0 ? (
              keys.map((key) => <HotkeyKbd key={key}>{formatHotkeyLabel(key)}</HotkeyKbd>)
            ) : (
              <HotkeyKbd>{formatHotkeyListLabel(dictationKey)}</HotkeyKbd>
            )}
            {showMode && (
              <span className="rounded-full bg-primary/10 px-2 py-px text-[11px] text-primary">
                {t(activationMode === "push" ? "common.hold" : "common.tap")}
              </span>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <span className="font-medium text-foreground">
            {t("settingsPage.general.styleHotkeys.title")}
          </span>
          {styleBindings.length === 0 ? (
            <span className="text-muted-foreground">
              {t("settingsPage.general.styleHotkeys.empty")}
            </span>
          ) : (
            <ul className="flex flex-col items-end gap-1.5">
              {styleBindings.map((binding) => {
                const style = findStyle(styleLibrary, binding.styleId);
                return (
                  <li key={binding.hotkey} className="flex items-center gap-2">
                    <span dir="auto" className="text-foreground/85">
                      {style ? styleLabel(style) : t("styles.hotkey.unknownStyle")}
                    </span>
                    <HotkeyKbd>{formatHotkeyLabel(binding.hotkey)}</HotkeyKbd>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

export default function DictationOverview({
  onNavigate,
  onOpenElsewhere,
}: {
  /** Opens a Settings page (the strip's nodes, "All hotkeys"). */
  onNavigate?: (page: SettingsPageId) => void;
  /** Leaves Settings for an app page (the Dictionary & glossary node). */
  onOpenElsewhere?: (location: ElsewhereLocation) => void;
}) {
  const { t } = useTranslation();
  const translate = t as unknown as Translate;
  const settings = useSettingsStore((state) => state);
  const policy = usePolicySnapshot();
  const { library, bindings } = useStyleStore(
    useShallow((state) => ({ library: state.library, bindings: state.hotkeys.bindings }))
  );
  const glossaryRules = useGlossaryStore((state) => state.rules);
  // Recognition's picker context: its summary and can't-run warning (reads only).
  const { context: stt } = useSttPickerContext("dictation", { open: false });

  const nodes = useMemo(
    () =>
      buildDictationPipeline({
        settings,
        policy,
        stt,
        styleLibrary: library,
        styleBindings: bindings,
        glossaryRules,
        t: translate,
      }),
    [settings, policy, stt, library, bindings, glossaryRules, translate]
  );

  const openTarget = (target: OverviewTarget) => {
    if (target.kind === "page") onNavigate?.(target.page);
    else onOpenElsewhere?.(target.location);
  };

  const historyOn = effectiveLocalHistoryEnabled(policy, settings.dataRetentionEnabled);

  return (
    <div className="space-y-8">
      <section data-setting-id="dictation.overview.pipeline">
        <SectionHeading title={t("settingsOverview.pipeline.title")} />
        <div className="@container">
          <ol className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-6 @4xl:gap-x-6">
            {nodes.map((node, index) => (
              <li key={node.id} className="relative flex min-w-0">
                <PipelineNode node={node} onOpen={openTarget} />
                {index < nodes.length - 1 && (
                  <ChevronRight
                    aria-hidden="true"
                    className="absolute top-1/2 -end-[18px] hidden h-3 w-3 -translate-y-1/2 text-muted-foreground/50 @4xl:block rtl:rotate-180"
                  />
                )}
              </li>
            ))}
          </ol>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80">
          {t("settingsOverview.pipeline.note")}
        </p>
      </section>

      <LastDictationCard historyOn={historyOn} styleLibrary={library} />

      <HotkeysCard
        dictationKey={settings.dictationKey}
        activationMode={settings.activationMode}
        styleLibrary={library}
        styleBindings={bindings}
        onOpenHotkeys={() => onNavigate?.("hotkeys")}
      />
    </div>
  );
}

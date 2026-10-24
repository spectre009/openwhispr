import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./button";
import { Input } from "./input";
import { AutoGrowTextarea } from "./AutoGrowTextarea";
import ClampedText from "./ClampedText";
import { Toggle } from "./toggle";
import { ConfirmDialog } from "./dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";
import {
  AlertTriangle,
  Check,
  Copy,
  Edit3,
  Eye,
  Info,
  Loader2,
  Play,
  Plus,
  Save,
  TestTube,
  Trash2,
} from "../icons";
import { cn } from "../lib/utils";
import PromptTestSet from "./PromptTestSet";
import StyleHotkeyField from "./StyleHotkeyField";
import { useAgentName } from "../../utils/agentName";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { describeProviderError } from "../../utils/describeProviderError";
import {
  PLAIN_STYLE_ID,
  STYLE_EMOJI_MAX_LENGTH,
  STYLE_INSTRUCTION_MAX_LENGTH,
  STYLE_NAME_MAX_LENGTH,
  findStyle,
  normalizeStyleEmoji,
  normalizeStyleInstruction,
  normalizeStyleName,
  selectableStyles,
  snapshotStyle,
  type DictationStyle,
  type RecordingStyle,
  type StyleRunMode,
} from "../../config/styles/library";
import { STYLE_STARTERS } from "../../config/styles/starters";
import { buildOneStepStyleBlock, buildRestylePrompt } from "../../config/styles/restylePrompt";
import {
  chooseDictationStyle,
  createStyle,
  deleteStyle,
  ensureStyles,
  requestStyleFocus,
  saveStyle,
  useStyleStore,
} from "../../stores/styleStore";
import {
  saveTestCaseFromInput,
  storageNoticeKey,
  styleTestTarget,
} from "../../stores/promptTestSetStore";
import { getSettings, useSettingsStore } from "../../stores/settingsStore";
import { getGlossarySnapshot } from "../../stores/glossaryStore";
import { correctCaseInput } from "../../services/promptTestRunner";
import { isStyleReachable, runStyledDictation } from "../../services/dictationStyles";
import {
  captureCleanupPrompt,
  captureCleanupPromptInputs,
  pinDictationCleanupRequest,
  runCleanupWithPrompt,
} from "../../services/cleanupWithPrompt";
import logger from "../../utils/logger";

// Settings → Language Models → Dictation Cleanup → Styles. Each style is a
// short instruction that restyles a dictation after cleanup (two steps) or
// with it (one step). The editor mirrors Prompt Studio: View, Customize and
// Test. Drafts are never saved until Save. Test runs the style one step
// against two steps, on one input or on the style's test set.

const NEW_STYLE_ID = "__new__";

interface StyleDraft {
  name: string;
  emoji: string;
  instruction: string;
  runMode: StyleRunMode;
  appGlossary: boolean;
}

const EMPTY_DRAFT: StyleDraft = {
  name: "",
  emoji: "",
  instruction: "",
  runMode: "two-step",
  appGlossary: true,
};

function draftOf(style: DictationStyle | undefined): StyleDraft {
  if (!style) return { ...EMPTY_DRAFT };
  return {
    name: style.name,
    emoji: style.emoji,
    instruction: style.instruction,
    runMode: style.runMode,
    appGlossary: style.appGlossary,
  };
}

function sameDraft(a: StyleDraft, b: StyleDraft): boolean {
  return (
    normalizeStyleName(a.name) === normalizeStyleName(b.name) &&
    normalizeStyleEmoji(a.emoji) === normalizeStyleEmoji(b.emoji) &&
    normalizeStyleInstruction(a.instruction) === normalizeStyleInstruction(b.instruction) &&
    a.runMode === b.runMode &&
    a.appGlossary === b.appGlossary
  );
}

interface ModeResult {
  text?: string;
  error?: string;
  ms: number;
}

const RUN_MODES: readonly StyleRunMode[] = ["one-step", "two-step"];

export default function StyleStudio({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const { agentName } = useAgentName();
  const library = useStyleStore((s) => s.library);
  const { dictationKey, useCleanupModel } = useSettingsStore(
    useShallow((s) => ({ dictationKey: s.dictationKey, useCleanupModel: s.useCleanupModel }))
  );
  const [selectedId, setSelectedId] = useState<string>(PLAIN_STYLE_ID);
  const [draft, setDraft] = useState<StyleDraft>(EMPTY_DRAFT);
  const [activeTab, setActiveTab] = useState<"view" | "edit" | "test">("view");
  const [testMode, setTestMode] = useState<"single" | "set">("single");
  const [testText, setTestText] = useState(() => t("styles.test.defaultInput"));
  const [results, setResults] = useState<Partial<Record<StyleRunMode, ModeResult>>>({});
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The starters are written into the record once, named in the UI language.
  useEffect(() => {
    ensureStyles(
      Object.fromEntries(
        STYLE_STARTERS.map((starter) => [
          starter.id,
          t(starter.nameKey, { defaultValue: starter.defaultName }),
        ])
      )
    );
  }, [t]);

  const selected = selectedId === NEW_STYLE_ID ? undefined : findStyle(library, selectedId);
  const isPlain = selectedId === PLAIN_STYLE_ID;
  const isNew = selectedId === NEW_STYLE_ID;
  const saved = useMemo(() => draftOf(selected), [selected]);
  const isDirty = !isPlain && !sameDraft(draft, saved);
  const draftComplete =
    normalizeStyleName(draft.name).length > 0 &&
    normalizeStyleInstruction(draft.instruction).length > 0;

  // A selection resets the draft.
  const lastSavedRef = useRef<StyleDraft>(saved);
  useEffect(() => {
    setDraft(draftOf(selected));
    lastSavedRef.current = draftOf(selected);
    setResults({});
    setNotice(null);
    setJustSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // The saved style changed (here or in another window): an unedited draft follows it.
  useEffect(() => {
    const previous = lastSavedRef.current;
    lastSavedRef.current = saved;
    setDraft((current) => (sameDraft(current, previous) ? saved : current));
  }, [saved]);

  // A style deleted in another window drops its selection.
  useEffect(() => {
    if (!isPlain && !isNew && !selected) setSelectedId(PLAIN_STYLE_ID);
  }, [isPlain, isNew, selected]);

  // Another page (the Hotkeys page's style hotkey list) asked for a style.
  const focusStyleId = useStyleStore((s) => s.focusStyleId);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusStyleId) return;
    requestStyleFocus(null);
    if (findStyle(library, focusStyleId)) {
      setSelectedId(focusStyleId);
      setActiveTab("view");
    }
    // The settings page shows this section a moment later. Not cleared when
    // the request resets above: that re-run must not cancel the scroll.
    setTimeout(() => rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 100);
  }, [focusStyleId, library]);

  const hotkeyLabel = formatHotkeyLabel(dictationKey);
  const pickable = selectableStyles(library);
  const draftStyle: RecordingStyle = snapshotStyle({
    id: selected?.id ?? "draft",
    name: normalizeStyleName(draft.name),
    emoji: normalizeStyleEmoji(draft.emoji),
    instruction: normalizeStyleInstruction(draft.instruction),
    runMode: draft.runMode,
    appGlossary: draft.appGlossary,
    useVoice: false,
  });
  const reachable = isStyleReachable(getSettings());

  const select = (id: string) => {
    setSelectedId(id);
    setActiveTab(id === NEW_STYLE_ID ? "edit" : "view");
  };

  const save = () => {
    if (!draftComplete) return;
    if (isNew) {
      const id = createStyle({ ...draft });
      if (id) {
        setSelectedId(id);
        setActiveTab("view");
      }
      return;
    }
    if (selected && saveStyle(selected.id, { ...draft })) {
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    }
  };

  const discard = () => {
    if (isNew) {
      select(PLAIN_STYLE_ID);
      return;
    }
    setDraft(draftOf(selected));
  };

  const runSingle = async () => {
    if (!testText.trim() || running || !draftComplete) return;
    setRunning(true);
    setResults({});
    setNotice(null);
    // Fixed for both runs: the request with its provider pinned, the prompt in
    // use and its inputs. Nothing saved changes.
    const settings = getSettings();
    const request = pinDictationCleanupRequest(settings);
    const cleanupPrompt = captureCleanupPrompt({ mode: "inherit" }, settings.customPrompts.cleanup);
    const promptInputs = captureCleanupPromptInputs(settings);
    const extra = { cleanupPrompt, promptInputs };
    // Through the glossary like a dictation in an unknown app.
    const input = correctCaseInput(
      { rawText: testText, targetApp: null },
      getGlossarySnapshot(),
      Array.isArray(settings.snippets) ? settings.snippets : null
    ).corrected;
    for (const mode of RUN_MODES) {
      const started = performance.now();
      try {
        const result = await runStyledDictation({
          text: input,
          style: draftStyle,
          settings,
          agentName,
          cleanupOn: true,
          runMode: mode,
          request,
          extra,
          redactLogs: true,
          strict: true,
          runCleanup: (text) =>
            runCleanupWithPrompt(text, cleanupPrompt, {
              agentName,
              request: { model: request.model, config: { ...request.config, promptInputs } },
              redactLogs: true,
            }),
        });
        const ms = Math.round(performance.now() - started);
        setResults((prev) => ({ ...prev, [mode]: { text: result.text, ms } }));
      } catch (error) {
        const ms = Math.round(performance.now() - started);
        const described = describeProviderError(error as Record<string, unknown>, t);
        logger.warn(
          "Style test failed",
          { mode, code: (error as { code?: string })?.code },
          "prompt-studio"
        );
        setResults((prev) => ({
          ...prev,
          [mode]: {
            error:
              described.description ||
              (error instanceof Error ? error.message : String(error ?? "")),
            ms,
          },
        }));
      }
    }
    setRunning(false);
  };

  const saveAsTestCase = async () => {
    if (!testText.trim() || !selected) return;
    const result = await saveTestCaseFromInput(testText, styleTestTarget(selected.id));
    if (!result.success) setNotice(t("promptStudio.test.saveCaseFailed"));
    else if (result.duplicate) setNotice(t("promptStudio.test.caseExists"));
    else if (result.durable) setNotice(t("promptStudio.test.caseSaved"));
    else
      setNotice(`${t("promptStudio.test.caseSavedSession")} ${t(storageNoticeKey(result.reason))}`);
  };

  const tabs = [
    { id: "view" as const, label: t("promptStudio.tabs.view"), icon: Eye },
    { id: "edit" as const, label: t("promptStudio.tabs.customize"), icon: Edit3 },
    { id: "test" as const, label: t("promptStudio.tabs.test"), icon: TestTube },
  ];

  const runModeLabel = (mode: StyleRunMode) =>
    t(mode === "one-step" ? "styles.runMode.oneStep" : "styles.runMode.twoSteps");

  return (
    <div ref={rootRef} className={cn("space-y-4 scroll-mt-4", className)}>
      {/* ── The dictation hotkey's style ── */}
      <div
        data-setting-id="dictation.styles.dictationStyle"
        className="rounded-xl border border-border/70 dark:border-border-subtle bg-card dark:bg-surface-2 px-5 py-4 space-y-2"
      >
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 min-w-40 text-xs font-medium text-foreground">
            {t("styles.picker.label", { hotkey: hotkeyLabel })}
          </p>
          <div className="min-w-48 max-w-xs flex-1">
            <Select
              value={library.dictationStyleId}
              onValueChange={(id) => void chooseDictationStyle(id)}
            >
              <SelectTrigger className="h-9 text-xs" aria-label={t("styles.picker.ariaLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PLAIN_STYLE_ID} className="text-xs">
                  {t("styles.plain.name")}
                </SelectItem>
                {pickable.length > 0 && <SelectSeparator />}
                {pickable.map((style) => (
                  <SelectItem key={style.id} value={style.id} className="text-xs">
                    <span dir="auto">
                      {style.emoji ? `${style.emoji} ` : ""}
                      {style.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t("styles.picker.description", { hotkey: hotkeyLabel })}
        </p>
        {!reachable && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {t("styles.picker.noModel")}
          </p>
        )}
        {reachable && !useCleanupModel && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {t("styles.picker.cleanupOff")}
          </p>
        )}
      </div>

      {/* ── The styles ── */}
      <div data-setting-id="dictation.styles.list" className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground">{t("styles.list.title")}</p>
          <Button onClick={() => select(NEW_STYLE_ID)} variant="outline" size="sm" className="h-8">
            <Plus className="w-3.5 h-3.5" />
            {t("styles.list.new")}
          </Button>
        </div>
        <ul className="space-y-1.5">
          <StyleRow
            emoji=""
            name={t("styles.plain.name")}
            detail={t("styles.plain.detail")}
            selected={isPlain}
            inUse={library.dictationStyleId === PLAIN_STYLE_ID}
            onSelect={() => select(PLAIN_STYLE_ID)}
          />
          {library.styles.map((style) => (
            <StyleRow
              key={style.id}
              emoji={style.emoji}
              name={style.name}
              detail={
                style.hotkey
                  ? `${runModeLabel(style.runMode)} · ${formatHotkeyLabel(style.hotkey)}`
                  : runModeLabel(style.runMode)
              }
              selected={selectedId === style.id}
              inUse={library.dictationStyleId === style.id}
              enabled={style.enabled}
              onToggle={(enabled) => void saveStyle(style.id, { enabled })}
              onSelect={() => select(style.id)}
            />
          ))}
        </ul>
      </div>

      {/* ── The editor ── */}
      <div className="rounded-xl border border-border/70 dark:border-border-subtle bg-card dark:bg-surface-2 overflow-hidden">
        <div className="flex border-b border-border/70 dark:border-border-subtle">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-xs font-medium transition-colors duration-150 border-b-2 ${
                  isActive
                    ? "border-primary text-foreground bg-primary/5 dark:bg-primary/3"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-black/2 dark:hover:bg-white/2"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {isPlain ? (
          <div className="px-5 py-4 space-y-2">
            <p className="text-xs font-medium text-foreground">{t("styles.plain.name")}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("styles.plain.description")}
            </p>
          </div>
        ) : (
          <>
            {/* ── View ── */}
            {activeTab === "view" && (
              <div className="divide-y divide-border/60 dark:divide-border-subtle">
                <div className="px-5 py-4 space-y-2">
                  <p dir="auto" className="text-sm font-medium text-foreground">
                    {saved.emoji ? `${saved.emoji} ` : ""}
                    {saved.name || t("styles.editor.untitled")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {runModeLabel(saved.runMode)} ·{" "}
                    {selected?.enabled ? t("styles.editor.on") : t("styles.editor.off")} ·{" "}
                    {saved.appGlossary
                      ? t("styles.editor.appGlossaryOn")
                      : t("styles.editor.appGlossaryOff")}
                  </p>
                  <div className="bg-muted/30 dark:bg-surface-raised/30 border border-border/70 rounded-lg p-4">
                    <p dir="auto" className="text-xs text-foreground whitespace-pre-wrap">
                      {saved.instruction || t("styles.editor.noInstruction")}
                    </p>
                  </div>
                  {isDirty && (
                    <p className="text-xs text-warning">
                      {t("promptStudio.library.viewShowsSaved")}
                    </p>
                  )}
                </div>
                {selected && <StyleHotkeyField style={selected} />}
                {saved.instruction && (
                  <details className="px-5 py-4 text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">
                      {saved.runMode === "one-step"
                        ? t("styles.editor.showOneStepBlock")
                        : t("styles.editor.showRestylePrompt")}
                    </summary>
                    <ClampedText
                      collapsedRem={18}
                      className="mt-2 rounded-lg border border-border/70 bg-muted/30 p-3"
                    >
                      <pre
                        dir="ltr"
                        className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed"
                      >
                        {saved.runMode === "one-step"
                          ? buildOneStepStyleBlock({
                              name: saved.name,
                              instruction: saved.instruction,
                            })
                          : buildRestylePrompt({
                              name: saved.name,
                              instruction: saved.instruction,
                            })}
                      </pre>
                    </ClampedText>
                  </details>
                )}
              </div>
            )}

            {/* ── Customize ── */}
            {activeTab === "edit" && (
              <div className="divide-y divide-border/60 dark:divide-border-subtle">
                <div className="px-5 py-4 space-y-3">
                  <div className="grid grid-cols-[5rem_1fr] gap-2">
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">
                        {t("styles.editor.emoji")}
                      </span>
                      <Input
                        dir="auto"
                        value={draft.emoji}
                        maxLength={STYLE_EMOJI_MAX_LENGTH}
                        onChange={(e) => setDraft((prev) => ({ ...prev, emoji: e.target.value }))}
                        className="h-9 text-sm text-center"
                        placeholder="💬"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">
                        {t("styles.editor.name")}
                      </span>
                      <Input
                        dir="auto"
                        value={draft.name}
                        maxLength={STYLE_NAME_MAX_LENGTH}
                        onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                        className="h-9 text-xs"
                        placeholder={t("styles.editor.namePlaceholder")}
                      />
                    </label>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-xs text-muted-foreground">
                      {t("styles.editor.instruction")}
                    </span>
                    <AutoGrowTextarea
                      dir="auto"
                      value={draft.instruction}
                      maxLength={STYLE_INSTRUCTION_MAX_LENGTH}
                      onChange={(e) =>
                        setDraft((prev) => ({ ...prev, instruction: e.target.value }))
                      }
                      minRows={6}
                      className="text-xs leading-relaxed"
                      placeholder={t("styles.editor.instructionPlaceholder")}
                    />
                    <span className="block text-[11px] text-muted-foreground/80">
                      {t("styles.editor.instructionHint")}
                    </span>
                  </label>
                </div>

                <div className="px-5 py-4 space-y-2">
                  <p className="text-xs font-medium text-foreground">
                    {t("styles.editor.runMode")}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(["two-step", "one-step"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={draft.runMode === mode}
                        onClick={() => setDraft((prev) => ({ ...prev, runMode: mode }))}
                        className={cn(
                          "rounded-lg border px-3 py-2 text-start transition-colors",
                          draft.runMode === mode
                            ? "border-primary bg-primary/5"
                            : "border-border/70 hover:bg-muted/40"
                        )}
                      >
                        <span className="block text-xs font-medium text-foreground">
                          {runModeLabel(mode)}
                        </span>
                        <span className="block text-[11px] text-muted-foreground leading-relaxed">
                          {t(
                            mode === "one-step"
                              ? "styles.runMode.oneStepDescription"
                              : "styles.runMode.twoStepsDescription"
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-start gap-3">
                    <Toggle
                      checked={draft.appGlossary}
                      onChange={(value) => setDraft((prev) => ({ ...prev, appGlossary: value }))}
                      ariaLabel={t("styles.editor.appGlossary")}
                    />
                    <div className="space-y-0.5">
                      <p className="text-xs font-medium text-foreground">
                        {t("styles.editor.appGlossary")}
                      </p>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        {t("styles.editor.appGlossaryDescription")}
                      </p>
                    </div>
                  </div>
                </div>

                {selected && <StyleHotkeyField style={selected} />}

                <div className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {isDirty ? (
                      <span className="text-xs text-warning">
                        ● {t("promptStudio.library.unsaved")}
                      </span>
                    ) : (
                      justSaved && (
                        <span className="flex items-center gap-1 text-xs text-success">
                          <Check className="w-3 h-3" />
                          {t("promptStudio.library.saved")}
                        </span>
                      )
                    )}
                    <span className="flex-1" />
                    {selected && (
                      <Button
                        onClick={() => setConfirmDelete(true)}
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {t("promptStudio.library.actions.delete")}
                      </Button>
                    )}
                    {(isDirty || isNew) && (
                      <Button onClick={discard} variant="ghost" size="sm" className="h-8">
                        {t("promptStudio.library.actions.discard")}
                      </Button>
                    )}
                    <Button
                      onClick={save}
                      size="sm"
                      className="h-8"
                      disabled={!draftComplete || (!isNew && !isDirty)}
                    >
                      <Save className="w-3.5 h-3.5" />
                      {t("promptStudio.common.save")}
                    </Button>
                  </div>
                  {!draftComplete && (
                    <p className="text-xs text-muted-foreground/80 mt-1.5">
                      {t("styles.editor.incomplete")}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* ── Test ── */}
            {activeTab === "test" && (
              <div className="divide-y divide-border/60 dark:divide-border-subtle">
                <div className="px-5 py-3">
                  <div
                    role="tablist"
                    className="inline-flex rounded-lg border border-border/70 dark:border-border-subtle p-0.5"
                  >
                    {(["single", "set"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        role="tab"
                        aria-selected={testMode === mode}
                        onClick={() => setTestMode(mode)}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition-colors duration-150 ${
                          testMode === mode
                            ? "bg-primary/10 text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {t(
                          mode === "single"
                            ? "promptStudio.testSet.modeSingle"
                            : "promptStudio.testSet.modeSet"
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {testMode === "set" ? (
                  selected ? (
                    <PromptTestSet
                      style={{
                        style: snapshotStyle({ ...draftStyle, id: selected.id }),
                        isDraft: isDirty,
                      }}
                      agentName={agentName}
                    />
                  ) : (
                    <p className="px-5 py-4 text-xs text-muted-foreground">
                      {t("styles.test.saveFirst")}
                    </p>
                  )
                ) : (
                  <>
                    <div className="px-5 py-4">
                      <div className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 px-4 py-3">
                        <Info className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t(isDirty || isNew ? "styles.test.singleDraft" : "styles.test.single")}
                        </p>
                      </div>
                    </div>
                    <div className="px-5 py-4">
                      <p className="text-xs font-medium text-foreground mb-2">
                        {t("promptStudio.test.inputLabel")}
                      </p>
                      <AutoGrowTextarea
                        dir="auto"
                        value={testText}
                        onChange={(e) => setTestText(e.target.value)}
                        minRows={3}
                        className="text-xs"
                        placeholder={t("promptStudio.test.inputPlaceholder")}
                      />
                    </div>
                    <div className="px-5 py-4">
                      <Button
                        onClick={() => void runSingle()}
                        disabled={!testText.trim() || running || !draftComplete || !reachable}
                        size="sm"
                        className="w-full"
                      >
                        {running ? (
                          <Loader2 className="w-3.5 h-3.5 me-2 animate-spin" />
                        ) : (
                          <Play className="w-3.5 h-3.5 me-2" />
                        )}
                        {running ? t("promptStudio.test.processing") : t("styles.test.runBoth")}
                      </Button>
                      {!reachable && (
                        <p className="text-xs text-muted-foreground/80 mt-1.5">
                          {t("promptStudio.test.noModelSelected")}
                        </p>
                      )}
                      {selected && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Button
                            onClick={() => void saveAsTestCase()}
                            disabled={!testText.trim()}
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                          >
                            {t("promptStudio.test.saveAsCase")}
                          </Button>
                          {notice && <p className="text-xs text-muted-foreground/80">{notice}</p>}
                        </div>
                      )}
                    </div>
                    {(results["one-step"] || results["two-step"]) && (
                      <div className="px-5 py-4 grid gap-3 sm:grid-cols-2">
                        {RUN_MODES.map((mode) => (
                          <ModeOutput
                            key={mode}
                            title={runModeLabel(mode)}
                            result={results[mode]}
                            pending={running && !results[mode]}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("styles.editor.deleteTitle", { name: selected?.name ?? "" })}
        description={
          t(
            selected && library.dictationStyleId === selected.id
              ? "styles.editor.deleteInUseDescription"
              : "styles.editor.deleteDescription"
          ) +
          (selected?.hotkey
            ? ` ${t("styles.hotkey.deleteReleases", { hotkey: formatHotkeyLabel(selected.hotkey) })}`
            : "")
        }
        confirmText={t("promptStudio.library.actions.delete")}
        cancelText={t("promptStudio.library.dialogs.cancel")}
        variant="destructive"
        onConfirm={() => {
          if (selected && deleteStyle(selected.id)) select(PLAIN_STYLE_ID);
        }}
      />
    </div>
  );
}

function StyleRow({
  emoji,
  name,
  detail,
  selected,
  inUse,
  enabled,
  onToggle,
  onSelect,
}: {
  emoji: string;
  name: string;
  detail: string;
  selected: boolean;
  inUse: boolean;
  /** Undefined for Plain, which is always on. */
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2",
        selected ? "border-primary/50 bg-primary/5" : "border-border/60 dark:border-border-subtle"
      )}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-start">
        <span dir="auto" className="block truncate text-xs font-medium text-foreground">
          {emoji ? `${emoji} ` : ""}
          {name}
          {inUse && (
            <span className="ms-2 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-px rounded-full bg-primary/10 text-primary">
              {t("styles.list.inUse")}
            </span>
          )}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
      </button>
      {onToggle && enabled !== undefined && (
        <Toggle
          checked={enabled}
          onChange={onToggle}
          ariaLabel={t("styles.list.toggle", { name })}
        />
      )}
    </li>
  );
}

function ModeOutput({
  title,
  result,
  pending,
}: {
  title: string;
  result: ModeResult | undefined;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">
          {title}
          {result && (
            <span className="ms-2 text-[11px] font-normal text-muted-foreground">
              {t("promptStudio.testSet.results.time", { seconds: (result.ms / 1000).toFixed(1) })}
            </span>
          )}
        </p>
        {result?.text && (
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(result.text ?? "");
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            variant="ghost"
            size="icon"
            className="h-6 w-7"
            aria-label={t("promptStudio.common.copy")}
          >
            {copied ? (
              <Check className="w-3 h-3 text-success" />
            ) : (
              <Copy className="w-3 h-3 text-muted-foreground" />
            )}
          </Button>
        )}
      </div>
      <ClampedText
        collapsedRem={16}
        className="min-h-16 bg-muted/30 dark:bg-surface-raised/30 border border-border/70 rounded-lg p-3"
      >
        {pending ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t("promptStudio.test.processing")}
          </p>
        ) : result?.error ? (
          <p dir="auto" className="text-xs text-destructive">
            {t("styles.test.failed", { error: result.error })}
          </p>
        ) : (
          <pre dir="auto" className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">
            {result?.text ?? ""}
          </pre>
        )}
      </ClampedText>
    </div>
  );
}

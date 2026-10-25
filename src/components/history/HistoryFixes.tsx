import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { useToast } from "../ui/useToast";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import GlossaryRuleDialog from "../GlossaryRuleDialog";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  TestTube,
  X,
} from "../icons";
import { useSettingsStore } from "../../stores/settingsStore";
import { useStyleStore } from "../../stores/styleStore";
import { storageNoticeKey, updateTestCase } from "../../stores/promptTestSetStore";
import { findStyle, styleIdFromRouteKind } from "../../config/styles/library";
import { suggestTestChecks } from "../../utils/historyFixes";
import type { HistoryFixesController, PickedText, TestCaseFix } from "./useHistoryFixes";

// The History review's fixes: the suggestion box under the step chips (and
// under a saved 👎 review), the actions that float over words selected in a
// step's text, and the dialogs they open: the glossary's own rule editor, a
// dictionary word to confirm, and a test case with the checks to confirm.

const ACTION_CLASS = "h-7 px-2.5 text-xs";

/** Keeps the selection while a fix button is pressed. */
const keepSelection = (event: { preventDefault: () => void }) => event.preventDefault();

export function FixSuggestion({ fixes }: { fixes: HistoryFixesController }) {
  const { t } = useTranslation();
  const { kind } = fixes;
  if (!kind) return null;

  let title: string;
  let description: string;
  let literal = false;
  let actions: ReactNode = null;
  let fired: ReactNode = null;

  if (kind === "recognition" || kind === "glossary") {
    const anyFired = fixes.firedRules.length > 0;
    if (kind === "recognition") {
      title = t("historyView.fixes.recognition.title");
      description = t("historyView.fixes.recognition.description");
    } else {
      title = t(
        anyFired ? "historyView.fixes.glossary.title" : "historyView.fixes.glossary.titleNoRules"
      );
      description = t(
        anyFired ? "historyView.fixes.glossary.description" : "historyView.fixes.glossary.noRules"
      );
    }
    const picked = fixes.selection;
    const hint = picked ? undefined : t("historyView.fixes.actions.selectFirst");
    actions = (
      <>
        <Button
          size="sm"
          className={ACTION_CLASS}
          disabled={!picked}
          title={hint}
          onMouseDown={keepSelection}
          onClick={() => fixes.openGlossary()}
        >
          <Plus size={13} />
          {t("historyView.fixes.actions.glossary")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={ACTION_CLASS}
          disabled={!picked}
          title={hint}
          onMouseDown={keepSelection}
          onClick={() => fixes.openDictionary()}
        >
          <BookOpen size={13} />
          {t("historyView.fixes.actions.dictionary")}
        </Button>
      </>
    );
    if (anyFired) {
      fired = (
        <div className="mt-2">
          <p className="text-[11.5px] text-muted-foreground">{t("historyView.fixes.fired")}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {fixes.firedRules.map((fix) => (
              <li key={fix.ruleId} className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 text-[11.5px] dark:border-white/10">
                  <span dir="auto">{fix.from}</span>
                  <ArrowRight size={11} className="text-muted-foreground rtl:-scale-x-100" />
                  <span dir="auto">{fix.to}</span>
                </span>
                {fix.rule ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className={ACTION_CLASS}
                    onClick={() => fixes.editRule(fix.ruleId)}
                  >
                    <Pencil size={12} />
                    {t("historyView.fixes.actions.editRule")}
                  </Button>
                ) : (
                  <span className="text-[11px] text-muted-foreground/80">
                    {t("dictionary.glossary.errors.notFound")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      );
    }
  } else if (kind === "cleanup" || kind === "style") {
    title = t(`historyView.fixes.${kind}.title`);
    description = t(`historyView.fixes.${kind}.description`);
    literal = true;
    actions = (
      <>
        {fixes.canPin && (
          <Button
            size="sm"
            className={ACTION_CLASS}
            disabled={fixes.pinning}
            onClick={fixes.addToTestSet}
          >
            {fixes.pinning ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <TestTube size={13} />
            )}
            {t("historyView.fixes.actions.addToTestSet")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className={ACTION_CLASS}
          onClick={kind === "cleanup" ? fixes.openPromptStudio : fixes.editStyle}
        >
          <ExternalLink size={13} />
          {t(
            kind === "cleanup"
              ? "historyView.fixes.actions.openPromptStudio"
              : "historyView.fixes.actions.editStyle"
          )}
        </Button>
      </>
    );
  } else {
    title = t("historyView.fixes.delivery.title");
    description = t("historyView.fixes.delivery.description");
    actions = fixes.canCopy ? (
      <Button size="sm" variant="outline" className={ACTION_CLASS} onClick={fixes.copyAgain}>
        <Copy size={13} />
        {t("historyView.fixes.actions.copyAgain")}
      </Button>
    ) : null;
  }

  return (
    <div
      data-fix-suggestion={kind}
      className="mt-3 rounded-lg border border-dashed border-primary/50 bg-primary/5 px-3 py-2.5"
    >
      <p className="text-xs font-semibold text-primary">{title}</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-foreground">{description}</p>
      {literal && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
          {t("historyView.fixes.literal")}
        </p>
      )}
      {fired}
      {actions && <div className="mt-2 flex flex-wrap gap-1.5">{actions}</div>}
    </div>
  );
}

// ─── Words selected in a step's text ─────────────────────────────────────

/** The two fixes, floating under words selected in a step's text. */
export function SelectionActions({ fixes }: { fixes: HistoryFixesController }) {
  const { t } = useTranslation();
  const picked = fixes.selection;
  if (!picked || fixes.selectableThrough === null) return null;
  const act = (open: (picked: PickedText) => void) => () => open(picked);
  return (
    <div
      role="toolbar"
      aria-label={t("historyView.fixes.selection.label")}
      data-selection-actions
      onMouseDown={keepSelection}
      style={{ top: picked.top, insetInlineStart: picked.inlineStart }}
      className="absolute z-10 flex gap-1 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      <Button size="sm" variant="ghost" className={ACTION_CLASS} onClick={act(fixes.openGlossary)}>
        <Plus size={13} />
        {t("historyView.fixes.selection.glossary")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={ACTION_CLASS}
        onClick={act(fixes.openDictionary)}
      >
        <BookOpen size={13} />
        {t("historyView.fixes.selection.dictionary")}
      </Button>
    </div>
  );
}

// ─── Dialogs ─────────────────────────────────────────────────────────────

/** A dictionary word to confirm; added through the store like a typed one ("manual"). */
function DictionaryWordDialog({
  word,
  onOpenChange,
}: {
  word: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const dictionary = useSettingsStore((state) => state.customDictionary);
  const [value, setValue] = useState("");
  const added = useRef(false);

  useEffect(() => {
    if (word === null) return;
    setValue(word);
    added.current = false;
  }, [word]);

  const trimmed = value.replace(/\s+/g, " ").trim();
  const exists =
    !!trimmed && dictionary.some((entry) => entry.trim().toLowerCase() === trimmed.toLowerCase());

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || exists || added.current) return;
    added.current = true;
    useSettingsStore.getState().updateCustomDictionary({ add: [trimmed] });
    toast({ title: t("historyView.fixes.dictionary.added"), variant: "success" });
    onOpenChange(false);
  };

  return (
    <Dialog open={word !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("historyView.fixes.dictionary.title")}</DialogTitle>
          <DialogDescription>{t("historyView.fixes.dictionary.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={add} className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium">{t("historyView.fixes.dictionary.label")}</span>
            <Input
              dir="auto"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={exists || undefined}
            />
          </label>
          {exists && (
            <p role="status" className="text-xs text-warning">
              {t("historyView.fixes.dictionary.exists")}
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("historyView.fixes.dictionary.sync")}
          </p>
          <DialogFooter className="pt-1">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!trimmed || exists}>
              {t("dictionary.addWord")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface CheckRow {
  key: number;
  text: string;
  checked: boolean;
}

const fold = (text: string) => text.trim().toLowerCase();

/** The case's checks (kept, ticked) then the suggestions it doesn't have yet. */
function initialRows(
  current: string[],
  suggested: string[],
  tickSuggestions: boolean,
  next: () => number
) {
  const known = new Set(current.map(fold));
  return [
    ...current.map((text) => ({ key: next(), text, checked: true })),
    ...suggested
      .filter((text) => !known.has(fold(text)))
      .map((text) => ({ key: next(), text, checked: tickSuggestions })),
  ];
}

function checkedTexts(rows: CheckRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const text = row.text.trim();
    if (!row.checked || !text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function CheckList({
  title,
  rows,
  onChange,
  nextKey,
}: {
  title: string;
  rows: CheckRow[];
  onChange: (rows: CheckRow[]) => void;
  nextKey: () => number;
}) {
  const { t } = useTranslation();
  const update = (key: number, patch: Partial<CheckRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className="mb-1.5 text-xs font-medium text-foreground">{title}</legend>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-1.5">
          <button
            type="button"
            role="checkbox"
            aria-checked={row.checked}
            aria-label={t("historyView.fixes.testCase.useCheck")}
            onClick={() => update(row.key, { checked: !row.checked })}
            className={cn(
              "grid size-4 shrink-0 place-items-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              row.checked
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background dark:border-white/20"
            )}
          >
            {row.checked && <Check size={11} strokeWidth={3} />}
          </button>
          <Input
            dir="auto"
            value={row.text}
            onChange={(event) => update(row.key, { text: event.target.value })}
            aria-label={t("historyView.fixes.testCase.checkLabel")}
            maxLength={200}
            className="h-8 min-w-0 flex-1 text-xs"
          />
          <button
            type="button"
            onClick={() => onChange(rows.filter((candidate) => candidate.key !== row.key))}
            aria-label={t("historyView.fixes.testCase.removeCheck")}
            className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-destructive"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={ACTION_CLASS}
        onClick={() => onChange([...rows, { key: nextKey(), text: "", checked: true }])}
      >
        <Plus size={12} />
        {t("historyView.fixes.testCase.addCheck")}
      </Button>
    </fieldset>
  );
}

function TextBlock({ label, hint, text }: { label: string; hint?: string; text: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-muted/30 p-2.5 dark:border-white/10">
      <p className="text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/90">{label}</span>
        {hint && <span> · {hint}</span>}
      </p>
      <p
        dir="auto"
        className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap wrap-break-word text-xs leading-relaxed text-foreground"
      >
        {text}
      </p>
    </div>
  );
}

/** The pinned case beside the correction, and the checks to confirm (test-cases-update on Save). */
function TestCaseChecksDialog({
  fix,
  onOpenChange,
}: {
  fix: TestCaseFix | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const styleLibrary = useStyleStore((state) => state.library);
  const keys = useRef(0);
  const nextKey = () => (keys.current += 1);
  const [contain, setContain] = useState<CheckRow[]>([]);
  const [notContain, setNotContain] = useState<CheckRow[]>([]);
  const [matchCase, setMatchCase] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [suggestedAny, setSuggestedAny] = useState(false);

  useEffect(() => {
    if (!fix) return;
    const suggested = suggestTestChecks(fix.output, fix.correction);
    const next = () => (keys.current += 1);
    setContain(initialRows(fix.testCase.mustContain, suggested.mustContain, !fix.duplicate, next));
    setNotContain(
      initialRows(fix.testCase.mustNotContain, suggested.mustNotContain, !fix.duplicate, next)
    );
    setSuggestedAny(suggested.mustContain.length + suggested.mustNotContain.length > 0);
    setMatchCase(fix.testCase.matchCase);
    setSaving(false);
    setError(false);
  }, [fix]);

  if (!fix) return null;
  const { testCase } = fix;
  const styleId = styleIdFromRouteKind(testCase.target);
  const style = styleId ? findStyle(styleLibrary, styleId) : undefined;
  const target = styleId
    ? style
      ? `${style.emoji ? `${style.emoji} ` : ""}${style.name}`
      : t("controlPanel.history.steps.deletedStyle")
    : t("controlPanel.history.steps.kinds.cleanup");

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(false);
    // The pin's other fields go back as they are: an update replaces them all.
    const reply = await updateTestCase(testCase.id, {
      label: testCase.label,
      targetApp: testCase.targetApp,
      mustContain: checkedTexts(contain),
      mustNotContain: checkedTexts(notContain),
      matchCase,
      styleChecks: testCase.styleChecks,
    });
    setSaving(false);
    if (!reply.success) {
      setError(true);
      return;
    }
    toast({ title: t("historyView.fixes.testCase.saved"), variant: "success" });
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t(
              fix.duplicate
                ? "controlPanel.history.testSet.already"
                : "controlPanel.history.testSet.added"
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              fix.duplicate
                ? "historyView.fixes.testCase.descriptionExisting"
                : "historyView.fixes.testCase.descriptionNew"
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          <BidiInterpolatedText
            text={t("historyView.fixes.testCase.target", { target: BIDI_VALUE_TOKEN })}
            value={target}
            dir="auto"
          />
        </p>
        {!fix.durable && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/8 px-2.5 py-2 text-xs leading-relaxed text-foreground"
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
            <span>
              <span className="font-medium">{t("controlPanel.history.testSet.addedSession")}</span>
              {". "}
              {t(storageNoticeKey(fix.reason))}
            </span>
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          <TextBlock
            label={t("historyView.steps.heard")}
            hint={t("historyView.steps.heardHint")}
            text={testCase.rawText}
          />
          <TextBlock
            label={t("historyView.steps.final")}
            text={testCase.referenceText ?? fix.output}
          />
          <TextBlock label={t("historyView.fixes.testCase.correction")} text={fix.correction} />
        </div>
        <div>
          <p className="text-xs font-medium text-foreground">
            {t("historyView.fixes.testCase.suggested")}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
            {t(suggestedAny ? "historyView.fixes.literal" : "historyView.fixes.testCase.none")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <CheckList
            title={t("promptStudio.testSet.edit.mustContain")}
            rows={contain}
            onChange={setContain}
            nextKey={nextKey}
          />
          <CheckList
            title={t("promptStudio.testSet.edit.mustNotContain")}
            rows={notContain}
            onChange={setNotContain}
            nextKey={nextKey}
          />
        </div>
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
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {t("historyView.fixes.testCase.saveError")}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={saving} onClick={() => void save()}>
            {saving && <Loader2 size={13} className="animate-spin" />}
            {t("historyView.fixes.testCase.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The editors the fixes open; each saves only from its own Save. */
export function HistoryFixDialogs({ fixes }: { fixes: HistoryFixesController }) {
  const { t } = useTranslation();
  const existing = fixes.glossary?.existingSpelling ?? null;
  return (
    <>
      <GlossaryRuleDialog
        rule={fixes.glossary?.rule ?? null}
        onOpenChange={(open) => {
          if (!open) fixes.closeGlossary();
        }}
        notice={
          existing ? (
            <BidiInterpolatedText
              text={t("historyView.fixes.glossaryExisting", { spelling: BIDI_VALUE_TOKEN })}
              value={existing}
              dir="auto"
            />
          ) : null
        }
      />
      <DictionaryWordDialog
        word={fixes.dictionaryWord}
        onOpenChange={(open) => {
          if (!open) fixes.closeDictionary();
        }}
      />
      <TestCaseChecksDialog
        fix={fixes.testCase}
        onOpenChange={(open) => {
          if (!open) fixes.closeTestCase();
        }}
      />
    </>
  );
}

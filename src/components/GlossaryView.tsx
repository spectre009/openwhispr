import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, X } from "./icons";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Toggle } from "./ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { PAGE_CONTENT_WIDTH_CLASS } from "./ui/pageWidth";
import { CARD_SURFACE_CLASS } from "./ui/surfaces";
import { cn } from "./lib/utils";
import {
  deleteGlossaryRule,
  saveGlossaryRule,
  syncGlossaryRules,
  useGlossaryStore,
} from "../stores/glossaryStore";
import type { GlossaryRule, GlossaryScope, GlossarySpelling } from "../utils/glossary";
import type { GlossaryRuleInput } from "../types/electron";

// The glossary: corrections applied to the transcript before cleanup. Each
// rule names the canonical form and what speech-to-text writes instead; an
// "anywhere" spelling is replaced everywhere, a "start" spelling only when it
// opens the dictation in one of the listed apps.

const EMPTY_RULE: GlossaryRuleInput = {
  canonical: "",
  spellings: [{ text: "", scope: "anywhere" }],
  apps: [],
  enabled: true,
};

const SAVE_ERROR_KEYS: Record<string, string> = {
  GLOSSARY_CANONICAL_REQUIRED: "dictionary.glossary.errors.canonicalRequired",
  GLOSSARY_CANONICAL_TOO_LONG: "dictionary.glossary.errors.tooLong",
  GLOSSARY_SPELLING_TOO_LONG: "dictionary.glossary.errors.tooLong",
  GLOSSARY_TOO_MANY_SPELLINGS: "dictionary.glossary.errors.tooMany",
  GLOSSARY_TOO_MANY_APPS: "dictionary.glossary.errors.tooMany",
  GLOSSARY_NOT_FOUND: "dictionary.glossary.errors.notFound",
};

function toInput(rule: GlossaryRule): GlossaryRuleInput {
  return {
    id: rule.id,
    canonical: rule.canonical,
    spellings: rule.spellings.map((s) => ({ ...s })),
    apps: [...rule.apps],
    enabled: rule.enabled,
  };
}

function splitApps(value: string): string[] {
  return value
    .split(/[,\n]+/)
    .map((app) => app.trim())
    .filter(Boolean);
}

interface RuleDialogProps {
  rule: GlossaryRuleInput | null;
  onOpenChange: (open: boolean) => void;
}

function GlossaryRuleDialog({ rule, onOpenChange }: RuleDialogProps) {
  const { t } = useTranslation();
  const [canonical, setCanonical] = useState("");
  const [spellings, setSpellings] = useState<GlossarySpelling[]>([]);
  const [apps, setApps] = useState<string[]>([]);
  const [appDraft, setAppDraft] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rule) return;
    setCanonical(rule.canonical);
    setSpellings(rule.spellings.length > 0 ? rule.spellings.map((s) => ({ ...s })) : []);
    setApps([...rule.apps]);
    setAppDraft("");
    setEnabled(rule.enabled);
    setError(null);
    setSaving(false);
  }, [rule]);

  const usableSpellings = spellings.filter((s) => s.text.trim());
  const hasStartSpelling = usableSpellings.some((s) => s.scope === "start");
  const pendingApps = splitApps(appDraft);
  const canSave = !!canonical.trim() && usableSpellings.length > 0 && !saving;

  const addApps = () => {
    if (pendingApps.length === 0) return;
    setApps((current) => {
      const known = new Set(current.map((a) => a.toLowerCase()));
      const next = [...current];
      for (const app of pendingApps) {
        if (known.has(app.toLowerCase())) continue;
        known.add(app.toLowerCase());
        next.push(app);
      }
      return next;
    });
    setAppDraft("");
  };

  const updateSpelling = (index: number, patch: Partial<GlossarySpelling>) => {
    setSpellings((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave || !rule) return;
    setSaving(true);
    setError(null);
    // An app typed but not yet added still counts.
    const allApps = [...apps];
    for (const app of pendingApps) {
      if (!allApps.some((a) => a.toLowerCase() === app.toLowerCase())) allApps.push(app);
    }
    try {
      const result = await saveGlossaryRule({
        ...(rule.id ? { id: rule.id } : {}),
        canonical: canonical.trim(),
        spellings: usableSpellings.map((s) => ({ text: s.text.trim(), scope: s.scope })),
        apps: allApps,
        enabled,
      });
      if (result.success) {
        onOpenChange(false);
        return;
      }
      setError(t(SAVE_ERROR_KEYS[result.code ?? ""] ?? "dictionary.glossary.errors.saveFailed"));
    } catch {
      setError(t("dictionary.glossary.errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!rule} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {rule?.id ? t("dictionary.glossary.editTitle") : t("dictionary.glossary.newTitle")}
          </DialogTitle>
          <DialogDescription>{t("dictionary.glossary.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="glossary-canonical" className="text-xs font-medium">
              {t("dictionary.glossary.canonicalLabel")}
            </Label>
            <Input
              dir="auto"
              id="glossary-canonical"
              autoFocus
              value={canonical}
              onChange={(e) => setCanonical(e.target.value)}
              placeholder={t("dictionary.glossary.canonicalPlaceholder")}
              maxLength={100}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t("dictionary.glossary.spellingsLabel")}</Label>
            <p className="text-xs text-foreground/45 leading-relaxed">
              {t("dictionary.glossary.spellingsHint")}
            </p>
            <ul className="space-y-1.5">
              {spellings.map((spelling, index) => (
                <li key={index} className="flex items-center gap-2">
                  <Input
                    dir="auto"
                    value={spelling.text}
                    onChange={(e) => updateSpelling(index, { text: e.target.value })}
                    placeholder={t("dictionary.glossary.spellingPlaceholder")}
                    aria-label={t("dictionary.glossary.spellingLabel")}
                    maxLength={100}
                    className="h-9 flex-1 text-xs"
                  />
                  <Select
                    value={spelling.scope}
                    onValueChange={(scope) =>
                      updateSpelling(index, { scope: scope as GlossaryScope })
                    }
                  >
                    <SelectTrigger
                      className="h-9 w-44 text-xs"
                      aria-label={t("dictionary.glossary.scopeLabel")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anywhere" className="text-xs">
                        {t("dictionary.glossary.scopeAnywhere")}
                      </SelectItem>
                      <SelectItem value="start" className="text-xs">
                        {t("dictionary.glossary.scopeStart")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    onClick={() => setSpellings((current) => current.filter((_, i) => i !== index))}
                    aria-label={t("dictionary.glossary.removeSpelling", { text: spelling.text })}
                    className="p-1 text-foreground/45 hover:text-destructive/70 transition-colors"
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSpellings((current) => [...current, { text: "", scope: "start" }])}
            >
              <Plus size={14} />
              {t("dictionary.glossary.addSpelling")}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="glossary-app" className="text-xs font-medium">
              {t("dictionary.glossary.appsLabel")}
            </Label>
            <p className="text-xs text-foreground/45 leading-relaxed">
              {t("dictionary.glossary.appsHint")}
            </p>
            {apps.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {apps.map((app) => (
                  <li
                    key={app}
                    className="flex items-center gap-1 rounded-full border border-foreground/10 px-2 py-0.5 text-xs text-foreground/70 dark:border-white/10"
                  >
                    <span dir="ltr">{app}</span>
                    <button
                      type="button"
                      onClick={() => setApps((current) => current.filter((a) => a !== app))}
                      aria-label={t("dictionary.glossary.removeApp", { app })}
                      className="text-foreground/45 hover:text-destructive/70 transition-colors"
                    >
                      <X size={10} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <Input
                dir="ltr"
                id="glossary-app"
                value={appDraft}
                onChange={(e) => setAppDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addApps();
                  }
                }}
                placeholder={t("dictionary.glossary.appPlaceholder")}
                className="h-9 flex-1 text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addApps}
                disabled={pendingApps.length === 0}
              >
                {t("dictionary.add")}
              </Button>
            </div>
            {hasStartSpelling && apps.length === 0 && pendingApps.length === 0 && (
              <p className="text-xs text-warning">{t("dictionary.glossary.noAppsWarning")}</p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <Label className="text-xs font-medium">{t("dictionary.glossary.enabledLabel")}</Label>
            <Toggle
              checked={enabled}
              onChange={setEnabled}
              ariaLabel={t("dictionary.glossary.enabledLabel")}
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SpellingChips({ spellings }: { spellings: GlossarySpelling[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {spellings.map((s) => (
        <span
          key={`${s.scope}:${s.text}`}
          dir="auto"
          className="rounded-md bg-foreground/5 px-1.5 py-0.5 text-[11px] text-foreground/60 dark:bg-white/8"
        >
          {s.text}
        </span>
      ))}
    </span>
  );
}

export default function GlossaryView() {
  const { t } = useTranslation();
  const rules = useGlossaryStore((s) => s.rules);
  const [editing, setEditing] = useState<GlossaryRuleInput | null>(null);
  const [deleting, setDeleting] = useState<GlossaryRule | null>(null);
  const [toggleError, setToggleError] = useState(false);

  // The store follows main's broadcasts; this only covers a window that
  // opened the page before settings finished initializing.
  useEffect(() => {
    void syncGlossaryRules();
  }, []);

  const setEnabled = async (rule: GlossaryRule, enabled: boolean) => {
    setToggleError(false);
    const result = await saveGlossaryRule({ ...toInput(rule), enabled }).catch(() => null);
    if (!result?.success) setToggleError(true);
  };

  return (
    <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "flex flex-col gap-3 px-6 py-5")}>
      <GlossaryRuleDialog
        rule={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t("dictionary.glossary.deleteTitle", { canonical: deleting?.canonical ?? "" })}
        description={t("dictionary.glossary.deleteDescription")}
        onConfirm={() => {
          if (deleting) void deleteGlossaryRule(deleting.id);
          setDeleting(null);
        }}
        variant="destructive"
      />

      <div className="flex items-start justify-between gap-4">
        <p className="max-w-xl text-xs leading-relaxed text-foreground/50 dark:text-foreground/65">
          {t("dictionary.glossary.description")}
        </p>
        <Button size="sm" className="shrink-0" onClick={() => setEditing({ ...EMPTY_RULE })}>
          <Plus size={14} />
          {t("dictionary.glossary.newRule")}
        </Button>
      </div>

      <div className={cn(CARD_SURFACE_CLASS, "shadow-sm px-4 py-3")}>
        <h3 className="text-xs font-semibold text-foreground/45">
          {t("dictionary.glossary.title")}
        </h3>
        <div className="mt-2.5 border-t border-dashed border-foreground/10 dark:border-white/10" />
        {rules.length === 0 ? (
          <p className="py-6 text-center text-xs text-foreground/45">
            {t("dictionary.glossary.empty")}
          </p>
        ) : (
          <ul>
            {rules.map((rule) => {
              const anywhere = rule.spellings.filter((s) => s.scope === "anywhere");
              const start = rule.spellings.filter((s) => s.scope === "start");
              return (
                <li
                  key={rule.id}
                  className="group flex items-start gap-3 border-b border-foreground/4 py-3 last:border-b-0 dark:border-white/10"
                >
                  <div className={cn("min-w-0 flex-1 space-y-1.5", !rule.enabled && "opacity-55")}>
                    <span dir="auto" className="block text-sm font-medium text-foreground">
                      {rule.canonical}
                    </span>
                    {anywhere.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-foreground/45">
                        <span>{t("dictionary.glossary.anywhereSummary")}</span>
                        <SpellingChips spellings={anywhere} />
                      </div>
                    )}
                    {start.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-foreground/45">
                        <span>
                          {rule.apps.length > 0
                            ? t("dictionary.glossary.startSummary", {
                                apps: rule.apps.join(", "),
                              })
                            : t("dictionary.glossary.startSummaryNoApps")}
                        </span>
                        <SpellingChips spellings={start} />
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => setEditing(toInput(rule))}
                      aria-label={t("dictionary.glossary.edit", { canonical: rule.canonical })}
                      className="p-1 text-foreground/45 opacity-0 transition-opacity duration-150 hover:text-foreground/60 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      onClick={() => setDeleting(rule)}
                      aria-label={t("dictionary.glossary.remove", { canonical: rule.canonical })}
                      className="p-1 text-foreground/45 opacity-0 transition-opacity duration-150 hover:text-destructive/70 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                    <Toggle
                      checked={rule.enabled}
                      onChange={(enabled) => void setEnabled(rule, enabled)}
                      ariaLabel={t("dictionary.glossary.toggle", { canonical: rule.canonical })}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {toggleError && (
        <p className="text-xs text-destructive">{t("dictionary.glossary.errors.saveFailed")}</p>
      )}
      <p className="text-xs leading-relaxed text-foreground/45">
        {t("dictionary.glossary.footnote")}
      </p>
    </div>
  );
}

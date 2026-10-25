import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Info, Plus, X } from "./icons";
import {
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
import { saveGlossaryRule } from "../stores/glossaryStore";
import type { GlossaryScope, GlossarySpelling } from "../utils/glossary";
import type { GlossaryRuleInput } from "../types/electron";

// The glossary's rule editor: the canonical form, the spellings it replaces
// (each "anywhere" or "start of dictation") and the apps for start spellings.
// Saved through main (glossary-save-rule) only on Save. Used by the Dictionary
// page's Glossary tab and by the History review's fixes.

const SAVE_ERROR_KEYS: Record<string, string> = {
  GLOSSARY_CANONICAL_REQUIRED: "dictionary.glossary.errors.canonicalRequired",
  GLOSSARY_CANONICAL_TOO_LONG: "dictionary.glossary.errors.tooLong",
  GLOSSARY_SPELLING_TOO_LONG: "dictionary.glossary.errors.tooLong",
  GLOSSARY_TOO_MANY_SPELLINGS: "dictionary.glossary.errors.tooMany",
  GLOSSARY_TOO_MANY_APPS: "dictionary.glossary.errors.tooMany",
  GLOSSARY_NOT_FOUND: "dictionary.glossary.errors.notFound",
};

function splitApps(value: string): string[] {
  return value
    .split(/[,\n]+/)
    .map((app) => app.trim())
    .filter(Boolean);
}

interface GlossaryRuleDialogProps {
  rule: GlossaryRuleInput | null;
  onOpenChange: (open: boolean) => void;
  /** Shown above the form, e.g. why an existing rule was opened. */
  notice?: ReactNode;
}

export default function GlossaryRuleDialog({
  rule,
  onOpenChange,
  notice,
}: GlossaryRuleDialogProps) {
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
        {notice && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2 text-xs leading-relaxed text-foreground"
          >
            <Info size={13} className="mt-0.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">{notice}</span>
          </p>
        )}
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

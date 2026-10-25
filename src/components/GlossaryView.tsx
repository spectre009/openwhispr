import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, X } from "./icons";
import { ConfirmDialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle";
import { PAGE_CONTENT_WIDTH_CLASS } from "./ui/pageWidth";
import { CARD_SURFACE_CLASS } from "./ui/surfaces";
import { cn } from "./lib/utils";
import GlossaryRuleDialog from "./GlossaryRuleDialog";
import {
  deleteGlossaryRule,
  glossaryRuleInput,
  saveGlossaryRule,
  syncGlossaryRules,
  useGlossaryStore,
} from "../stores/glossaryStore";
import type { GlossaryRule, GlossarySpelling } from "../utils/glossary";
import type { GlossaryRuleInput } from "../types/electron";

// The glossary: corrections applied to the transcript before cleanup. Each
// rule names the canonical form and what speech-to-text writes instead; an
// "anywhere" spelling is replaced everywhere, a "start" spelling only when it
// opens the dictation in one of the listed apps. The rule editor is
// GlossaryRuleDialog.

const EMPTY_RULE: GlossaryRuleInput = {
  canonical: "",
  spellings: [{ text: "", scope: "anywhere" }],
  apps: [],
  enabled: true,
};

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
    const result = await saveGlossaryRule({ ...glossaryRuleInput(rule), enabled }).catch(
      () => null
    );
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
                      onClick={() => setEditing(glossaryRuleInput(rule))}
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

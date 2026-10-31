import { useTranslation } from "react-i18next";
import { Info } from "../icons";
import { cn } from "../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { APPEARANCE_KIND_BG } from "./dictionaryLabels";

// What the Dictionary's usage numbers mean: "used", "speech got it", "fixed
// after speech" and "changed after speech" (the old "heard" and "written"),
// counted per dictation over 90 days of local History. Opened from the ⓘ in
// the list's usage column (and the word panel's usage card), as a popover
// reachable by keyboard: Enter or Space opens it, Esc closes it and returns
// focus to the ⓘ.

function Case({
  swatch,
  title,
  was,
  body,
}: {
  swatch: string;
  title: string;
  was?: string;
  body: string;
}) {
  return (
    <div className="grid grid-cols-[0.875rem_1fr] gap-x-2.5">
      <span aria-hidden className={cn("mt-1 h-3 w-3 rounded-[3px]", swatch)} />
      <div>
        <p className="text-xs font-semibold text-foreground">
          {title}
          {was && (
            <span className="ms-1.5 text-[11px] font-normal text-muted-foreground">{was}</span>
          )}
        </p>
        <p className="text-[11.5px] leading-snug text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

export function DictionaryUsageExplainerContent() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2.5" data-dictionary-usage-explainer>
      <div>
        <p className="text-[13px] font-semibold text-foreground">
          {t("dictionary.explainer.title")}
        </p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {t("dictionary.explainer.subtitle")}
        </p>
      </div>
      <Case
        swatch="border border-border"
        title={t("dictionary.kinds.used")}
        was={t("dictionary.explainer.wasWritten")}
        body={t("dictionary.explainer.used")}
      />
      <Case
        swatch={APPEARANCE_KIND_BG.ok}
        title={t("dictionary.kinds.ok")}
        was={t("dictionary.explainer.wasHeard")}
        body={t("dictionary.explainer.ok")}
      />
      <Case
        swatch={APPEARANCE_KIND_BG.fix}
        title={t("dictionary.kinds.fix")}
        body={t("dictionary.explainer.fix")}
      />
      <Case
        swatch={APPEARANCE_KIND_BG.chg}
        title={t("dictionary.kinds.chg")}
        body={t("dictionary.explainer.chg")}
      />
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t("dictionary.explainer.note")}
      </p>
    </div>
  );
}

/** The ⓘ that opens the explainer. */
export default function DictionaryUsageExplainer({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("dictionary.explainer.open")}
          title={t("dictionary.explainer.open")}
          data-dictionary-usage-info
          className={cn(
            "inline-grid h-4 w-4 place-items-center rounded-full text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            className
          )}
        >
          <Info size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] max-w-[calc(100vw-2rem)] p-3.5" align="start">
        <DictionaryUsageExplainerContent />
      </PopoverContent>
    </Popover>
  );
}

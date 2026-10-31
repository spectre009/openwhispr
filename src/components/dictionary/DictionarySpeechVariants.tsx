import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Wand2 } from "../icons";
import { Button } from "../ui/button";
import { useGlossaryStore } from "../../stores/glossaryStore";
import { glossaryHandles } from "../../utils/dictionaryGlossaryOffer";
import type { DictionarySpeechVariant } from "../../types/electron";
import { usageUnavailableKey } from "./dictionaryLabels";

// "Speech writes it as" (the word panel): the spellings speech wrote where the
// final text has the word (dictionary-speech-variants), each with how many
// dictations it was fixed from and how many kept it as written, the evidence
// that a glossary rule for it could harm. "Make a glossary rule" opens the
// rule editor with the risk stated; a spelling an enabled rule already turns
// into this word says so instead. Read again when the glossary changes, and
// when History, the dictionary, the owner or the policy did.

type State =
  | { status: "loading" }
  | { status: "unavailable"; reason: string | null }
  | { status: "ready"; variants: DictionarySpeechVariant[] };

export default function DictionarySpeechVariants({
  word,
  refreshKey,
  onMakeRule,
}: {
  word: string;
  refreshKey: number;
  onMakeRule: (variant: DictionarySpeechVariant) => void;
}) {
  const { t } = useTranslation();
  const rules = useGlossaryStore((state) => state.rules);
  const glossaryRevision = useGlossaryStore((state) => state.revision);
  const [state, setState] = useState<State>({ status: "loading" });
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setState((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
    const read = window.electronAPI?.getDictionarySpeechVariants;
    if (!read) {
      setState({ status: "unavailable", reason: null });
      return;
    }
    read(word).then(
      (result) => {
        if (current !== generation.current) return;
        setState(
          result?.available
            ? { status: "ready", variants: result.variants ?? [] }
            : {
                status: "unavailable",
                reason: (result && "reason" in result && result.reason) || null,
              }
        );
      },
      () => {
        if (current === generation.current) setState({ status: "unavailable", reason: null });
      }
    );
  }, [word, refreshKey, glossaryRevision]);

  if (state.status === "loading") return null;
  if (state.status === "unavailable") {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground" data-variants-unavailable>
        {t(usageUnavailableKey(state.reason))}
      </p>
    );
  }
  if (state.variants.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("dictionary.variants.none")}</p>;
  }
  return (
    <ul className="space-y-2" data-speech-variants>
      {state.variants.map((variant) => {
        const handled = glossaryHandles(rules, word, variant.spelling);
        return (
          <li key={variant.spelling} data-speech-variant={variant.spelling} className="text-xs">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <del dir="auto" className="font-medium text-destructive/85 decoration-destructive/60">
                {variant.spelling}
              </del>
              <span className="text-muted-foreground">
                {t("dictionary.variants.count", { count: variant.count })}
              </span>
              <span className="ms-auto">
                {handled ? (
                  <span className="text-[11px] text-success" data-glossary-handles>
                    {t("dictionary.variants.handled")}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => onMakeRule(variant)}
                  >
                    <Wand2 size={11} />
                    {t("dictionary.variants.makeRule")}
                  </Button>
                )}
              </span>
            </div>
            <p
              className={
                variant.keptInFinal > 0
                  ? "mt-0.5 text-[11px] leading-snug text-warning"
                  : "mt-0.5 text-[11px] leading-snug text-muted-foreground"
              }
            >
              {variant.keptInFinal > 0
                ? t("dictionary.variants.kept", {
                    count: variant.keptInFinal,
                    spelling: variant.spelling,
                  })
                : t("dictionary.variants.neverKept")}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

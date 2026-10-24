import type { TranscriptionStepRecord } from "../../types/electron";

// The names History › View steps gives a dictation's saved steps, shared with
// the Dictation overview's "Last dictation" card so both say the same thing.

type Translate = (key: string) => string;

const KIND_KEYS: Record<string, string> = {
  stt: "stt",
  glossary: "glossary",
  cleanup: "cleanup",
  translation: "translation",
  agent: "agent",
  style: "style",
  finalize: "finalize",
};

/** A step's name: "Speech-to-Text", "Glossary", … ("Snippets" for the snippet finalize step). */
export function stepKindLabel(
  step: Pick<TranscriptionStepRecord, "kind" | "detail">,
  t: Translate
): string {
  if (step.kind === "finalize" && step.detail?.snippets) {
    return t("controlPanel.history.steps.kinds.snippets");
  }
  const key = KIND_KEYS[step.kind];
  return key ? t(`controlPanel.history.steps.kinds.${key}`) : step.kind;
}

/** The badge a step that didn't simply succeed carries ("Failed", "Skipped", "Kept previous text"). */
export function stepOutcomeLabel(
  outcome: TranscriptionStepRecord["outcome"],
  t: Translate
): string | null {
  return outcome === "ok" ? null : t(`controlPanel.history.steps.outcomes.${outcome}`);
}

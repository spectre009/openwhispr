import type { HintCoverage } from "../../utils/dictionaryHints";

// The coverage dot's color: sent and likely read, sent but likely not read
// (past a Whisper prompt's tail window), not sent.
export const COVERAGE_DOT_CLASS: Record<HintCoverage, string> = {
  read: "bg-success",
  unread: "bg-warning",
  notSent: "bg-foreground/30",
};

export const COVERAGE_TEXT_CLASS: Record<HintCoverage, string> = {
  read: "text-foreground/75",
  unread: "text-warning",
  notSent: "text-muted-foreground",
};

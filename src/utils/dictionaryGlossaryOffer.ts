// A glossary rule offered from what speech wrote instead of a dictionary word
// (the Dictionary's "Speech writes it as" and History's "Dictionary in this
// dictation"), with the risk stated. Pure.
//
// - Scope: `anywhere` only when the spelling never stayed as written in a
//   final text (`keptInFinal` 0) and isn't everyday words (every lowercase
//   token in the bundled common-word list); otherwise `start`, which applies
//   only at the start of a dictation in apps the user picks, and the dialog
//   says why. Without the evidence (History not kept, the list not loaded)
//   it's `start`.
// - "The glossary handles this": an enabled rule already writes this word from
//   this spelling. A rule that already has the spelling (for any word) opens
//   as it is; one that writes the word gets the spelling added.

import { usageTokens } from "../helpers/dictionaryUsage.js";
import { dictionaryWordKey } from "./dictionaryWordKey.js";
import { glossaryRuleWithSpelling, glossarySpellingKey } from "./historyFixes";
import type { GlossaryRule, GlossaryScope } from "./glossary";
import type { GlossaryRuleInput } from "../types/electron";

/** Why a rule starts limited: the spelling stayed as written, it's everyday words, or unknown. */
export type GlossaryOfferCaution = "kept" | "common" | "unknown";

/** Whether every token of `spelling` is a common English word; unknown list ⇒ treated as common. */
export function isCommonSpelling(
  spelling: string,
  commonWords: ReadonlySet<string> | null | undefined
): boolean {
  const tokens = usageTokens(spelling);
  // Unknown (not loaded, or it couldn't be read): treated as everyday words.
  if (tokens.length === 0 || !commonWords || commonWords.size === 0) return true;
  return tokens.every((token: string) => commonWords.has(token));
}

/** The scope a rule for `spelling` starts with, and why it's limited when it is. */
export function glossaryOfferScope({
  keptInFinal,
  common,
}: {
  keptInFinal: number | null | undefined;
  common: boolean;
}): { scope: GlossaryScope; caution: GlossaryOfferCaution | null } {
  if (keptInFinal === null || keptInFinal === undefined || !Number.isFinite(keptInFinal)) {
    return { scope: "start", caution: "unknown" };
  }
  if (keptInFinal > 0) return { scope: "start", caution: "kept" };
  if (common) return { scope: "start", caution: "common" };
  return { scope: "anywhere", caution: null };
}

/** The enabled rule that already writes `word` from `spelling`, if any. */
export function glossaryHandles(
  rules: readonly GlossaryRule[],
  word: string,
  spelling: string
): GlossaryRule | null {
  const key = dictionaryWordKey(word);
  const spellingKey = glossarySpellingKey(spelling);
  if (!key || !spellingKey) return null;
  return (
    rules.find(
      (rule) =>
        rule.enabled &&
        dictionaryWordKey(rule.canonical) === key &&
        rule.spellings.some((candidate) => glossarySpellingKey(candidate.text) === spellingKey)
    ) ?? null
  );
}

export interface GlossaryOffer {
  rule: GlossaryRuleInput;
  /** What the dialog says first: an existing rule opened, the spelling added to one, or neither. */
  opened: "existingSpelling" | "addedToRule" | "new";
  scope: GlossaryScope;
  caution: GlossaryOfferCaution | null;
}

/**
 * The rule dialog's input for making `word` from `spelling`: the rule that
 * already has the spelling, as it is; else the rule that writes the word,
 * with the spelling added; else a new rule. The spelling's scope follows
 * glossaryOfferScope.
 */
export function glossaryOfferFor(
  rules: readonly GlossaryRule[],
  word: string,
  spelling: string,
  evidence: { keptInFinal: number | null | undefined; commonWords: ReadonlySet<string> | null }
): GlossaryOffer {
  const { scope, caution } = glossaryOfferScope({
    keptInFinal: evidence.keptInFinal,
    common: isCommonSpelling(spelling, evidence.commonWords),
  });
  const input = (rule: GlossaryRule): GlossaryRuleInput => ({
    id: rule.id,
    canonical: rule.canonical,
    spellings: rule.spellings.map((s) => ({ ...s })),
    apps: [...rule.apps],
    enabled: rule.enabled,
  });
  const holder = glossaryRuleWithSpelling(rules, spelling);
  if (holder) return { rule: input(holder), opened: "existingSpelling", scope, caution };
  const key = dictionaryWordKey(word);
  const writer = rules.find((rule) => dictionaryWordKey(rule.canonical) === key);
  if (writer) {
    const rule = input(writer);
    rule.spellings.push({ text: spelling, scope });
    return { rule, opened: "addedToRule", scope, caution };
  }
  return {
    rule: { canonical: word, spellings: [{ text: spelling, scope }], apps: [], enabled: true },
    opened: "new",
    scope,
    caution,
  };
}

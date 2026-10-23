// The canonical forms of the active glossary rules, for the hint lists that
// read settings synchronously (getDictionaryHintWords: the cleanup, agent and
// translation dictionary suffix). The renderer's glossary store publishes them
// here whenever main broadcasts a rule change; nothing else writes it.
//
// Only canonical forms are ever published. A rule's "heard as" spellings
// ("everybody") must never reach a hint list: they would bias speech-to-text
// and cleanup towards the very mishearing the rule corrects.

let canonicalTerms: readonly string[] = [];

export function setGlossaryCanonicalTerms(terms: readonly string[] | null | undefined): void {
  canonicalTerms = Array.isArray(terms)
    ? Object.freeze(terms.filter((t) => typeof t === "string" && t.trim().length > 0))
    : [];
}

export function getGlossaryCanonicalTerms(): readonly string[] {
  return canonicalTerms;
}

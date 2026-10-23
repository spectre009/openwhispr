// Main-owned glossary rules: validation, normalization and the first-run seed.
// The table lives in the history database (database.js); the renderer only
// mirrors it (stores/glossaryStore.ts) and matches with utils/glossary.ts.
// Device-wide and local-only: never synced, exported or indexed.

const { randomUUID } = require("crypto");

const SCOPES = new Set(["anywhere", "start"]);
const MAX_CANONICAL_LENGTH = 100;
const MAX_SPELLING_LENGTH = 100;
const MAX_SPELLINGS = 50;
const MAX_APP_LENGTH = 260;
const MAX_APPS = 50;

// The rule shipped on first run. "littlebuddy" is never a real word, so it is
// safe anywhere; the others are real words and only open a dictation into the
// apps where the user talks to an assistant.
const SEED_RULES = Object.freeze([
  Object.freeze({
    canonical: "Little Buddy",
    spellings: Object.freeze([
      Object.freeze({ text: "littlebuddy", scope: "anywhere" }),
      Object.freeze({ text: "everybody", scope: "start" }),
      Object.freeze({ text: "every body", scope: "start" }),
      Object.freeze({ text: "buddy", scope: "start" }),
      Object.freeze({ text: "buddies", scope: "start" }),
      Object.freeze({ text: "little buddies", scope: "start" }),
    ]),
    apps: Object.freeze(["github.exe", "Code.exe", "WindowsTerminal.exe", "Obsidian.exe"]),
    enabled: true,
  }),
]);

class GlossaryRuleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const collapse = (value) => value.trim().replace(/\s+/g, " ");

function normalizeSpellings(spellings, canonical) {
  if (!Array.isArray(spellings)) {
    throw new GlossaryRuleError("GLOSSARY_INVALID", "spellings must be an array");
  }
  const seen = new Set();
  const out = [];
  for (const entry of spellings) {
    const text = typeof entry?.text === "string" ? collapse(entry.text) : "";
    if (!text) continue;
    if (text.length > MAX_SPELLING_LENGTH) {
      throw new GlossaryRuleError("GLOSSARY_SPELLING_TOO_LONG", "A spelling is too long");
    }
    const key = text.toLowerCase();
    // The canonical form is not a misspelling of itself.
    if (key === canonical.toLowerCase() || seen.has(key)) continue;
    seen.add(key);
    const scope = SCOPES.has(entry?.scope) ? entry.scope : "start";
    out.push({ text, scope });
  }
  if (out.length > MAX_SPELLINGS) {
    throw new GlossaryRuleError("GLOSSARY_TOO_MANY_SPELLINGS", "Too many spellings");
  }
  return out;
}

function normalizeApps(apps) {
  if (apps === undefined || apps === null) return [];
  if (!Array.isArray(apps)) {
    throw new GlossaryRuleError("GLOSSARY_INVALID", "apps must be an array");
  }
  const seen = new Set();
  const out = [];
  for (const app of apps) {
    const name = typeof app === "string" ? app.trim() : "";
    if (!name || name.length > MAX_APP_LENGTH) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (out.length > MAX_APPS) {
    throw new GlossaryRuleError("GLOSSARY_TOO_MANY_APPS", "Too many apps");
  }
  return out;
}

/**
 * Validates a rule from the renderer and returns the stored shape (without
 * id, revision or timestamps). Throws GlossaryRuleError with a code.
 */
function normalizeGlossaryRuleInput(input) {
  if (!input || typeof input !== "object") {
    throw new GlossaryRuleError("GLOSSARY_INVALID", "rule must be an object");
  }
  const canonical = typeof input.canonical === "string" ? collapse(input.canonical) : "";
  if (!canonical) {
    throw new GlossaryRuleError("GLOSSARY_CANONICAL_REQUIRED", "A canonical form is required");
  }
  if (canonical.length > MAX_CANONICAL_LENGTH) {
    throw new GlossaryRuleError("GLOSSARY_CANONICAL_TOO_LONG", "The canonical form is too long");
  }
  return {
    canonical,
    spellings: normalizeSpellings(input.spellings, canonical),
    apps: normalizeApps(input.apps),
    enabled: input.enabled !== false,
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A database row as the renderer sees it. */
function glossaryRuleFromRow(row) {
  return {
    id: row.id,
    canonical: row.canonical,
    spellings: parseJsonArray(row.spellings).filter(
      (s) => s && typeof s.text === "string" && SCOPES.has(s.scope)
    ),
    apps: parseJsonArray(row.apps).filter((a) => typeof a === "string"),
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lowercased words auto-learn must never add to the dictionary: every word of
 * every spelling and canonical form. A user reverting a glossary correction
 * ("Little Buddy" back to "everybody") must not teach the hint list the very
 * mishearing the rule corrects, and canonical forms already reach it.
 */
function glossaryLearnExclusions(rules) {
  const excluded = new Set();
  for (const rule of Array.isArray(rules) ? rules : []) {
    const phrases = [rule?.canonical, ...(rule?.spellings || []).map((s) => s?.text)];
    for (const phrase of phrases) {
      if (typeof phrase !== "string") continue;
      const lower = phrase.trim().toLowerCase();
      if (!lower) continue;
      excluded.add(lower);
      for (const word of lower.split(/\s+/)) excluded.add(word);
    }
  }
  return excluded;
}

module.exports = {
  SEED_RULES,
  GlossaryRuleError,
  newGlossaryRuleId: () => randomUUID(),
  normalizeGlossaryRuleInput,
  glossaryRuleFromRow,
  glossaryLearnExclusions,
};

import { create } from "zustand";
import logger from "../utils/logger";
import {
  activeGlossaryRules,
  glossaryCanonicalTerms,
  type GlossaryRule,
  type GlossarySnapshot,
} from "../utils/glossary";
import { setGlossaryCanonicalTerms } from "../utils/glossaryTerms";
import type { GlossaryRuleInput, GlossarySaveResult } from "../types/electron";

// The renderer's mirror of main's glossary rules (the `glossary_rules` table).
// Main owns them; every window follows the `glossary-rules-updated` broadcast,
// so an edit on the Dictionary page reaches the dictation window at once.

interface GlossaryStoreState extends GlossarySnapshot {
  /** False until main has answered once. */
  loaded: boolean;
}

export const useGlossaryStore = create<GlossaryStoreState>()(() => ({
  revision: 0,
  rules: [],
  loaded: false,
}));

function isSnapshot(value: unknown): value is GlossarySnapshot {
  const snapshot = value as GlossarySnapshot;
  return !!snapshot && Array.isArray(snapshot.rules) && Number.isFinite(snapshot.revision);
}

function applySnapshot(next: unknown): void {
  if (!isSnapshot(next)) return;
  const current = useGlossaryStore.getState();
  // A late answer must never roll a newer broadcast back.
  if (current.loaded && next.revision < current.revision) return;
  const rules = next.rules.map((rule) => Object.freeze({ ...rule })) as GlossaryRule[];
  useGlossaryStore.setState({ revision: next.revision, rules, loaded: true });
  setGlossaryCanonicalTerms(glossaryCanonicalTerms(rules));
}

/**
 * The rule set one dictation applies: read once at the post-speech-to-text
 * boundary, so a rule edited mid-dictation can't apply half-way.
 */
export function getGlossarySnapshot(): GlossarySnapshot {
  const { revision, rules } = useGlossaryStore.getState();
  return { revision, rules: activeGlossaryRules(rules) };
}

let subscribed = false;

/** Loads the rules and follows main's broadcasts. Safe to call on every mount. */
export async function syncGlossaryRules(): Promise<void> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!subscribed && api?.onGlossaryRulesUpdated) {
    subscribed = true;
    api.onGlossaryRulesUpdated((snapshot) => applySnapshot(snapshot));
  }
  if (!api?.getGlossaryRules) return;
  try {
    applySnapshot(await api.getGlossaryRules());
  } catch (error) {
    logger.warn("Couldn't load glossary rules", { error: (error as Error)?.message }, "settings");
  }
}

export async function saveGlossaryRule(rule: GlossaryRuleInput): Promise<GlossarySaveResult> {
  const save = typeof window !== "undefined" ? window.electronAPI?.saveGlossaryRule : undefined;
  if (!save) return { success: false, error: "unavailable" };
  const result = await save(rule);
  if (result?.success && result.snapshot) applySnapshot(result.snapshot);
  return result;
}

export async function deleteGlossaryRule(id: string): Promise<GlossarySaveResult> {
  const remove = typeof window !== "undefined" ? window.electronAPI?.deleteGlossaryRule : undefined;
  if (!remove) return { success: false, error: "unavailable" };
  const result = await remove(id);
  if (result?.success && result.snapshot) applySnapshot(result.snapshot);
  return result;
}

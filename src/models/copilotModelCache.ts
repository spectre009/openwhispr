import type { CloudModelDefinition } from "./ModelRegistry";
import modelRegistryData from "./modelRegistryData.json";

// A leaf like tinfoilModelCache: it imports only a type from ModelRegistry, so
// the settings store can read the live GitHub Copilot list without reopening
// the ModelRegistry → settingsStore cycle.

const CACHE_KEY = "copilotModels";
const MAX_AGE_MS = 60 * 60 * 1000;

const isBrowser = typeof window !== "undefined" && typeof localStorage !== "undefined";

export interface CachedCopilotModels {
  models: CloudModelDefinition[];
  /** Epoch ms of the fetch that produced `models`, or 0 if we've never fetched. */
  fetchedAt: number;
}

const EMPTY: CachedCopilotModels = { models: [], fetchedAt: 0 };

/**
 * The registry's shipped list, kept apart because a live list replaces the
 * registry entry's models: shown while signed out or before the first fetch.
 */
export const COPILOT_FALLBACK_MODELS: readonly CloudModelDefinition[] = Object.freeze([
  ...((
    modelRegistryData.cloudProviders as Array<{ id: string; models: CloudModelDefinition[] }>
  ).find((provider) => provider.id === "copilot")?.models ?? []),
]);

export function readCachedCopilotModels(): CachedCopilotModels {
  if (!isBrowser) return EMPTY;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return EMPTY;

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.models) || typeof parsed.fetchedAt !== "number") return EMPTY;
    return { models: parsed.models, fetchedAt: parsed.fetchedAt };
  } catch {
    return EMPTY;
  }
}

export function writeCachedCopilotModels(models: CloudModelDefinition[]): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ models, fetchedAt: Date.now() }));
  } catch {}
}

export function clearCachedCopilotModels(): void {
  if (!isBrowser) return;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
}

export function isCachedCopilotListFresh(cached: CachedCopilotModels): boolean {
  return cached.models.length > 0 && Date.now() - cached.fetchedAt < MAX_AGE_MS;
}

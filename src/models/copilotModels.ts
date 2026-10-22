import {
  applyCopilotModels,
  getCloudProviderDefaultModelId,
  getCopilotModels,
  resetCopilotModels,
  type CloudModelDefinition,
} from "./ModelRegistry";
import { pickProviderDefaultModel } from "./providerDefaultModel";
import {
  COPILOT_FALLBACK_MODELS,
  clearCachedCopilotModels,
  isCachedCopilotListFresh,
  readCachedCopilotModels,
  writeCachedCopilotModels,
} from "./copilotModelCache";
import { INFERENCE_SCOPES, type InferenceScope } from "../config/inferenceScopes";
import { COPILOT_PROVIDER_ID, isCopilotScopeSupported } from "../config/copilot";
import {
  selectResolvedLLMConfig,
  setStringSetting,
  useSettingsStore,
} from "../stores/settingsStore";
import { errorFromIpcResult } from "../helpers/ipcErrorFields";
import type { CopilotModel } from "../types/electron";
import logger from "../utils/logger";

const LIVE_MODEL_DESCRIPTION = "Available on your GitHub Copilot plan";
const LIVE_MODEL_DESCRIPTION_KEY = "models.descriptions.cloud.copilot_live";

// The shipped models keep their curated, translated descriptions when the live
// list serves them too; GitHub's catalog carries none.
const CURATED = new Map(COPILOT_FALLBACK_MODELS.map((model) => [model.id, model]));

/**
 * The registry's form of the catalog main reports. Text-only in this app, so
 * vision is never claimed; a model with reasoning efforts gets the thinking
 * toggle, which main maps to its lowest effort.
 */
export function toCopilotCloudModels(catalog: CopilotModel[]): CloudModelDefinition[] {
  return catalog
    .filter((model) => typeof model?.id === "string" && model.id.length > 0)
    .map((model) => {
      const curated = CURATED.get(model.id);
      return {
        id: model.id,
        name: model.name || model.id,
        description: curated?.description ?? LIVE_MODEL_DESCRIPTION,
        descriptionKey: curated?.descriptionKey ?? LIVE_MODEL_DESCRIPTION_KEY,
        supportsThinking: (model.reasoningEfforts?.length ?? 0) > 0,
      };
    });
}

// In INFERENCE_SCOPES order, so cleanup is repointed before note formatting,
// which inherits it.
const COPILOT_SCOPES = (Object.keys(INFERENCE_SCOPES) as InferenceScope[]).filter(
  isCopilotScopeSupported
);

let reconciling = false;

/** The Copilot model a scope sends with, or null when it doesn't use Copilot. */
function copilotModelOf(scope: InferenceScope): string | null {
  const config = selectResolvedLLMConfig(useSettingsStore.getState(), scope);
  // The model slot is shared with local mode, so only providers mode is Copilot's.
  if (config.mode !== "providers" || config.provider !== COPILOT_PROVIDER_ID) return null;
  return config.model;
}

/**
 * Moves any scope that sends to Copilot with a model the plan doesn't serve
 * onto the provider default. Scopes are resolved first: note formatting borrows
 * cleanup's provider but keeps its own model, so switching cleanup to Copilot
 * leaves it holding another provider's model id. Only ever given a list from a
 * signed-in fetch (live or cached within the hour), so a missing model really
 * is gone; offline, the saved pick stays.
 */
function reconcileSelectedModels(models: CloudModelDefinition[]): void {
  const replacement = pickProviderDefaultModel(
    models,
    getCloudProviderDefaultModelId(COPILOT_PROVIDER_ID)
  );
  if (!replacement || reconciling) return;
  const available = new Set(models.map((model) => model.id));

  // Each write notifies the settings subscription below; it has nothing to add.
  reconciling = true;
  try {
    for (const scope of COPILOT_SCOPES) {
      const selected = copilotModelOf(scope);
      if (!selected || available.has(selected)) continue;

      setStringSetting(INFERENCE_SCOPES[scope].storeKeys.model, replacement.id);
      logger.info(
        "Repointed a GitHub Copilot model selection",
        { scope, from: selected, to: replacement.id },
        "models"
      );
    }
  } finally {
    reconciling = false;
  }
}

/**
 * A scope can start sending to Copilot while no Copilot picker is on screen
 * (note formatting follows cleanup's provider), so every settings change is
 * checked against the list fetched within the hour.
 */
function reconcileWithFreshList(): void {
  if (reconciling) return;
  const offered = new Set(getCopilotModels().map((model) => model.id));
  const stale = COPILOT_SCOPES.some((scope) => {
    const selected = copilotModelOf(scope);
    return !!selected && !offered.has(selected);
  });
  if (!stale) return;

  const cached = readCachedCopilotModels();
  if (isCachedCopilotListFresh(cached)) reconcileSelectedModels(cached.models);
}

useSettingsStore.subscribe(reconcileWithFreshList);

// Bumped by every reset, so a fetch that was in flight across a sign-out never
// puts the previous account's list back.
let generation = 0;
let inFlight: Promise<CloudModelDefinition[]> | null = null;

async function fetchAndApply(refresh: boolean): Promise<CloudModelDefinition[]> {
  const startedIn = generation;
  if (!window.electronAPI?.listCopilotModels) {
    throw new Error("GitHub Copilot model list is unavailable");
  }
  const result = await window.electronAPI.listCopilotModels({ refresh });
  if (!result?.success) throw errorFromIpcResult(result);

  const models = toCopilotCloudModels(result.models ?? []);
  if (models.length === 0) {
    // Far more likely something upstream broke, so keep what we already have.
    throw new Error("GitHub Copilot returned no models");
  }
  if (startedIn !== generation) throw new Error("GitHub Copilot sign-in changed");

  applyCopilotModels(models);
  writeCachedCopilotModels(models);
  reconcileSelectedModels(models);
  return models;
}

/** Whether refreshCopilotModels would ask main rather than short-circuit. */
export function isCopilotListFresh(): boolean {
  return isCachedCopilotListFresh(readCachedCopilotModels());
}

/**
 * Pulls the signed-in plan's model list into the registry, at most once an hour
 * unless forced (sign-in, Retry). Listing models starts the Copilot runtime, so
 * a list fetched recently short-circuits. Rejects when the list can't be read,
 * leaving the registry as it was.
 */
export function refreshCopilotModels({ force = false }: { force?: boolean } = {}): Promise<
  CloudModelDefinition[]
> {
  const cached = readCachedCopilotModels();
  if (!force && isCachedCopilotListFresh(cached)) {
    applyCopilotModels(cached.models);
    reconcileSelectedModels(cached.models);
    return Promise.resolve(cached.models);
  }

  if (!inFlight) {
    inFlight = fetchAndApply(force).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Signed out: the shipped list again, and no cached list of the old account's. */
export function forgetCopilotModels(): void {
  generation += 1;
  clearCachedCopilotModels();
  resetCopilotModels();
}

/** A new sign-in: the next refresh asks main for this account's list. */
export function expireCopilotModels(): void {
  generation += 1;
  clearCachedCopilotModels();
}

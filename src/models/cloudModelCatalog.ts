import { registryData } from "./registryData.js";
import { readCachedTinfoilModels } from "./tinfoilModelCache";
import { readCachedCopilotModels } from "./copilotModelCache";
import { COPILOT_PROVIDER_ID } from "../config/copilot";
import type { CloudModelDefinition, CloudProviderData } from "./ModelRegistry";

// A leaf shared with settings startup: the provider's live discovery can retire
// models without mutating the signed catalog or importing the settings store.
const cached = readCachedTinfoilModels().models;
let tinfoilOverlay: CloudModelDefinition[] | null = cached.length ? cached : null;

// The last list this account's GitHub Copilot plan served; cleared on sign-out.
const cachedCopilot = readCachedCopilotModels().models;
let copilotOverlay: CloudModelDefinition[] | null = cachedCopilot.length ? cachedCopilot : null;

export function getCloudModelProviders(): CloudProviderData[] {
  return registryData.cloudProviders.map((provider) => {
    if (provider.id === "tinfoil" && tinfoilOverlay) return { ...provider, models: tinfoilOverlay };
    if (provider.id === COPILOT_PROVIDER_ID && copilotOverlay)
      return { ...provider, models: copilotOverlay };
    return provider;
  });
}

export function setTinfoilModelOverlay(models: CloudModelDefinition[]): void {
  tinfoilOverlay = models;
}

/** The signed-in plan's GitHub Copilot list, or null for the shipped one. */
export function setCopilotModelOverlay(models: CloudModelDefinition[] | null): void {
  copilotOverlay = models;
}

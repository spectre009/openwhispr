import {
  CUSTOM_CONNECTION_SLOTS,
  mergeConnectionModels,
  type CustomConnectionSlot,
} from "../../../config/customConnection";
import {
  cancelPendingSecretSave,
  flushPendingSecretSave,
  reloadSecretFromMain,
  useSettingsStore,
} from "../../../stores/settingsStore";
import type { ConnectionCapability } from "./connectionOptions";

/**
 * Copies the custom connection's key into a feature's key slot, the first
 * step of a pick on the connection. This window's pending save for the slot
 * is dropped first (it would land after main's copy); main writes the slot and
 * announces it, awaited; then the store reads it back, so the URL the pick
 * writes next is never paired with the slot's old key here. Throws when main
 * can't (the connection has no key, an IPC failure). The key itself never
 * passes through this code.
 */
export async function applyConnectionKey(slot: CustomConnectionSlot): Promise<void> {
  const apply = window.electronAPI?.customConnectionApplyKey;
  if (!apply) throw new Error("The custom connection is unavailable");
  const storeKey = CUSTOM_CONNECTION_SLOTS[slot];
  cancelPendingSecretSave(storeKey);
  const result = await apply({ slots: [slot] });
  if (result && result.success === false) throw new Error("The key wasn't copied");
  await reloadSecretFromMain(storeKey);
}

/**
 * Whether speech-to-text's one custom key already is the connection's. Main
 * compares and answers a boolean; a key just typed into the shared field is
 * sent first. Null when it can't be asked.
 */
export async function compareSharedSttKey(): Promise<boolean | null> {
  const compare = window.electronAPI?.customConnectionCompare;
  if (!compare) return null;
  await flushPendingSecretSave(CUSTOM_CONNECTION_SLOTS.CUSTOM_TRANSCRIPTION_API_KEY);
  const result = await compare({ slots: ["CUSTOM_TRANSCRIPTION_API_KEY"] });
  if (!result || typeof result !== "object") return null;
  return result.CUSTOM_TRANSCRIPTION_API_KEY === true;
}

/** Adds a model picked on the connection to the ones it remembers for that capability. */
export function rememberConnectionModel(model: string, capability: ConnectionCapability): void {
  const { customConnection, updateCustomConnection } = useSettingsStore.getState();
  const name = model.trim();
  if (!customConnection || !name || customConnection.models[capability].includes(name)) return;
  updateCustomConnection({
    models: mergeConnectionModels(customConnection.models, [{ name, capability }]),
  });
}

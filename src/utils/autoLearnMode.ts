import type { AutoLearnMode } from "../types/electron";

// "Learn from your corrections" (Settings › Dictation › Output), renderer
// side; main's twin is helpers/autoLearnSetting.js. Suggest (the default)
// puts learned words in the Dictionary's suggestions, Add directly adds them
// as before, Off watches nothing.

export const AUTO_LEARN_MODES: readonly AutoLearnMode[] = ["suggest", "add", "off"];

/** A stored or synced value as a mode; anything unknown reads as Suggest. */
export function normalizeAutoLearnMode(value: unknown): AutoLearnMode {
  if (value === true) return "suggest";
  if (value === false) return "off";
  return AUTO_LEARN_MODES.includes(value as AutoLearnMode) ? (value as AutoLearnMode) : "suggest";
}

/**
 * The one-time move from the on/off switch (`autoLearnCorrections`): on
 * becomes Suggest (adding directly is what filled dictionaries with junk),
 * off stays off. Runs before the settings store reads its state, and only
 * while the new key is absent; the old key stays and is no longer read.
 */
export function migrateAutoLearnMode(
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined
): void {
  if (!storage || storage.getItem("autoLearnMode") !== null) return;
  const legacy = storage.getItem("autoLearnCorrections");
  storage.setItem("autoLearnMode", legacy === "false" ? "off" : "suggest");
}

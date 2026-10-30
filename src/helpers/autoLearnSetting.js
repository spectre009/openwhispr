// Pure resolver for the "auto-learn-changed" IPC sync: Settings › Dictation ›
// Output's "Learn from your corrections" mode. "suggest" (the default) puts
// learned words in the Dictionary's suggestions; "add" adds them directly
// (how it worked before); "off" watches nothing. A boolean from an older
// window maps as the one-time migration does (true → suggest, false → off);
// anything else reads as "suggest". Reports whether the mode differs from the
// current one, so repeated same-value syncs are ignored (#1080).

const AUTO_LEARN_MODES = Object.freeze(["suggest", "add", "off"]);
const DEFAULT_AUTO_LEARN_MODE = "suggest";

function normalizeAutoLearnMode(value) {
  if (value === true) return "suggest";
  if (value === false) return "off";
  return AUTO_LEARN_MODES.includes(value) ? value : DEFAULT_AUTO_LEARN_MODE;
}

function applyAutoLearnSetting(current, incoming) {
  const mode = normalizeAutoLearnMode(incoming);
  return { changed: mode !== current, mode };
}

module.exports = {
  AUTO_LEARN_MODES,
  DEFAULT_AUTO_LEARN_MODE,
  applyAutoLearnSetting,
  normalizeAutoLearnMode,
};

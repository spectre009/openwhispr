// Shared fixtures for the settings search tests: a search context with
// everything switched on (overridable), and real i18next translators over the
// shipped locale files.
const fs = require("node:fs");
const path = require("node:path");

const LOCALES_DIR = path.join(__dirname, "..", "..", "src", "locales");
const LOCALES = ["en", "ar", "es", "fr", "de", "pt", "it", "ru", "ja", "zh-CN", "zh-TW"];

function readLocale(lang) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang, "translation.json"), "utf8"));
}

/** `t` for a UI language and `tEn`, as the app's i18n would give them. */
async function translators(lang = "en") {
  const i18next = (await import("i18next")).default;
  const instance = i18next.createInstance();
  const resources = { en: { translation: readLocale("en") } };
  if (lang !== "en") resources[lang] = { translation: readLocale(lang) };
  await instance.init({
    lng: lang,
    fallbackLng: "en",
    resources,
    interpolation: { escapeValue: false },
  });
  return { t: instance.getFixedT(lang), tEn: instance.getFixedT("en") };
}

/** A context where every setting row renders, with a few allowlisted values. */
function makeContext(overrides = {}) {
  const { on, values, localLlm, ...rest } = overrides;
  return {
    platform: "win32",
    cloudDisabled: false,
    isSignedIn: true,
    agentAllowed: true,
    screenContextAllowed: true,
    visionOverrideAllowed: true,
    isWayland: false,
    gpuCount: 1,
    hasWorkspace: true,
    canManageWorkspace: true,
    canManageMembers: true,
    on: {
      cleanup: true,
      assistant: true,
      screenContext: true,
      visionModel: true,
      translation: true,
      noteFiles: true,
      colorByMode: true,
      autoLanguage: true,
      localWhisper: true,
      transcriptionPreview: true,
      ...on,
    },
    localLlm: { dictationCleanup: true, ...localLlm },
    values: {
      "llm.dictationCleanup": {
        display: "Anthropic · Claude Haiku 4.5",
        terms: ["anthropic", "claude-haiku-4-5", "providers"],
      },
      "llm.chatIntelligence": { display: "OpenAI · GPT-5.2", terms: ["openai", "gpt-5.2"] },
      "stt.dictation": {
        display: "Groq · Whisper Large v3 Turbo",
        terms: ["groq", "whisper-large-v3-turbo"],
      },
      "hotkey.dictation": { display: "F8", terms: ["F8"] },
      "hotkey.translation": { display: "Ctrl+Alt+T", terms: ["Control+Alt+T"] },
      activationMode: { display: "Hold", terms: ["push", "hold"] },
      theme: { display: "Dark", terms: ["dark"] },
      ...values,
    },
    interpolation: { agentName: "Jarvis", hotkey: "F8", max: 5 },
    ...rest,
  };
}

module.exports = { LOCALES, readLocale, translators, makeContext };

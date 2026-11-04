const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Whether a recording's start prewarms the Copilot runtime, read through the
// real settings and policy stores with the resolvers the pipeline routes with.

const STYLE = Object.freeze({ id: "starter-teams", name: "Teams chat", runMode: "two-step" });

const COPILOT_CLEANUP = {
  useCleanupModel: true,
  cleanupMode: "providers",
  cleanupProvider: "copilot",
  cleanupModel: "claude-haiku-5.5",
};
const OPENAI_CLEANUP = {
  useCleanupModel: true,
  cleanupMode: "providers",
  cleanupProvider: "openai",
  cleanupModel: "gpt-5-mini",
};
const NO_TRANSLATION = {
  useDictationTranslation: false,
  translationMode: "providers",
  translationProvider: "openai",
  translationModel: "gpt-5-mini",
  translationTargetLanguage: "",
};
const COPILOT_TRANSLATION = {
  useDictationTranslation: true,
  translationMode: "providers",
  translationProvider: "copilot",
  translationModel: "claude-haiku-5.5",
  translationTargetLanguage: "fr",
};
const OPENAI_TRANSLATION = { ...COPILOT_TRANSLATION, translationProvider: "openai" };

test("a recording prewarms Copilot only when its model step can run there", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-copilot-prewarm-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
    },
  });
  const audioManagerModule = await vite.ssrLoadModule("/helpers/audioManager.js");
  const AudioManager = audioManagerModule.default;
  const { copilotPrewarmWanted } = audioManagerModule;
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore, getSettings } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });

  const cases = [
    ["cleanup on, on Copilot", { ...COPILOT_CLEANUP, ...NO_TRANSLATION }, {}, true],
    [
      "cleanup off, on Copilot, no style",
      { ...COPILOT_CLEANUP, useCleanupModel: false, ...NO_TRANSLATION },
      {},
      false,
    ],
    [
      "cleanup off, on Copilot, with a style",
      { ...COPILOT_CLEANUP, useCleanupModel: false, ...NO_TRANSLATION },
      { style: STYLE },
      true,
    ],
    ["cleanup on another provider", { ...OPENAI_CLEANUP, ...NO_TRANSLATION }, {}, false],
    [
      "a style on another provider",
      { ...OPENAI_CLEANUP, ...NO_TRANSLATION },
      { style: STYLE },
      false,
    ],
    [
      "Copilot left in a local cleanup slot",
      { ...COPILOT_CLEANUP, cleanupMode: "local", ...NO_TRANSLATION },
      {},
      false,
    ],
    [
      "Copilot with no model picked",
      { ...COPILOT_CLEANUP, cleanupModel: "", ...NO_TRANSLATION },
      {},
      false,
    ],
    [
      "a voice assistant recording",
      { ...COPILOT_CLEANUP, ...COPILOT_TRANSLATION },
      { voiceAgentRequested: true },
      false,
    ],
    [
      "translation on Copilot",
      { ...OPENAI_CLEANUP, ...COPILOT_TRANSLATION },
      { translationRequested: true },
      true,
    ],
    [
      "translation elsewhere, the chain's cleanup on Copilot",
      { ...COPILOT_CLEANUP, ...OPENAI_TRANSLATION },
      { translationRequested: true },
      true,
    ],
    [
      "translation elsewhere, cleanup on Copilot but off",
      { ...COPILOT_CLEANUP, useCleanupModel: false, ...OPENAI_TRANSLATION },
      { translationRequested: true },
      false,
    ],
    [
      "translation on Copilot but unreachable (no target)",
      { ...OPENAI_CLEANUP, ...COPILOT_TRANSLATION, translationTargetLanguage: "" },
      { translationRequested: true },
      false,
    ],
    [
      "a translation recording carries no style",
      { ...COPILOT_CLEANUP, useCleanupModel: false, ...OPENAI_TRANSLATION },
      { translationRequested: true, style: STYLE },
      false,
    ],
  ];

  let prewarms = 0;
  window.electronAPI.prewarmCopilot = async () => {
    prewarms += 1;
  };
  const manager = Object.create(AudioManager.prototype);
  for (const [name, settings, options, expected] of cases) {
    useSettingsStore.setState(settings);
    assert.equal(copilotPrewarmWanted(getSettings(), options), expected, name);
    const before = prewarms;
    assert.equal(manager.beginCopilotPrewarm(options), expected, name);
    assert.equal(prewarms - before, expected ? 1 : 0, name);
  }

  // Fire and forget: a failing or missing bridge never throws into the start.
  useSettingsStore.setState({ ...COPILOT_CLEANUP, ...NO_TRANSLATION });
  window.electronAPI.prewarmCopilot = () => Promise.reject(new Error("no main"));
  assert.equal(manager.beginCopilotPrewarm({}), true);
  window.electronAPI.prewarmCopilot = () => {
    throw new Error("bridge gone");
  };
  assert.equal(manager.beginCopilotPrewarm({}), false);
  delete window.electronAPI.prewarmCopilot;
  assert.equal(manager.beginCopilotPrewarm({}), false);
  await new Promise((resolve) => setImmediate(resolve));
});

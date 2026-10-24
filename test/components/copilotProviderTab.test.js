const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// GitHub Copilot is offered where Copilot can answer — cleanup, note
// formatting, translation — and listed unavailable, with the reason, where it
// can't: chat, the voice assistant and its vision override, which run tools
// Copilot's runtime can't join. Nowhere can it be picked there.

const PROVIDERS_MODE = {
  _llmScopeKeysMigrated: "1",
  _dictationAgentSeeded: "1",
  cleanupMode: "providers",
  noteFormattingMode: "providers",
  translationMode: "providers",
  chatAgentMode: "providers",
  dictationAgentMode: "providers",
  dictationAgentVisionMode: "providers",
};

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };

test("Copilot is pickable only on the scopes Copilot can serve", async (t) => {
  installBrowserGlobals(t, { initialStorage: PROVIDERS_MODE });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-copilot-tab-test-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const { buildModelPickerOptions, pickAvailability } = await vite.ssrLoadModule(
    "/components/settings/modelPicker/options.ts"
  );
  const { default: InferenceConfigEditor } = await vite.ssrLoadModule(
    "/components/settings/InferenceConfigEditor.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");

  const context = (scope) => ({
    policy: UNMANAGED,
    cloudDisabled: false,
    isSignedIn: true,
    allowedModes: scope === "dictationAgentVision" ? ["providers"] : undefined,
    keys: { anthropic: true },
    copilot: {
      signedIn: true,
      login: "octocat",
      models: [{ id: "claude-haiku-5.5", name: "Claude Haiku 5.5" }],
    },
    localModels: [],
    current: { mode: "providers", provider: "", model: "" },
  });
  const copilotOptions = (scope) =>
    buildModelPickerOptions(scope, context(scope)).find((group) => group.id === "copilot")
      ?.options ?? [];
  const pick = { mode: "providers", provider: "copilot", model: "claude-haiku-5.5" };

  for (const scope of ["dictationCleanup", "noteFormatting", "dictationTranslation"]) {
    const options = copilotOptions(scope);
    assert.deepEqual(
      options.map((option) => [option.id, option.available]),
      [["copilot:claude-haiku-5.5", true]],
      `${scope} offers Copilot's models`
    );
    assert.equal(pickAvailability(scope, pick, context(scope)), true);
  }
  for (const scope of ["chatIntelligence", "dictationAgent", "dictationAgentVision"]) {
    const options = copilotOptions(scope);
    assert.deepEqual(
      options.map((option) => [option.id, option.available]),
      [["copilot:unsupported", { reasonKey: "modelPicker.reasons.copilotScope" }]],
      `${scope} lists Copilot as unavailable, with the reason`
    );
    assert.deepEqual(pickAvailability(scope, pick, context(scope)), {
      reasonKey: "modelPicker.reasons.copilotScope",
    });
    assert.equal(
      i18n.t("modelPicker.reasons.copilotScope"),
      "Copilot serves Cleanup, Styles, Translation and Note Formatting only"
    );
  }

  // Every scope's editor renders its picker.
  for (const scope of [
    "dictationCleanup",
    "noteFormatting",
    "dictationTranslation",
    "chatIntelligence",
    "dictationAgent",
    "dictationAgentVision",
  ]) {
    const markup = renderToStaticMarkup(
      React.createElement(InferenceConfigEditor, {
        scope,
        allowedModes: scope === "dictationAgentVision" ? ["providers"] : undefined,
      })
    );
    assert.ok(markup.includes(">Model<"), `${scope}: the picker's label`);
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The GitHub Copilot tab is offered where Copilot can answer — cleanup, note
// formatting, translation — and nowhere it can't: chat, the voice assistant
// and its vision override, which run tools Copilot's runtime can't join.

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

test("the Copilot tab shows only on the scopes Copilot can serve", async (t) => {
  installBrowserGlobals(t, { initialStorage: PROVIDERS_MODE });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-copilot-tab-test-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { default: InferenceConfigEditor } = await vite.ssrLoadModule(
    "/components/settings/InferenceConfigEditor.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");

  const render = (scope) =>
    renderToStaticMarkup(
      React.createElement(InferenceConfigEditor, { scope, allowedModes: ["providers"] })
    );
  const copilotTab = ">GitHub Copilot<";

  for (const scope of ["dictationCleanup", "noteFormatting", "dictationTranslation"]) {
    const markup = render(scope);
    assert.ok(markup.includes(">Anthropic<"), `${scope}: the provider tabs rendered`);
    assert.ok(markup.includes(copilotTab), `${scope} offers GitHub Copilot`);
  }
  for (const scope of ["chatIntelligence", "dictationAgent", "dictationAgentVision"]) {
    const markup = render(scope);
    assert.ok(markup.includes(">Anthropic<"), `${scope}: the provider tabs rendered`);
    assert.ok(!markup.includes(copilotTab), `${scope} hides GitHub Copilot`);
  }
});

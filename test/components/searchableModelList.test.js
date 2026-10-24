const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");

// The searchable model list (OpenRouter's catalog under a feature's model
// picker, large custom endpoints, Bedrock) grows with the page instead of
// scrolling inside a capped box: it shows a page of models, the selection
// pinned first, and "Show more" with what's left.

test("the model list shows a page of models and Show more, with no inner scroller", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-searchable-list-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { default: SearchableModelList, MODEL_LIST_PAGE_SIZE } = await vite.ssrLoadModule(
    "/components/ui/SearchableModelList.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");

  const models = Array.from({ length: 60 }, (_, index) => ({
    value: `vendor${index % 3}/model-${String(index).padStart(2, "0")}`,
    label: `model-${String(index).padStart(2, "0")}`,
  }));
  const markup = renderToStaticMarkup(
    React.createElement(SearchableModelList, {
      models,
      selectedModel: "vendor2/model-59",
      onModelSelect: () => {},
    })
  );
  const options = markup.match(/role="option"/g) ?? [];
  assert.equal(options.length, MODEL_LIST_PAGE_SIZE, "one page of models");
  assert.ok(markup.includes("vendor2/model-59"), "the selection is pinned first");
  assert.ok(markup.includes(`Show more (${60 - MODEL_LIST_PAGE_SIZE})`));
  assert.ok(!/overflow-y-auto|max-h-/.test(markup), "no capped inner scroller");

  const short = renderToStaticMarkup(
    React.createElement(SearchableModelList, {
      models: models.slice(0, 10),
      selectedModel: "",
      onModelSelect: () => {},
    })
  );
  assert.equal((short.match(/role="option"/g) ?? []).length, 10);
  assert.ok(!short.includes("Show more"));
});

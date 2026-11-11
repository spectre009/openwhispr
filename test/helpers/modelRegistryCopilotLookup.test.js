const test = require("node:test");
const assert = require("node:assert/strict");

// The catalog the app reads: the signed registry's plus the fork's providers
// (forkCatalogProviders.js), retired models left out.
const { registryData: modelRegistryData } = require("../../src/models/registryData.js");

const load = () => import("../../src/models/ModelRegistry.ts");

// GitHub Copilot's live catalog serves ids OpenAI and Anthropic list too
// (measured: gpt-6-astra, gpt-5.6-sol/terra/luna, claude-sonnet-5) with
// different capabilities, so a lookup that names its provider must stay on it.
const COLLIDING = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "claude-sonnet-5",
];

const copilotLiveList = () =>
  COLLIDING.map((id) => ({
    id,
    name: `Copilot ${id}`,
    description: "Available on your GitHub Copilot plan",
    supportsThinking: true,
  }));

// Snapshot before any test swaps Copilot's list in.
const registryEntries = Object.fromEntries(
  modelRegistryData.cloudProviders.map((provider) => [
    provider.id,
    provider.models.map((model) => ({ ...model })),
  ])
);

test("a provider-scoped lookup never crosses into another provider's colliding id", async () => {
  const { applyCopilotModels, getCloudModel } = await load();
  applyCopilotModels(copilotLiveList());

  for (const id of COLLIDING) {
    const copilot = getCloudModel(id, "copilot");
    assert.equal(copilot?.name, `Copilot ${id}`, `${id} under copilot is Copilot's own entry`);
    assert.equal(copilot?.supportsVision, undefined, `${id} under copilot claims no vision`);
  }
  assert.equal(getCloudModel("gpt-6-astra", "openai")?.supportsVision, true);
  assert.equal(getCloudModel("claude-sonnet-5", "anthropic")?.name, "Claude Sonnet 5");
  // An id Copilot doesn't serve isn't borrowed from another provider.
  assert.equal(getCloudModel("gpt-5.2", "copilot"), undefined);
  assert.equal(getCloudModel("claude-haiku-5.5", "anthropic"), undefined);
});

test("every existing provider resolves its own ids exactly as the catalog-wide lookup did", async () => {
  const { applyCopilotModels, getCloudModel } = await load();
  applyCopilotModels(copilotLiveList());

  for (const [providerId, models] of Object.entries(registryEntries)) {
    if (providerId === "copilot") continue;
    for (const model of models) {
      assert.deepEqual(getCloudModel(model.id, providerId), model, `${providerId}/${model.id}`);
      // Copilot sits last in the registry, so an unscoped lookup still finds
      // the original provider's entry for a colliding id.
      assert.deepEqual(getCloudModel(model.id), model, `unscoped ${model.id}`);
    }
  }
});

test("request shapes for OpenAI, OpenRouter and custom endpoints are unchanged", async () => {
  const { applyCopilotModels, getOpenAiApiConfig } = await load();
  applyCopilotModels(copilotLiveList());

  for (const model of registryEntries.openai) {
    const expected = model.tokenParam
      ? { tokenParam: model.tokenParam, supportsTemperature: model.supportsTemperature ?? true }
      : getOpenAiApiConfig(model.id);
    assert.deepEqual(getOpenAiApiConfig(model.id, "openai"), expected, model.id);
  }
  // OpenRouter's vendor-prefixed ids keep Chat Completions' max_tokens.
  assert.deepEqual(getOpenAiApiConfig("openai/gpt-6-astra", "openrouter"), {
    tokenParam: "max_tokens",
    supportsTemperature: false,
  });
  // Free-form custom ids keep the catalog-wide lookup.
  assert.deepEqual(getOpenAiApiConfig("gpt-6-astra", "custom"), {
    tokenParam: "max_completion_tokens",
    supportsTemperature: false,
  });
});

test("the shipped Copilot list comes back on reset", async () => {
  const { applyCopilotModels, resetCopilotModels, getCopilotModels, REASONING_PROVIDERS } =
    await load();
  applyCopilotModels(copilotLiveList());
  assert.deepEqual(
    REASONING_PROVIDERS.copilot.models.map((model) => model.value),
    COLLIDING
  );

  resetCopilotModels();
  assert.deepEqual(
    getCopilotModels().map((model) => model.id),
    ["claude-haiku-5.5", "mai-code-2-flash", "gpt-6-luna", "claude-sonnet-5.5"]
  );
  assert.equal(REASONING_PROVIDERS.copilot.name, "GitHub Copilot");
});

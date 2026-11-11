const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const { signEnvelope } = require("../../src/models/registryEnvelope.cjs");
const { acceptCatalog } = require("../../src/models/registrySchema.cjs");
const { createRegistryLoader } = require("../../src/helpers/registryLoader");
const store = require("../../src/models/registryData.js");
const { withForkProviders } = require("../../src/models/forkCatalogProviders.js");
const vendored = require("../../src/models/modelRegistryData.json");

const { bundledRegistryData: bundled } = store;
const copilot = (catalog) => catalog.cloudProviders.find((p) => p.id === "copilot");
const azureSpeech = (catalog) =>
  catalog.transcriptionProviders.find((p) => p.id === "azure-speech");
const ids = (provider) => provider.models.map((model) => model.id);

const pair = generateKeyPairSync("ed25519");
const trustedKeys = { fixture: pair.publicKey.export({ type: "spki", format: "pem" }) };
const CLIENT = "c".repeat(64);

function signed(version, data) {
  return JSON.stringify(
    signEnvelope(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          manifestVersion: version,
          publishedAt: "2026-11-11T12:00:00Z",
          sourceCommit: "a".repeat(40),
          contractHashes: {
            schema: "a".repeat(64),
            envelope: "b".repeat(64),
            selection: "c".repeat(64),
          },
          testedClientContracts: [CLIENT],
          data,
        })
      ),
      "fixture",
      pair.privateKey
    )
  );
}

test("the signed catalog lists neither fork provider, so the bundle adds both", () => {
  assert.equal(copilot(vendored), undefined, "sync the catalog, then drop the fork's entry");
  assert.equal(azureSpeech(vendored), undefined, "sync the catalog, then drop the fork's entry");
  assert.deepEqual(ids(copilot(bundled)), [
    "claude-haiku-5.5",
    "mai-code-2-flash",
    "gpt-6-luna",
    "claude-sonnet-5.5",
  ]);
  assert.equal(copilot(bundled).defaultModel, "claude-haiku-5.5");
  assert.deepEqual(ids(azureSpeech(bundled)), ["MAI-Transcribe-2"]);
  // Copilot serves ids other providers list too: an unscoped lookup must find theirs first.
  assert.equal(bundled.cloudProviders.at(-1).id, "copilot");
});

test("both fork providers survive a live catalog that does not list them", () => {
  const applied = acceptCatalog(vendored, bundled, "1.11.1");
  assert.deepEqual(ids(copilot(applied)), ids(copilot(bundled)));
  assert.equal(copilot(applied).defaultModel, "claude-haiku-5.5");
  assert.equal(copilot(applied).models[0].supportsThinking, true);
  assert.deepEqual(ids(azureSpeech(applied)), ["MAI-Transcribe-2"]);
  assert.equal(
    azureSpeech(applied).models[0].descriptionKey,
    "models.descriptions.transcription.azure_speech_mai_transcribe_2"
  );
});

test("a catalog that lists a fork provider keeps its own entry", () => {
  const listed = {
    ...vendored,
    cloudProviders: [
      ...vendored.cloudProviders,
      { id: "copilot", name: "GitHub Copilot", models: [] },
    ],
  };
  const merged = withForkProviders(listed);
  assert.equal(merged.cloudProviders.filter((p) => p.id === "copilot").length, 1);
  assert.deepEqual(copilot(merged).models, []);
  assert.ok(azureSpeech(merged));
});

test("a signed publication applied through main's loader keeps Copilot and Azure Speech listed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-catalog-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const models = await import("../../src/models/ModelRegistry.ts");
  const live = [{ id: "live-copilot", name: "Live", description: "Live", supportsThinking: true }];
  models.applyCopilotModels(live);
  t.after(() => models.resetCopilotModels());

  const base = store.getRegistryVersion() + 1;
  const loader = createRegistryLoader({
    cachePath: path.join(dir, "registry.json"),
    bundledSnapshot: { data: bundled, manifestVersion: base },
    clientContract: CLIENT,
    trustedKeys,
    appVersion: "1.12.0",
    applySnapshot: (snapshot) => store.replaceRegistryData(snapshot),
    isEnabled: () => true,
    startupDelayMs: 60000,
    fetch: async () => new Response(signed(base + 1, vendored)),
  });
  t.after(() => loader.stop());
  await loader.start();
  await loader.refresh();

  assert.equal(store.getRegistryVersion(), base + 1, "the publication was applied");
  const data = store.getRegistryData();
  assert.deepEqual(ids(copilot(data)), ids(copilot(bundled)));
  assert.deepEqual(ids(azureSpeech(data)), ["MAI-Transcribe-2"]);
  assert.ok(data.transcriptionProviders.some((p) => p.id === "openrouter"));

  assert.ok(models.modelRegistry.getTranscriptionProviders().some((p) => p.id === "azure-speech"));
  // The signed-in plan's list stays in front of the catalog through the replacement.
  assert.deepEqual(
    models.getCopilotModels().map((m) => m.id),
    ["live-copilot"]
  );
  assert.deepEqual(
    models.REASONING_PROVIDERS.copilot.models.map((m) => m.value),
    ["live-copilot"]
  );
  assert.equal(models.getCloudModel("live-copilot", "copilot")?.name, "Live");

  models.resetCopilotModels();
  assert.deepEqual(
    models.getCopilotModels().map((m) => m.id),
    ids(copilot(bundled))
  );
  assert.deepEqual(
    models.REASONING_PROVIDERS.copilot.models.map((m) => m.value),
    ids(copilot(bundled))
  );
});

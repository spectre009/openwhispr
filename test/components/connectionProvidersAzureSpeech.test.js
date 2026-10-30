const test = require("node:test");
const assert = require("node:assert/strict");

// Azure Speech on AI Connections: one connection holding a key (a secret) and
// the resource endpoint (a plain setting), connected only with both and a
// valid endpoint. Its anchor is camelCase like every other one.

async function load() {
  const mod = await import("../../src/components/settings/connectionProviders.ts");
  return mod.default ?? mod;
}

const ORIGIN = "https://res.cognitiveservices.azure.com";

test("Azure Speech is a speech-to-text connection with an endpoint beside its key", async () => {
  const { findConnectionProvider, connectionAnchor, connectionDestination } = await load();
  const azure = findConnectionProvider("azure-speech");
  assert.equal(azure.name, "Azure Speech");
  assert.equal(azure.llm, false);
  assert.equal(azure.transcription, true);
  assert.equal(azure.common, false, "folded on a first run, like the other speech-only providers");
  assert.deepEqual(
    azure.credentials.map(({ key, setter, serves }) => ({ key, setter, serves })),
    [{ key: "azureSpeechApiKey", setter: "setAzureSpeechApiKey", serves: "transcription" }]
  );
  assert.equal(azure.endpoint.key, "azureSpeechEndpoint");
  assert.equal(azure.endpoint.setter, "setAzureSpeechEndpoint");
  assert.equal(connectionAnchor("azure-speech"), "connections.azureSpeech");
  assert.equal(connectionDestination("azure-speech"), "connections#connections.azureSpeech");
  assert.equal(connectionAnchor("openai"), "connections.openai", "other anchors are unchanged");
});

test("connected only with a key and a valid endpoint; either one is something to keep", async () => {
  const { findConnectionProvider, isConnectionReady, hasSavedConnection, hasSavedCredential } =
    await load();
  const azure = findConnectionProvider("azure-speech");
  const state = (azureSpeechApiKey, azureSpeechEndpoint) => ({
    azureSpeechApiKey,
    azureSpeechEndpoint,
  });
  assert.equal(isConnectionReady(azure, state("k", ORIGIN)), true);
  assert.equal(isConnectionReady(azure, state("k", "")), false);
  assert.equal(isConnectionReady(azure, state("k", "https://res.openai.azure.com")), false);
  assert.equal(isConnectionReady(azure, state("", ORIGIN)), false);
  assert.equal(hasSavedConnection(azure, state("", ORIGIN)), true, "an endpoint alone is saved");
  assert.equal(hasSavedConnection(azure, state("k", "")), true);
  assert.equal(hasSavedConnection(azure, state(" ", " ")), false);
  assert.equal(hasSavedCredential(azure, state("", ORIGIN)), false, "a credential is the key");

  // A provider without an endpoint is ready with its key, as before.
  const openai = findConnectionProvider("openai");
  assert.equal(isConnectionReady(openai, { openaiApiKey: "sk" }), true);
  assert.equal(hasSavedConnection(openai, { openaiApiKey: "" }), false);
});

test("the endpoint field says why an endpoint can't be used, and tidies it on blur", async () => {
  const { findConnectionProvider } = await load();
  const { endpoint } = findConnectionProvider("azure-speech");
  assert.equal(endpoint.validate(ORIGIN), null);
  assert.equal(endpoint.validate("http://res.cognitiveservices.azure.com"), "httpsRequired");
  assert.equal(endpoint.validate("https://res.openai.azure.com"), "host");
  assert.equal(endpoint.validate(`${ORIGIN}/speechtotext`), "resourceOnly");
  assert.equal(endpoint.normalize("res.cognitiveservices.azure.com/"), ORIGIN);

  const en = require("../../src/locales/en/translation.json");
  const get = (key) => key.split(".").reduce((node, part) => node?.[part], en);
  assert.equal(typeof get(endpoint.labelKey), "string");
  assert.equal(
    get(endpoint.helpKey),
    "Paste the endpoint and a key from your Speech resource's Keys and Endpoint page."
  );
  // Every reason the field can show (an empty field shows none) has its sentence.
  for (const reason of ["invalidUrl", "httpsRequired", "host", "resourceOnly"]) {
    assert.equal(typeof get(`${endpoint.errorKeyPrefix}.${reason}`), "string", reason);
  }
});

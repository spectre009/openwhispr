const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");

// Upstream's TranscriptionModelPicker checked provider credentials as they were typed (#2652).
// The fork replaced that picker with the speech-to-text model picker
// (settings/TranscriptionConfigEditor.tsx), whose provider keys live on AI Connections and are
// checked there (settings/connectionHealth.ts, tested in connectionHealth*.test.js). What the
// picker still holds itself is the custom endpoint's fields, which check themselves as
// upstream's Custom tab did: these tests are that tab's, run on SttCustomEndpointFields.

const FIELDS = "/components/settings/SttCustomEndpointFields.tsx";
const SRC = path.join(__dirname, "..", "..", "src", "components", "settings");
const ENDPOINT = "transcription.endpointUrl";
const MODEL = "common.model";
const REJECTED = { success: false, errorCode: "credentialsRejected", status: 401 };
const custom = (overrides = {}) => ({
  cloudTranscriptionProvider: "custom",
  cloudTranscriptionModel: "whisper-1",
  cloudTranscriptionBaseUrl: "http://127.0.0.1:8000/v1",
  customTranscriptionApiKey: "",
  ...overrides,
});
const props = (overrides = {}) => ({
  surface: "dictation",
  inheritedUrl: "",
  inheritedModel: "",
  onModel() {},
  ...overrides,
});
const mount = (t, { overrides, store, ...options } = {}) =>
  mountSettingsPanel(t, {
    module: FIELDS,
    props: props(overrides),
    secrets: custom(store),
    ...options,
  });

test("provider keys are checked on AI Connections; the picker checks only its custom endpoint", () => {
  const editor = fs.readFileSync(path.join(SRC, "TranscriptionConfigEditor.tsx"), "utf8");
  assert.doesNotMatch(editor, /useConnectionAutoCheck|ProviderCheckField|ApiKeyInput/);
  assert.match(editor, /<SttCustomEndpointFields\b/);
  const fields = fs.readFileSync(path.join(SRC, "SttCustomEndpointFields.tsx"), "utf8");
  // The one key every speech-to-text custom endpoint shares is replaced, never shown.
  assert.match(fields, /<ApiKeyInput[^>]*\breplace\b/s);
  assert.doesNotMatch(fields, /type="password"/);
});

test("Custom: a saved endpoint is checked once shown, with its model", async (t) => {
  const panel = await mount(t);
  await panel.wait(0);
  assert.deepEqual(panel.requests(), [
    {
      scope: "transcription",
      provider: "custom",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "",
      model: "whisper-1",
    },
  ]);
  await panel.answer({ success: true });
  assert.equal(panel.phase(), "connected");
  assert.equal(panel.announcement(), "connected");
});

test("Custom: the model holds the status, and the address waits until it is left", async (t) => {
  const panel = await mount(t, { store: { cloudTranscriptionBaseUrl: "" } });
  assert.ok(panel.field(MODEL).props.check);
  assert.equal(
    panel.field(MODEL).props.invalidOn,
    "modelNotFound",
    "a missing model is the model's fault"
  );
  assert.equal(panel.field(ENDPOINT).props.check, undefined);
  await panel.focus(ENDPOINT);
  for (const url of ["http://127.0.0.1", "http://127.0.0.1:8000/v1"]) {
    await panel.type(ENDPOINT, url);
    await panel.wait(2000);
  }
  assert.equal(panel.state().cloudTranscriptionBaseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(panel.requests().length, 0);
  assert.equal(panel.phase(), "idle");
  await panel.blur(ENDPOINT, { windowSwitch: true });
  await panel.wait(2000);
  assert.equal(panel.requests().length, 0, "switching apps keeps the hold");
  await panel.blur(ENDPOINT);
  assert.equal(panel.phase(), "waiting");
  await panel.wait(0); // leaving the fields checks at once
  assert.deepEqual(panel.requests(), [
    {
      scope: "transcription",
      provider: "custom",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "",
      model: "whisper-1",
    },
  ]);
  await panel.answer(REJECTED);
  assert.equal(panel.field(MODEL).props.failureReason, "reasoning.custom.endpointUnauthorized");
  await panel.setStore({ customTranscriptionApiKey: "sk-server" });
  await panel.wait(0);
  await panel.answer(REJECTED);
  assert.equal(panel.field(MODEL).props.failureReason, undefined, "with a key, a rejection");
});

test("Custom: an Azure endpoint is not checked, any other address is", async (t) => {
  const panel = await mount(t, {
    store: {
      cloudTranscriptionModel: "whisper-deployment",
      cloudTranscriptionBaseUrl: "https://my-resource.cognitiveservices.azure.com",
    },
  });
  await panel.wait(5000);
  assert.equal(panel.requests().length, 0, "Azure takes its own URL and api-key header");
  assert.equal(panel.phase(), "idle");
  await panel.setStore({ cloudTranscriptionBaseUrl: "http://127.0.0.1:8000/v1" });
  await panel.wait(500);
  assert.deepEqual(
    panel.requests().map((config) => config.baseUrl),
    ["http://127.0.0.1:8000/v1"]
  );
});

test("leaving an address that is tidied on blur checks at once", async (t) => {
  const panel = await mount(t, {
    store: { cloudTranscriptionBaseUrl: "http://127.0.0.1:8080/v1/" },
  });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.focus(ENDPOINT);
  await panel.blur(ENDPOINT); // the hold drops and the address is saved without its slash
  assert.equal(panel.state().cloudTranscriptionBaseUrl, "http://127.0.0.1:8080/v1");
  await panel.wait(0);
  assert.deepEqual(
    panel.requests().map((config) => config.baseUrl),
    ["http://127.0.0.1:8080/v1/", "http://127.0.0.1:8080/v1"],
    "leaving the address checks it at once"
  );
});

test("typing the model keeps the pause; nothing goes out half typed", async (t) => {
  const committed = [];
  const panel = await mount(t, { overrides: { onModel: (model) => committed.push(model) } });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(MODEL, "whisper-2");
  // The model commits through the picker's selection adapter, which writes the store.
  assert.deepEqual(committed, ["whisper-2"]);
  await panel.setStore({ cloudTranscriptionModel: "whisper-2" });
  await panel.wait(499);
  assert.equal(panel.requests().length, 1, "nothing before the pause ends");
  await panel.wait(1);
  assert.deepEqual(
    panel.requests().map((config) => config.model),
    ["whisper-1", "whisper-2"]
  );
});

test("File Transcription checks the endpoint it borrows from Recognition", async (t) => {
  const panel = await mount(t, {
    overrides: {
      surface: "fileTranscription",
      inheritedUrl: "http://127.0.0.1:8000/v1",
      inheritedModel: "whisper-1",
    },
    store: {
      uploadCloudTranscriptionProvider: "",
      uploadCloudTranscriptionModel: "",
      uploadCloudTranscriptionBaseUrl: "",
    },
  });
  await panel.wait(0);
  assert.deepEqual(
    panel.requests().map((config) => [config.baseUrl, config.model]),
    [["http://127.0.0.1:8000/v1", "whisper-1"]]
  );
});

test("an endpoint only browsed, with no model yet, sends nothing", async (t) => {
  const panel = await mount(t, {
    store: { cloudTranscriptionProvider: "openai", cloudTranscriptionModel: "whisper-1" },
  });
  await panel.wait(5000);
  assert.equal(panel.requests().length, 0, "a model is needed before anything is checked");
});

test("a hidden page sends nothing until it is shown, then asks again", async (t) => {
  const panel = await mount(t, { visible: false });
  await panel.wait(5000);
  assert.equal(panel.requests().length, 0);
  await panel.setVisible(true);
  await panel.wait(0);
  assert.equal(panel.requests().length, 1);
  await panel.answer({ success: true });
  await panel.setVisible(false);
  await panel.setVisible(true);
  await panel.wait(0);
  assert.equal(panel.requests().length, 2, "a shown page asks again");
});

// Upstream's local tabs filtered by the organization's allow list (#3056). This picker lists
// downloaded models only; the same rules are tested on its options in
// modelPickerSttOptions.test.js ("an organization's local model allow list").

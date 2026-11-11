const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function renderer(t) {
  installBrowserGlobals(t, {
    window: { location: { search: "" }, electronAPI: { getPlatform: () => "darwin" } },
  });
  return createRendererServer(t, {
    cachePrefix: "openwhispr-oruk-organization-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `export function useTranslation() { return {t(key) {return key;}}; }`,
    },
  });
}

// The speech-to-text pickers list downloaded local models under their
// organization: Orukeet (Oruk) and stock Parakeet (NVIDIA) both run as the
// "nvidia" local provider, and a saved choice shows as itself, not the other.
const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };
const SHERPA = [
  { id: "orukeet-v0.1.0", engine: "sherpa" },
  { id: "parakeet-tdt-0.6b-v3", engine: "sherpa" },
];
const localContext = (localModel, overrides = {}) => ({
  policy: UNMANAGED,
  cloudDisabled: false,
  isSignedIn: true,
  keys: {},
  localModels: SHERPA,
  current: {
    mode: "local",
    cloudProvider: "openai",
    cloudModel: "gpt-transcribe",
    cloudBaseUrl: "",
    localProvider: "nvidia",
    localModel,
    remoteUrl: "",
    remoteModel: "",
  },
  ...overrides,
});
const localOptions = (groups) => groups.find((group) => group.id === "local").options;

test("all three model pickers show the persisted Orukeet choice under Oruk", async (t) => {
  const vite = await renderer(t);
  const stt = await vite.ssrLoadModule("/components/settings/modelPicker/sttOptions.ts");
  for (const surface of ["dictation", "fileTranscription", "liveRecording"]) {
    const ctx = localContext("orukeet-v0.1.0");
    const options = localOptions(stt.buildSttPickerOptions(surface, ctx));
    const oruk = options.find((option) => option.id === "local:orukeet-v0.1.0");
    assert.equal(oruk.icon, "oruk", surface);
    assert.equal(oruk.provider, "nvidia", surface);
    assert.equal(oruk.label.text, "Orukeet", surface);
    assert.match(oruk.sub.text, /^Oruk/, surface);
    assert.equal(stt.selectedSttOptionId(ctx.current), "local:orukeet-v0.1.0", surface);
    const summary = stt.describeSttSelection(surface, ctx);
    assert.equal(summary.icon, "oruk", surface);
    assert.equal(summary.title.text, "Orukeet", surface);
    // Oruk leads the local list, as its tab led the organizations.
    assert.equal(options[0].id, "local:orukeet-v0.1.0", surface);
  }
});

test("a saved stock Parakeet choice shows under NVIDIA, with Orukeet still selectable", async (t) => {
  const vite = await renderer(t);
  const stt = await vite.ssrLoadModule("/components/settings/modelPicker/sttOptions.ts");
  const ctx = localContext("parakeet-tdt-0.6b-v3");
  const options = localOptions(stt.buildSttPickerOptions("dictation", ctx));
  const parakeet = options.find((option) => option.id === "local:parakeet-tdt-0.6b-v3");
  assert.equal(parakeet.icon, "nvidia");
  assert.equal(parakeet.label.text, "Parakeet TDT 0.6B");
  assert.equal(stt.selectedSttOptionId(ctx.current), "local:parakeet-tdt-0.6b-v3");
  assert.equal(stt.describeSttSelection("dictation", ctx).icon, "nvidia");
  assert.equal(options.find((option) => option.id === "local:orukeet-v0.1.0").available, true);
});
test("adding Orukeet preserves fresh-install transcription modes and existing backend defaults", async (t) => {
  const vite = await renderer(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  for (const prefix of ["", "meeting", "upload"]) {
    const key = (name) => (prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name);
    assert.equal(state[key("useLocalWhisper")], false);
    assert.equal(state[key("localTranscriptionProvider")], "whisper");
    assert.equal(state[key("parakeetModel")], "");
  }
});

test("on a macOS sherpa-onnx can't run, Oruk and NVIDIA models are listed unavailable", async (t) => {
  const vite = await renderer(t);
  const stt = await vite.ssrLoadModule("/components/settings/modelPicker/sttOptions.ts");
  const ctx = localContext("orukeet-v0.1.0", {
    localModels: [...SHERPA, { id: "base", engine: "whisper" }],
    sherpa: { supported: false, minimumMacOSVersion: "15.5" },
  });
  const options = localOptions(stt.buildSttPickerOptions("dictation", ctx));
  for (const id of ["local:orukeet-v0.1.0", "local:parakeet-tdt-0.6b-v3"]) {
    const option = options.find((entry) => entry.id === id);
    assert.equal(option.available.reasonKey, "modelPicker.stt.reasons.requiresMacOS", id);
    assert.deepEqual(option.available.reasonParams, { version: "15.5" }, id);
  }
  assert.equal(options.find((entry) => entry.id === "local:base").available, true);
  // The selection says why it can't run; nothing switches it behind the user's back.
  assert.deepEqual(stt.describeSttSelection("dictation", ctx).warning, {
    key: "modelPicker.stt.reasons.requiresMacOS",
    params: { version: "15.5" },
  });
  const pick = { mode: "local", provider: "nvidia", model: "orukeet-v0.1.0" };
  assert.equal(
    stt.sttPickAvailability("dictation", pick, ctx).reasonKey,
    "modelPicker.stt.reasons.requiresMacOS"
  );
});

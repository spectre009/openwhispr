const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");

// The speech-to-text model picker on its three real pages (SettingsModal →
// SettingsLayer → Recognition, Live Recording, File Transcription) in
// happy-dom: the button names what runs, the menu lists what the surface can
// run, a pick writes through the adapter, the custom endpoint / self-hosted /
// Corti fields under it write the same store keys as the old editor's fields,
// Recognition's preview toggle and Whisper VAD keep their visibility, live
// recording shows what it borrows from Recognition with Override, and no key
// ever renders.

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLButtonElement",
  "DOMParser",
  "MutationObserver",
  "getComputedStyle",
  "KeyboardEvent",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "ResizeObserver",
  "IntersectionObserver",
  "DOMRect",
  "NodeFilter",
  "localStorage",
  "matchMedia",
  "DocumentFragment",
  "SVGElement",
  "Text",
  "Range",
  "ShadowRoot",
  "HTMLAnchorElement",
  "HTMLDivElement",
  "HTMLSpanElement",
  "HTMLImageElement",
  "HTMLLabelElement",
  "HTMLFormElement",
  "HTMLOptionElement",
  "HTMLDetailsElement",
  "HTMLCanvasElement",
  "Image",
  "getSelection",
];

const FOUNDRY = "https://contoso-foundry.cognitiveservices.azure.com/openai/v1";
const FOUNDRY_HOST = "contoso-foundry.cognitiveservices.azure.com";
const SECRETS = {
  customTranscriptionApiKey: "sk-custom-SECRET-1234",
  openaiApiKey: "sk-openai-SECRET-5678",
  deepgramApiKey: "dg-SECRET-9012",
  cortiClientId: "corti-SECRET-id",
  cortiClientSecret: "corti-SECRET-secret",
};

let happyWindow;
// What main answers; a test may change an answer before the page that reads it mounts.
let results;

test.before(async () => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window({ url: "http://localhost/" });
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) {
    const value = happyWindow[name];
    define(
      name,
      typeof value === "function" && /^[a-z]/.test(name) ? value.bind(happyWindow) : value
    );
  }
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
  results = {
    getUpdateStatus: {
      updateAvailable: false,
      updateDownloaded: false,
      isDevelopment: true,
      isSupported: false,
    },
    getAutoStartEnabled: { enabled: false, requiresApproval: false },
    listGpus: [],
    getAudioStorageUsage: { fileCount: 0, totalBytes: 0 },
    checkWhisperInstallation: { installed: false, working: false },
    checkParakeetInstallation: { installed: true, working: true, supported: true },
    getAppVersion: { version: "0.0.0" },
    listWhisperModels: {
      success: true,
      cache_dir: "",
      models: [
        { model: "base", downloaded: true, size_mb: 142 },
        { model: "small", downloaded: false },
      ],
    },
    listParakeetModels: {
      success: true,
      cache_dir: "",
      models: [
        { model: "parakeet-tdt-0.6b-v3", downloaded: true, size_mb: 680 },
        { model: "nemotron-speech-streaming-en-0.6b", downloaded: true },
        { model: "cohere-transcribe-03-2026", downloaded: false },
      ],
    },
    modelGetAll: [],
  };
  happyWindow.electronAPI = new Proxy(
    {},
    {
      get: (_target, name) =>
        typeof name === "string" && /^on[A-Z]/.test(name)
          ? () => () => {}
          : () => Promise.resolve(results[name]),
    }
  );
  Object.defineProperty(happyWindow.navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => [],
      getUserMedia: async () => ({ getTracks: () => [] }),
      addEventListener() {},
      removeEventListener() {},
    },
  });
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// The user's setup: Recognition and uploads on an Azure AI Foundry custom endpoint,
// live recording in "providers" mode borrowing Recognition's provider.
const DAILY = {
  isSignedIn: true,
  ...SECRETS,
  groqApiKey: "",
  xaiApiKey: "",
  mistralApiKey: "",
  geminiApiKey: "",
  tinfoilApiKey: "",
  assemblyaiApiKey: "",
  cortiEnvironment: "us",
  cortiTenant: "base",
  showTranscriptionPreview: false,
  enterpriseTranscriptionSetupMode: "auto",
  transcriptionMode: "providers",
  useLocalWhisper: false,
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "custom",
  cloudTranscriptionModel: "gpt-4o-transcribe",
  cloudTranscriptionBaseUrl: FOUNDRY,
  localTranscriptionProvider: "nvidia",
  whisperModel: "base",
  parakeetModel: "parakeet-tdt-0.6b-v3",
  remoteTranscriptionUrl: "http://192.168.1.20:8178",
  remoteTranscriptionModel: "large-v3",
  meetingTranscriptionMode: "providers",
  meetingUseLocalWhisper: false,
  meetingCloudTranscriptionMode: "byok",
  meetingCloudTranscriptionProvider: "",
  meetingCloudTranscriptionModel: "",
  meetingCloudTranscriptionBaseUrl: "",
  meetingLocalTranscriptionProvider: "nvidia",
  meetingParakeetModel: "",
  uploadTranscriptionMode: "providers",
  uploadUseLocalWhisper: false,
  uploadCloudTranscriptionMode: "byok",
  uploadCloudTranscriptionProvider: "custom",
  uploadCloudTranscriptionModel: "gpt-4o-transcribe",
  uploadCloudTranscriptionBaseUrl: FOUNDRY,
  uploadRemoteTranscriptionUrl: "",
  uploadRemoteTranscriptionModel: "",
  transcriptionModelByProvider: {},
};

test(
  "the speech-to-text picker on Recognition, Live Recording and File Transcription",
  { timeout: 120000 },
  async (t) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const h = React.createElement;
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-stt-model-picker-",
      resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    });
    const { default: SettingsModal } = await vite.ssrLoadModule("/components/SettingsModal.tsx");
    const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
    const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const { default: reasoningService } = await vite.ssrLoadModule("/services/ReasoningService.ts");
    t.after(() => reasoningService.destroy());

    const errors = [];
    const originalError = console.error;
    console.error = (...args) => {
      const text = args.map(String).join(" ");
      if (!/i18next|not wrapped in act|act\(\.\.\.\)/.test(text)) errors.push(text);
    };
    t.after(() => {
      console.error = originalError;
    });

    const doc = happyWindow.document;
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const root = createRoot(host);
    t.after(async () => {
      await React.act(async () => root.unmount());
      host.remove();
    });
    let closeRequests = 0;
    const render = async (request) => {
      await React.act(async () => {
        root.render(
          h(
            ToastProvider,
            null,
            h(
              SettingsProvider,
              null,
              h(SettingsModal, {
                open: true,
                request,
                onRequestClose: () => {
                  closeRequests += 1;
                  return false;
                },
                railItems: [],
                activeView: "home",
                onSelectView: () => {},
                onOpenSearch: () => {},
                onOpenElsewhere: () => {},
              })
            )
          )
        );
        await settle();
      });
      await settle();
    };
    const act = async (fn) => {
      await React.act(async () => {
        await fn();
        await settle();
      });
      await settle();
    };
    const state = () => useSettingsStore.getState();
    const shown = () =>
      [...doc.querySelectorAll("[data-settings-page-id]")]
        .filter((element) => !element.classList.contains("hidden"))
        .map((element) => element.getAttribute("data-settings-page-id"));
    const page = (id) => doc.querySelector(`[data-settings-page-id="${id}"]`);
    const menu = () => doc.querySelector("[data-model-picker-menu]");
    const option = (id) => menu()?.querySelector(`[data-option-id="${id}"]`) ?? null;
    const listed = () =>
      [...(menu()?.querySelectorAll("[data-option-id]") ?? [])].map((node) =>
        node.getAttribute("data-option-id")
      );
    const type = async (input, text) => {
      await act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          happyWindow.HTMLInputElement.prototype,
          "value"
        ).set;
        setter.call(input, text);
        input.dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
      });
    };
    const key = async (name) =>
      act(() =>
        (doc.activeElement ?? doc.body).dispatchEvent(
          new happyWindow.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })
        )
      );
    const noSecrets = (label) => {
      const html = doc.body.outerHTML;
      for (const secret of Object.values(SECRETS)) {
        assert.ok(!html.includes(secret), `${label}: no key renders (${secret})`);
      }
    };
    const sttKeys = () => {
      const s = state();
      return Object.fromEntries(
        Object.keys(DAILY)
          .filter((name) => !(name in SECRETS))
          .map((name) => [name, s[name]])
      );
    };

    // ── Recognition ──────────────────────────────────────────────────────────
    // After the first render: the store's key hydration (main's get-*-key answers) has run.
    await render({ section: "recognition", id: 1 });
    await act(() => useSettingsStore.setState(DAILY));
    assert.deepEqual(shown(), ["recognition"]);
    const engine = () =>
      page("recognition").querySelector('[data-setting-id="dictation.stt.engine"]');
    const trigger = () => engine().querySelector("[data-model-picker-trigger]");
    const openMenu = async () => {
      await act(() => trigger().click());
      assert.ok(menu(), "the menu opened");
    };
    const before = sttKeys();

    // The button: the endpoint's model, then "Custom endpoint · host"; its fields under it.
    assert.ok(trigger().textContent.includes("gpt-4o-transcribe"), trigger().textContent);
    assert.ok(trigger().textContent.includes(FOUNDRY_HOST));
    const byLabel = (container, text) => {
      const label = [...container.querySelectorAll("label")].find(
        (node) => node.textContent.trim() === text
      );
      return label ? doc.getElementById(label.htmlFor) : null;
    };
    const urlField = () => byLabel(engine(), "Endpoint URL");
    const modelField = () => byLabel(engine(), "Model");
    assert.equal(urlField().value, FOUNDRY, "the endpoint URL");
    assert.equal(modelField().value, "gpt-4o-transcribe", "the deployment name");
    assert.equal(
      engine().querySelector('[data-setting-id="dictation.stt.preview"]'),
      null,
      "no preview for a batch endpoint"
    );
    noSecrets("custom endpoint");
    assert.deepEqual(sttKeys(), before, "rendering wrote nothing");

    // Opening: the selection marked, the surface's connections listed, nothing written.
    await openMenu();
    assert.equal(option("custom").getAttribute("aria-selected"), "true");
    for (const id of [
      "cloud",
      "provider:openai:gpt-4o-transcribe",
      "provider:deepgram:nova-3",
      "provider:corti:corti-transcribe",
      "provider:groq:addKey",
      "local:base",
      "local:parakeet-tdt-0.6b-v3",
      "local:nemotron-speech-streaming-en-0.6b",
      "local:download",
      "selfHosted",
    ]) {
      assert.ok(option(id), `${id} is listed`);
    }
    assert.equal(option("local:small"), null, "not downloaded: not listed");
    assert.equal(option("local:cohere-transcribe-03-2026"), null);
    assert.equal(option("provider:groq:addKey").getAttribute("aria-disabled"), "true");
    assert.ok(option("provider:groq:addKey").textContent.includes("Add an API key"));
    assert.deepEqual(sttKeys(), before, "opening wrote nothing");
    // Esc closes the menu, not Settings.
    await key("Escape");
    assert.equal(menu(), null);
    assert.equal(closeRequests, 0);

    // Pick an OpenAI streaming model: the endpoint's fields go, the key link and preview come.
    await openMenu();
    await act(() => option("provider:openai:gpt-4o-mini-transcribe").click());
    assert.equal(menu(), null);
    assert.deepEqual(
      [
        state().transcriptionMode,
        state().cloudTranscriptionProvider,
        state().cloudTranscriptionModel,
      ],
      ["providers", "openai", "gpt-4o-mini-transcribe"]
    );
    assert.equal(state().cloudTranscriptionBaseUrl, FOUNDRY, "the endpoint URL is kept");
    assert.equal(state().transcriptionModelByProvider["dictation:custom"], "gpt-4o-transcribe");
    assert.equal(urlField(), null);
    assert.ok(
      [...engine().querySelectorAll("button")].some((b) =>
        b.textContent.includes("Manage keys in AI Connections")
      )
    );
    assert.ok(
      page("recognition").querySelector('[data-setting-id="dictation.stt.preview"]'),
      "a streaming model shows the live preview toggle"
    );

    // Back to the endpoint in one pick; everything is as it was (and remembered).
    await openMenu();
    assert.ok(option("custom:remembered").textContent.includes(FOUNDRY_HOST));
    await act(() => option("custom:remembered").click());
    const restored = sttKeys();
    assert.deepEqual(
      { ...restored, transcriptionModelByProvider: {} },
      before,
      "Recognition is back on its endpoint"
    );
    assert.deepEqual(restored.transcriptionModelByProvider, {
      "dictation:custom": "gpt-4o-transcribe",
      "dictation:openai": "gpt-4o-mini-transcribe",
    });

    // The custom endpoint's fields write the same keys the old Custom tab did.
    await type(urlField(), "https://other.example.com/v1");
    assert.equal(state().cloudTranscriptionBaseUrl, "https://other.example.com/v1");
    await type(modelField(), "whisper-large");
    assert.equal(state().cloudTranscriptionModel, "whisper-large");
    await type(urlField(), FOUNDRY);
    await type(modelField(), "gpt-4o-transcribe");
    // The shared key is replace-only and removable; it never shows.
    noSecrets("custom key field");
    const removeKey = [...engine().querySelectorAll("button")].find(
      (b) => b.textContent === "Remove"
    );
    assert.ok(removeKey, "a Remove control for the shared key");

    // A local Whisper model: mode, legacy flag and model as the old cards wrote them;
    // Whisper VAD shows below (today's rule), the preview toggle too.
    await openMenu();
    await act(() => option("local:base").click());
    assert.deepEqual(
      [
        state().transcriptionMode,
        state().useLocalWhisper,
        state().cloudTranscriptionMode,
        state().localTranscriptionProvider,
        state().whisperModel,
      ],
      ["local", true, "byok", "whisper", "base"]
    );
    assert.ok(page("recognition").querySelector('[data-setting-id="dictation.stt.vad"]'));
    assert.ok(page("recognition").querySelector('[data-setting-id="dictation.stt.preview"]'));
    assert.ok(trigger().textContent.includes("Whisper Base"));

    // Parakeet: the VAD block goes (it's Whisper's).
    await openMenu();
    await act(() => option("local:parakeet-tdt-0.6b-v3").click());
    assert.deepEqual(
      [state().localTranscriptionProvider, state().parakeetModel],
      ["nvidia", "parakeet-tdt-0.6b-v3"]
    );
    assert.equal(page("recognition").querySelector('[data-setting-id="dictation.stt.vad"]'), null);

    // Corti: its data region and tenant open under the picker; the client credentials stay on AI Connections.
    await openMenu();
    await act(() => option("provider:corti:corti-transcribe").click());
    assert.deepEqual(
      [state().transcriptionMode, state().cloudTranscriptionProvider],
      ["providers", "corti"]
    );
    const tenant = byLabel(engine(), "Tenant");
    assert.ok(tenant, "Corti's tenant field");
    await type(tenant, "acme");
    assert.equal(state().cortiTenant, "acme");
    noSecrets("Corti");

    // Self-hosted: the mode, then its own server and model fields.
    await openMenu();
    await act(() => option("selfHosted").click());
    assert.equal(state().transcriptionMode, "self-hosted");
    const server = engine().querySelector('input[placeholder="http://192.168.1.126:8178"]');
    assert.equal(server.value, "http://192.168.1.20:8178");
    await type(server, "http://192.168.1.30:8178");
    assert.equal(state().remoteTranscriptionUrl, "http://192.168.1.30:8178");
    assert.equal(
      state().uploadRemoteTranscriptionUrl,
      "",
      "File Transcription's server is its own"
    );

    // ── Live Recording: what it borrows from Recognition, one row each ───────
    // The user's disk: Parakeet and Nemotron, no Whisper model (read when the page mounts).
    results.listWhisperModels = {
      success: true,
      cache_dir: "",
      models: [
        { model: "base", downloaded: false },
        { model: "small", downloaded: false },
      ],
    };
    await render({ section: "liveRecording", id: 2 });
    await act(() => useSettingsStore.setState(DAILY));
    assert.deepEqual(shown(), ["liveRecording"]);
    const live = () =>
      page("liveRecording").querySelector('[data-setting-id="notes.recording.engine"]');
    const field = (name) => live().querySelector(`[data-inherited-field="${name}"]`);
    const warning = () => live().querySelector("[data-inherited-warning]");
    const warningButton = (label) =>
      [...(warning()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
    assert.ok(field("provider").textContent.includes("Custom endpoint"));
    assert.ok(field("provider").textContent.includes("inherited from Recognition"));
    assert.ok(field("endpoint").textContent.includes(FOUNDRY_HOST));
    assert.ok(field("model").textContent.includes("gpt-4o-transcribe"));
    assert.ok(
      warning().textContent.includes("Live recording needs a streaming model"),
      "it says the borrowed endpoint can't stream"
    );
    assert.ok(warningButton("Choose a model"), "with the way to fix it: the picker");
    assert.equal(live().querySelector("[data-model-picker-trigger]"), null);
    assert.equal(state().meetingCloudTranscriptionProvider, "", "showing it wrote nothing");
    // Speaker detection and echo cancellation stay on the page.
    assert.ok(live().querySelector('[data-setting-id="notes.recording.speakerDetection"]'));
    assert.ok(live().querySelector('[data-setting-id="notes.recording.echoCancellation"]'));

    const override = [...field("model").querySelectorAll("button")].find(
      (b) => b.textContent === "Override"
    );
    await act(() => override.click());
    assert.ok(menu(), "Override opens the picker");
    assert.equal(option("custom"), null, "live recording has no custom endpoint");
    assert.equal(option("provider:groq:addKey"), null, "Groq can't stream");
    assert.equal(option("provider:openai:gpt-transcribe"), null, "batch-only models are hidden");
    assert.equal(option("selfHosted").getAttribute("aria-disabled"), "true");
    assert.ok(listed().includes("local:parakeet-tdt-0.6b-v3"));
    assert.equal(state().meetingCloudTranscriptionProvider, "", "opening wrote nothing");
    await act(() => option("provider:deepgram:nova-3").click());
    assert.deepEqual(
      [state().meetingCloudTranscriptionProvider, state().meetingCloudTranscriptionModel],
      ["deepgram", "nova-3"]
    );
    assert.equal(state().cloudTranscriptionProvider, "custom", "Recognition untouched");
    assert.equal(field("provider"), null, "nothing borrowed any more");
    assert.ok(live().querySelector("[data-model-picker-trigger]").textContent.includes("Nova-3"));
    noSecrets("Live Recording");

    // The user's Live Recording: local Whisper, no model of its own or on Recognition,
    // none on disk. The engine shows first, then Whisper's default and why it can't run.
    const localWhisper = {
      ...DAILY,
      meetingTranscriptionMode: "local",
      meetingUseLocalWhisper: true,
      meetingLocalTranscriptionProvider: "whisper",
      meetingWhisperModel: "",
      whisperModel: "",
    };
    await act(() => useSettingsStore.setState(localWhisper));
    const beforeLocal = sttKeys();
    assert.deepEqual(
      [...live().querySelectorAll("[data-inherited-field]")].map((node) =>
        node.getAttribute("data-inherited-field")
      ),
      ["engine", "model"]
    );
    assert.ok(field("engine").textContent.includes("Whisper (local)"), field("engine").textContent);
    assert.equal(
      [...field("engine").querySelectorAll("button")].length,
      0,
      "the engine is Live Recording's own"
    );
    assert.ok(field("model").textContent.includes("Default (Whisper Base)"));
    assert.ok(
      warning().textContent.includes(
        "No Whisper model downloaded: pick another model, or download one in AI Connections"
      ),
      warning().textContent
    );
    assert.deepEqual(sttKeys(), beforeLocal, "showing it wrote nothing");
    await act(() => warningButton("Choose a model").click());
    assert.ok(menu(), "Choose a model opens the picker");
    assert.ok(listed().includes("local:parakeet-tdt-0.6b-v3"));
    assert.equal(option("local:base"), null, "Whisper Base isn't on disk");
    await key("Escape");
    assert.equal(menu(), null);
    assert.deepEqual(sttKeys(), beforeLocal, "opening wrote nothing");
    await act(() => warningButton("AI Connections").click());
    assert.deepEqual(shown(), ["connections"], "the link opens AI Connections");
    assert.deepEqual(sttKeys(), beforeLocal);

    // ── File Transcription: its own self-hosted server ───────────────────────
    await render({ section: "fileTranscription", id: 3 });
    await act(() => useSettingsStore.setState(DAILY));
    assert.deepEqual(shown(), ["fileTranscription"]);
    const upload = () =>
      page("fileTranscription").querySelector('[data-setting-id="notes.upload.engine"]');
    const uploadTrigger = upload().querySelector("[data-model-picker-trigger]");
    assert.ok(uploadTrigger.textContent.includes(FOUNDRY_HOST));
    await act(() => uploadTrigger.click());
    assert.equal(option("provider:deepgram:addKey"), null, "uploads hide live-only providers");
    assert.equal(option("provider:deepgram:nova-3"), null);
    await act(() => option("selfHosted").click());
    assert.deepEqual(
      [
        state().uploadTranscriptionMode,
        state().uploadUseLocalWhisper,
        state().uploadCloudTranscriptionMode,
      ],
      ["self-hosted", false, "byok"]
    );
    assert.equal(state().transcriptionMode, "providers", "Recognition untouched");
    const uploadServer = upload().querySelector('input[placeholder="http://192.168.1.126:8178"]');
    assert.equal(uploadServer.value, "", "not Recognition's server");
    await type(uploadServer, "http://192.168.1.21:8178");
    assert.equal(state().uploadRemoteTranscriptionUrl, "http://192.168.1.21:8178");
    assert.equal(state().remoteTranscriptionUrl, "http://192.168.1.20:8178");
    noSecrets("File Transcription");

    assert.deepEqual(errors, [], "nothing logged an error");
  }
);

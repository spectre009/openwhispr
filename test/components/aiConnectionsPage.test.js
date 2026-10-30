const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Settings › AI Connections & Local Models, rendered for real (SettingsModal →
// SettingsLayer → SettingsPage) in happy-dom with a stubbed preload. On a first
// run it shows the starter cards and "More providers"; once a feature uses a
// connection it groups them: In use as cards, Saved, not in use as rows, the
// rest folded under "Add a provider". Groups hold for a visit (a key added or
// removed moves nothing) and regroup on the next; a search or "Manage keys"
// link opens the fold only for a folded target. Keys only ever show masked
// (also while replacing one), Remove asks first naming what uses the key, and
// the Used by chips and the feature pages' links navigate both ways.

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

const AZURE = "https://littlebuddy-foundry-eus2.openai.azure.com";

const SECRETS = {
  groqApiKey: "gsk_SECRETGROQ-3333",
  geminiApiKey: "AIzaSECRETGEMINI-2222",
  openrouterApiKey: "sk-or-SECRETOPENROUTER-4444",
  customConnectionApiKey: "lb-SECRETBUDDY-5555",
  customTranscriptionApiKey: "lb-SECRETBUDDY-5555",
  chatAgentCustomApiKey: "lb-SECRETBUDDY-5555",
};
// Typed into a row in the fold during the test.
const OPENAI_KEY = "sk-proj-SECRETOPENAI-1111";

let happyWindow;

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
  // The preload: every call resolves to nothing (or the lists below), every
  // subscription returns its cleanup. No get-*-key call returns a key here:
  // the test puts them in the store, as hydration would.
  const results = {
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
    getAppVersion: { version: "0.0.0" },
    listWhisperModels: {
      success: true,
      cache_dir: "",
      models: [
        { success: true, model: "base", downloaded: true, size_mb: 142 },
        { success: true, model: "small", downloaded: false },
      ],
    },
    listParakeetModels: { success: true, cache_dir: "", models: [] },
    modelGetAll: [
      {
        id: "qwen3-4b-q4_k_m",
        name: "Qwen3 4B",
        size: "2.5GB",
        sizeBytes: 2_500_000_000,
        providerName: "Qwen",
        isDownloaded: true,
        isDownloading: false,
        downloadProgress: 0,
        downloadedSize: 0,
        totalSize: 0,
        path: null,
      },
    ],
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

function managedBedrockConfig() {
  const model = "anthropic.claude-sonnet-4-20250514-v1:0";
  const scopes = [
    "dictationCleanup",
    "dictationAgent",
    "noteFormatting",
    "chatIntelligence",
    "dictationTranslation",
  ];
  return {
    workspaceId: "workspace-a",
    version: 1,
    generation: 1,
    identity: {
      issuer: "https://api.example.com/enterprise-identity",
      jwksUri: "https://api.example.com/enterprise-identity/jwks.json",
      subject: "workspace:workspace-a",
      audiences: { bedrock: "sts.amazonaws.com", azure: "api://AzureADTokenExchange" },
    },
    providers: [
      {
        provider: "bedrock",
        mode: "managed_required",
        allowManualSetup: false,
        config: {
          roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
          region: "us-east-1",
          allowedModels: [model],
          scopeDefaults: Object.fromEntries(scopes.map((scope) => [scope, model])),
        },
        version: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
  };
}

test(
  "AI Connections groups connections by state, holds them for a visit and only ever shows keys masked",
  { timeout: 120000 },
  async (t) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const h = React.createElement;
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-ai-connections-",
      resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    });
    const { default: SettingsModal } = await vite.ssrLoadModule("/components/SettingsModal.tsx");
    const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
    const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const { useCopilotStore } = await vite.ssrLoadModule("/stores/copilotStore.ts");
    const { useOpenWhisprCloudStore } = await vite.ssrLoadModule("/stores/openWhisprCloudStore.ts");
    const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
      "/stores/enterpriseIdentityStore.ts"
    );
    const { maskApiKey } = await vite.ssrLoadModule("/utils/maskApiKey.ts");
    const { default: reasoningService } = await vite.ssrLoadModule("/services/ReasoningService.ts");
    t.after(() => reasoningService.destroy());
    happyWindow.HTMLElement.prototype.scrollIntoView = () => {};

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
    let request = null;
    let nextId = 1;
    const render = async ({ section, open = true } = {}) => {
      if (section) request = { section, id: nextId++ };
      await React.act(async () => {
        root.render(
          h(
            ToastProvider,
            null,
            h(
              SettingsProvider,
              null,
              h(SettingsModal, {
                open,
                request,
                onRequestClose: () => true,
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
    const act = async (fn, ms = 30) => {
      await React.act(async () => {
        fn();
        await settle(ms);
      });
      await settle();
    };
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
    const shown = () =>
      [...doc.querySelectorAll("[data-settings-page-id]")]
        .filter((element) => !element.classList.contains("hidden"))
        .map((element) => element.getAttribute("data-settings-page-id"));
    const page = () => doc.querySelector('[data-settings-page-id="connections"]');
    const entry = (id) => page().querySelector(`[data-setting-id="connections.${id}"]`);
    const group = (name) => page().querySelector(`[data-connection-group="${name}"]`);
    const anchorsIn = (scope) =>
      scope
        ? [...scope.querySelectorAll("[data-connection-card], [data-connection-row]")].map(
            (element) => element.getAttribute("data-setting-id").replace("connections.", "")
          )
        : [];
    const fold = () => page().querySelector('[data-setting-id="connections.more"]');
    const foldTrigger = () => fold().querySelector("[data-setting-expand]");
    const inFold = (id) => fold()?.querySelector(`[data-setting-id="connections.${id}"]`) ?? null;
    const buttonIn = (scope, text) =>
      [...scope.querySelectorAll("button")].find((button) => button.textContent.trim() === text);
    const noRawSecret = (when) => {
      const html = doc.documentElement.outerHTML;
      const values = [...doc.querySelectorAll("input, textarea")].map((input) => input.value);
      for (const secret of [...Object.values(SECRETS), OPENAI_KEY]) {
        assert.ok(!html.includes(secret), `${when}: ${secret} rendered`);
        assert.ok(!values.some((value) => value.includes(secret)), `${when}: ${secret} in a field`);
      }
    };
    // Main's answers, as the store holds them once loaded.
    const loaded = () => {
      useSettingsStore.setState({ secretsHydrated: true });
      useCopilotStore.setState({
        loaded: true,
        status: { configured: true, state: "signedIn", login: "dshafran_microsoft" },
      });
    };

    // ── First run: nothing in use ────────────────────────────────────────────
    await render({ section: "connections" });
    await act(() => {
      loaded();
      useCopilotStore.setState({ status: { configured: true, state: "signedOut", login: "" } });
      useOpenWhisprCloudStore.setState({ disabled: false });
      useSettingsStore.setState({
        isSignedIn: false,
        useCleanupModel: false,
        transcriptionMode: "local",
        cloudTranscriptionProvider: "openai",
        meetingTranscriptionMode: "local",
        uploadTranscriptionMode: "local",
        chatAgentMode: "local",
        dictationAgentMode: "local",
      });
    });
    assert.deepEqual(shown(), ["connections"]);
    assert.equal(
      page().querySelector("[data-settings-page-header] h2").textContent,
      "AI Connections & Local Models"
    );
    assert.ok(group("start").textContent.includes("Get started"));
    assert.equal(group("inUse"), null);
    assert.equal(group("saved"), null);
    assert.deepEqual(anchorsIn(group("start")), [
      "copilot",
      "openai",
      "anthropic",
      "gemini",
      "groq",
      "cloud",
    ]);
    assert.equal(foldTrigger().getAttribute("aria-expanded"), "false");
    assert.ok(foldTrigger().textContent.includes("More providers (8)"));
    assert.ok(
      foldTrigger().textContent.includes(
        "OpenRouter · Mistral · Tinfoil · Corti · xAI · Deepgram · AssemblyAI · Azure Speech"
      )
    );
    assert.ok(entry("custom").querySelector("[data-custom-connection-add]"));
    assert.ok(entry("custom").textContent.includes("Azure OpenAI or Foundry"));

    // ── The user's setup, on the next visit ──────────────────────────────────
    // Little Buddy runs Recognition, File Transcription, Chat and the voice
    // assistant (through Chat); Copilot runs Cleanup; Groq, Gemini and
    // OpenRouter have keys nothing uses; Cloud is off.
    await render({ open: false });
    await act(() => {
      useOpenWhisprCloudStore.setState({ disabled: true });
      useCopilotStore.setState({
        status: { configured: true, state: "signedIn", login: "dshafran_microsoft" },
      });
      useSettingsStore.setState({
        ...SECRETS,
        customConnection: {
          name: "Little Buddy",
          endpoint: AZURE,
          models: { language: ["gpt-5-mini"], speech: ["gpt-4o-transcribe"] },
        },
        useCleanupModel: true,
        cleanupMode: "providers",
        cleanupProvider: "copilot",
        cleanupModel: "claude-haiku-5.5",
        transcriptionMode: "providers",
        cloudTranscriptionMode: "byok",
        cloudTranscriptionProvider: "custom",
        cloudTranscriptionModel: "gpt-4o-transcribe",
        cloudTranscriptionBaseUrl: `${AZURE}/`,
        uploadTranscriptionMode: "providers",
        uploadCloudTranscriptionProvider: "custom",
        uploadCloudTranscriptionModel: "gpt-4o-transcribe",
        uploadCloudTranscriptionBaseUrl: `${AZURE}/openai/deployments/stt/audio/transcriptions?api-version=2025-03-01-preview`,
        chatAgentMode: "providers",
        chatAgentProvider: "custom",
        chatAgentModel: "gpt-5-mini",
        chatAgentCloudBaseUrl: `${AZURE}/openai/v1`,
        dictationAgentMode: "openwhispr",
        whisperModel: "base",
      });
    });
    await render({ open: true });
    assert.deepEqual(shown(), ["connections"]);
    assert.equal(group("start"), null, "no longer a first run");

    // In use: full cards, most used first.
    assert.ok(group("inUse").textContent.includes("In use"));
    assert.deepEqual(anchorsIn(group("inUse")), ["custom", "copilot"]);
    const littleBuddy = entry("custom");
    assert.ok(littleBuddy.hasAttribute("data-connection-card"));
    assert.ok(littleBuddy.textContent.includes("Little Buddy"));
    assert.ok(littleBuddy.querySelector('[data-custom-connection-kind="azure"]'));
    assert.ok(
      littleBuddy
        .querySelector("[data-custom-connection-key]")
        .textContent.includes(maskApiKey(SECRETS.customConnectionApiKey))
    );
    assert.ok(entry("copilot").querySelector('[data-usage-feature="cleanup"]'));
    assert.ok(entry("copilot").textContent.includes("Signed in as @dshafran_microsoft"));

    // Saved, not in use: one row each, masked key, Replace and Remove.
    assert.ok(group("saved").textContent.includes("Saved, not in use"));
    assert.deepEqual(anchorsIn(group("saved")), ["gemini", "groq", "openrouter"]);
    for (const [id, key] of [
      ["gemini", SECRETS.geminiApiKey],
      ["groq", SECRETS.groqApiKey],
      ["openrouter", SECRETS.openrouterApiKey],
    ]) {
      const row = entry(id);
      assert.ok(row.hasAttribute("data-connection-row"), `${id} is a row`);
      assert.ok(row.textContent.includes(maskApiKey(key)), `${id} shows its key masked`);
      assert.ok(row.querySelector('button[aria-label="Replace API key"]'), `${id}: Replace`);
      assert.ok(buttonIn(row, "Remove"), `${id}: Remove`);
    }

    // The rest, folded: names only until opened.
    assert.equal(foldTrigger().getAttribute("aria-expanded"), "false");
    assert.ok(foldTrigger().textContent.includes("Add a provider (10)"));
    assert.ok(
      foldTrigger().textContent.includes(
        "OpenAI · Anthropic · Mistral · Tinfoil · Corti · xAI · Deepgram · AssemblyAI · Azure Speech · OpenWhispr Cloud"
      )
    );
    assert.equal(entry("openai"), null, "folded rows aren't rendered");
    assert.equal(page().querySelector("[data-custom-connection-add]"), null, "there is one");
    noRawSecret("grouped");

    await act(() => foldTrigger().click());
    assert.equal(foldTrigger().getAttribute("aria-expanded"), "true");
    assert.deepEqual(anchorsIn(fold()), [
      "openai",
      "anthropic",
      "mistral",
      "tinfoil",
      "corti",
      "xai",
      "deepgram",
      "assemblyai",
      "azureSpeech",
      "cloud",
    ]);
    const openaiRow = inFold("openai");
    assert.ok(openaiRow.textContent.includes("Paste your API key"));
    assert.ok(openaiRow.querySelector('button[aria-label="Add API key"]'));
    assert.ok(openaiRow.textContent.includes("Get your API key"));
    // Corti's three credentials open under its row.
    const corti = inFold("corti");
    assert.equal(corti.querySelectorAll("input, [aria-label='Add API key']").length, 0);
    await act(() => corti.querySelector("[data-connection-toggle]").click());
    assert.equal(
      corti.querySelector("[data-connection-toggle]").getAttribute("aria-expanded"),
      "true"
    );
    assert.equal(corti.querySelectorAll('button[aria-label="Add API key"]').length, 3);
    // Azure Speech's endpoint and key open under its row; it reads connected
    // only with a key and a valid endpoint.
    const azureSpeech = () => inFold("azureSpeech");
    assert.ok(azureSpeech().textContent.includes("Not connected"));
    await act(() => azureSpeech().querySelector("[data-connection-toggle]").click());
    const endpointField = () =>
      azureSpeech().querySelector(
        'input[placeholder="https://<resource>.cognitiveservices.azure.com"]'
      );
    assert.ok(endpointField(), "the endpoint field opened");
    assert.equal(endpointField().getAttribute("dir"), "ltr");
    assert.ok(azureSpeech().textContent.includes("Resource endpoint"));
    assert.ok(
      azureSpeech().textContent.includes(
        "Paste the endpoint and a key from your Speech resource's Keys and Endpoint page."
      )
    );
    assert.equal(azureSpeech().querySelectorAll('button[aria-label="Add API key"]').length, 1);
    const leave = (input) =>
      act(() => input.dispatchEvent(new happyWindow.FocusEvent("focusout", { bubbles: true })));
    await type(endpointField(), "https://res.openai.azure.com");
    await leave(endpointField());
    assert.ok(azureSpeech().textContent.includes("This isn't an Azure Speech endpoint."));
    assert.equal(endpointField().getAttribute("aria-invalid"), "true");
    await act(() => useSettingsStore.setState({ azureSpeechApiKey: "az-speech-key-123456" }));
    assert.ok(azureSpeech().textContent.includes("Endpoint needed"), "a key alone isn't enough");
    await type(endpointField(), "res.cognitiveservices.azure.com/");
    await leave(endpointField());
    assert.equal(
      useSettingsStore.getState().azureSpeechEndpoint,
      "https://res.cognitiveservices.azure.com",
      "tidied to the resource origin"
    );
    assert.equal(endpointField().getAttribute("aria-invalid"), null);
    assert.ok(azureSpeech().textContent.includes("Key saved"));
    assert.ok(!azureSpeech().outerHTML.includes("az-speech-key-123456"), "the key shows masked");
    await act(() => useSettingsStore.setState({ azureSpeechApiKey: "", azureSpeechEndpoint: "" }));
    // Cloud, off: says so and links to Privacy & Data, never a sign-in.
    const cloud = inFold("cloud");
    assert.ok(cloud.textContent.includes("Off · Turned off in Privacy & Data"));
    assert.ok(buttonIn(cloud, "Open Privacy & Data"));
    assert.equal(cloud.querySelector("[data-connection-toggle]"), null);
    assert.ok(!/sign in/i.test(cloud.textContent), "no sign-in while Cloud is off");

    // Replace never puts the saved key in the field, and cancelling keeps it.
    await act(() => entry("groq").querySelector('button[aria-label="Replace API key"]').click());
    const field = entry("groq").querySelector("input");
    assert.ok(field, "the replace field opened");
    assert.equal(field.value, "", "starts empty");
    noRawSecret("while replacing");
    await act(() => entry("groq").querySelector('button[aria-label="Cancel editing"]').click());
    assert.equal(entry("groq").querySelector("input"), null);
    assert.equal(useSettingsStore.getState().groqApiKey, SECRETS.groqApiKey, "unchanged");

    // Remove asks first; cancelling keeps the key, confirming removes it and
    // leaves the row where it is for this visit.
    await act(() => buttonIn(entry("groq"), "Remove").click());
    let dialog = doc.querySelector('[role="alertdialog"], [role="dialog"]');
    assert.ok(dialog, "a confirmation");
    assert.ok(dialog.textContent.includes("Remove Groq?"));
    noRawSecret("in the confirmation");
    await act(() => buttonIn(dialog, "Cancel").click());
    assert.equal(useSettingsStore.getState().groqApiKey, SECRETS.groqApiKey, "kept");
    await act(() => buttonIn(entry("groq"), "Remove").click());
    dialog = doc.querySelector('[role="alertdialog"], [role="dialog"]');
    await act(() => buttonIn(dialog, "Remove").click());
    assert.equal(useSettingsStore.getState().groqApiKey, "", "removed");
    assert.deepEqual(anchorsIn(group("saved")), ["gemini", "groq", "openrouter"], "nothing moved");
    assert.ok(entry("groq").textContent.includes("Paste your API key"));

    // A key added in the fold stays in the fold for this visit.
    await act(() => inFold("openai").querySelector('button[aria-label="Add API key"]').click());
    await type(inFold("openai").querySelector("input"), OPENAI_KEY);
    await act(() => inFold("openai").querySelector('button[aria-label="Save API key"]').click());
    assert.equal(useSettingsStore.getState().openaiApiKey, OPENAI_KEY);
    assert.ok(inFold("openai"), "still in the fold");
    assert.ok(inFold("openai").textContent.includes(maskApiKey(OPENAI_KEY)));
    assert.ok(buttonIn(inFold("openai"), "Remove"));
    assert.equal(foldTrigger().getAttribute("aria-expanded"), "true", "the fold stays open");
    noRawSecret("after adding a key");

    // The next visit (another page, then back) regroups, with the fold closed.
    await render({ section: "cleanup" });
    assert.deepEqual(shown(), ["cleanup"]);
    await render({ section: "connections" });
    assert.deepEqual(anchorsIn(group("saved")), ["openai", "gemini", "openrouter"]);
    assert.equal(foldTrigger().getAttribute("aria-expanded"), "false");
    assert.ok(foldTrigger().textContent.includes("Groq"), "Groq is folded now");

    // ── Search and "Manage keys" land on a folded provider ───────────────────
    await render({ section: "cleanup" });
    await render({ section: "connections#connections.deepgram" });
    await act(() => {}, 150);
    assert.deepEqual(shown(), ["connections"]);
    assert.equal(foldTrigger().getAttribute("aria-expanded"), "true", "the fold opened");
    assert.ok(inFold("deepgram"), "the row shows");
    assert.ok(inFold("deepgram").hasAttribute("data-search-flash"), "and flashes");
    await act(() => {}, 100);
    assert.equal(foldTrigger().getAttribute("aria-expanded"), "true", "and stays open");

    // A target that already shows (In use) leaves the fold closed.
    await render({ section: "cleanup" });
    await render({ section: "connections#connections.copilot" });
    await act(() => {}, 150);
    assert.equal(foldTrigger().getAttribute("aria-expanded"), "false");
    assert.ok(entry("copilot").hasAttribute("data-search-flash"));

    // ── A provider key in use: its card, and Remove names who uses it ────────
    await render({ section: "cleanup" });
    await act(() =>
      useSettingsStore.setState({ cleanupProvider: "openai", cleanupModel: "gpt-5-mini" })
    );
    await render({ section: "connections" });
    assert.deepEqual(anchorsIn(group("inUse")), ["custom", "openai"]);
    assert.ok(anchorsIn(group("saved")).includes("copilot"), "signed in, now unused");
    const openai = entry("openai");
    assert.ok(openai.hasAttribute("data-connection-card"));
    assert.ok(openai.querySelector('[data-connection-status="ok"]'));
    assert.ok(openai.querySelector('[data-usage-feature="cleanup"]'));
    await act(() => openai.querySelector('button[aria-label="Replace API key"]').click());
    assert.equal(entry("openai").querySelector("input").value, "", "starts empty");
    noRawSecret("replacing on a card");
    await act(() => entry("openai").querySelector('button[aria-label="Cancel editing"]').click());
    await act(() => buttonIn(entry("openai"), "Remove").click());
    dialog = doc.querySelector('[role="alertdialog"], [role="dialog"]');
    assert.ok(dialog.textContent.includes("Cleanup"), "it names the feature using the key");
    await act(() => buttonIn(dialog, "Cancel").click());
    assert.equal(useSettingsStore.getState().openaiApiKey, OPENAI_KEY, "kept");

    // Local models: what's on disk, what uses it, and the built-in search model.
    const local = page().querySelector('[data-setting-id="connections.localModels"]');
    assert.ok(local.querySelector('[data-local-model="whisper:base"]'));
    assert.ok(local.querySelector('[data-local-model="llm:qwen3-4b-q4_k_m"]'));
    assert.ok(local.querySelector('[data-local-model="embedding:all-MiniLM-L6-v2"]'));
    assert.equal(local.querySelector('[data-local-model="whisper:small"]'), null, "not on disk");
    assert.ok(page().querySelector('[data-setting-id="connections.keepLoaded"] [role="switch"]'));

    // A Used by chip opens the feature's model setting...
    await act(() => entry("openai").querySelector('[data-usage-feature="cleanup"]').click());
    assert.deepEqual(shown(), ["cleanup"]);
    // ...and the feature's key field links back to the provider's card.
    const manage = [...doc.querySelectorAll('[data-settings-page-id="cleanup"] button')].find(
      (button) => button.textContent.includes("Manage keys in AI Connections")
    );
    assert.ok(manage, "Cleanup's OpenAI key field links to AI Connections");
    await act(() => manage.click(), 150);
    assert.deepEqual(shown(), ["connections"]);
    assert.ok(entry("openai").hasAttribute("data-search-flash"), "landed on the card");
    assert.equal(foldTrigger().getAttribute("aria-expanded"), "false", "nothing to unfold");
    noRawSecret("after navigating");

    // A managed enterprise snapshot: read-only, locked, per feature.
    await act(() =>
      useEnterpriseIdentityStore.setState({
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 1,
        status: "ready",
        config: managedBedrockConfig(),
        error: null,
      })
    );
    const managed = page().querySelector(
      '[data-setting-id="connections.enterprise"] [data-enterprise-managed]'
    );
    assert.ok(managed, "the managed card");
    assert.ok(managed.textContent.includes("Managed by your organization"));
    assert.ok(managed.textContent.includes("Cleanup"));
    assert.ok(
      managed.textContent.includes("AWS Bedrock") || managed.textContent.includes("Bedrock")
    );
    assert.equal(managed.querySelector("input, button"), null, "nothing to edit");
    // Cleanup now runs on the managed deployment, not the OpenAI key; the card stays this visit.
    assert.equal(entry("openai").querySelector('[data-usage-feature="cleanup"]'), null);
    assert.ok(entry("openai").hasAttribute("data-connection-card"));
    noRawSecret("managed");

    assert.deepEqual(errors, [], "nothing logged an error");
  }
);

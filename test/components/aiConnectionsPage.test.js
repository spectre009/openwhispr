const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Settings › AI Connections & Local Models, rendered for real (SettingsModal →
// SettingsLayer → SettingsPage) in happy-dom with a stubbed preload: it mounts
// with OpenWhispr Cloud off and with a managed enterprise snapshot, shows saved
// keys masked only (also while replacing one), keeps less common providers
// behind "More providers" until they're connected, and its Used by chips and
// the feature pages' "Manage keys" links navigate both ways.

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

const SECRETS = {
  openaiApiKey: "sk-proj-SECRETOPENAI-1111",
  anthropicApiKey: "sk-ant-SECRETANTHROPIC-2222",
  groqApiKey: "gsk_SECRETGROQ-3333",
  mistralApiKey: "mistral-SECRETMISTRAL-4444",
  cortiClientSecret: "corti-SECRETCORTI-5555",
  cleanupCustomApiKey: "sk-cleanup-SECRETCUSTOM-6666",
  customTranscriptionApiKey: "stt-SECRETSTT-7777",
};

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
  "AI Connections mounts with Cloud off and a managed setup, and only ever shows keys masked",
  { timeout: 90000 },
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
    const { useOpenWhisprCloudStore } = await vite.ssrLoadModule("/stores/openWhisprCloudStore.ts");
    const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
      "/stores/enterpriseIdentityStore.ts"
    );
    const { maskApiKey } = await vite.ssrLoadModule("/utils/maskApiKey.ts");
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
    const act = async (fn) => {
      await React.act(async () => {
        fn();
        await settle();
      });
      await settle();
    };
    const shown = () =>
      [...doc.querySelectorAll("[data-settings-page-id]")]
        .filter((element) => !element.classList.contains("hidden"))
        .map((element) => element.getAttribute("data-settings-page-id"));
    const page = () => doc.querySelector('[data-settings-page-id="connections"]');
    const card = (id) => page().querySelector(`[data-setting-id="connections.${id}"]`);
    const noRawSecret = (when) => {
      const html = doc.documentElement.outerHTML;
      const values = [...doc.querySelectorAll("input, textarea")].map((input) => input.value);
      for (const secret of Object.values(SECRETS)) {
        assert.ok(!html.includes(secret), `${when}: ${secret} rendered`);
        assert.ok(!values.some((value) => value.includes(secret)), `${when}: ${secret} in a field`);
      }
    };

    // Cloud off, keys saved (as the store holds them after hydration), Cleanup on OpenAI.
    await render({ section: "connections", id: 1 });
    await act(() => {
      useOpenWhisprCloudStore.setState({ disabled: true });
      useSettingsStore.setState({
        ...SECRETS,
        isSignedIn: false,
        useCleanupModel: true,
        cleanupMode: "providers",
        cleanupProvider: "openai",
        cleanupModel: "gpt-5-mini",
        transcriptionMode: "providers",
        cloudTranscriptionProvider: "groq",
        cloudTranscriptionModel: "whisper-large-v3-turbo",
        whisperModel: "base",
      });
    });
    assert.deepEqual(shown(), ["connections"]);
    assert.equal(
      page().querySelector("[data-settings-page-header] h2").textContent,
      "AI Connections & Local Models"
    );

    // Saved keys show masked, with their status.
    assert.ok(card("openai").textContent.includes(maskApiKey(SECRETS.openaiApiKey)));
    assert.ok(card("openai").querySelector('[data-connection-status="ok"]'));
    assert.ok(card("anthropic").textContent.includes(maskApiKey(SECRETS.anthropicApiKey)));
    assert.ok(card("gemini").querySelector('[data-connection-status="muted"]'), "no Gemini key");
    noRawSecret("first render");

    // Used by: Cleanup on OpenAI, Recognition on Groq.
    assert.ok(card("openai").querySelector('[data-usage-feature="cleanup"]'));
    assert.ok(card("groq").querySelector('[data-usage-feature="recognition"]'));

    // Cloud off: says so, links to Privacy & Data, offers no sign-in.
    const cloud = card("cloud");
    assert.ok(cloud.querySelector('[data-connection-status="muted"]'));
    assert.ok(cloud.textContent.includes("Turned off in Privacy & Data"));
    assert.ok(
      [...cloud.querySelectorAll("button")].some((button) =>
        button.textContent.includes("Privacy & Data")
      )
    );
    assert.ok(!/sign in/i.test(cloud.textContent), "no sign-in while Cloud is off");

    // A connected less common provider moves up front; the rest wait behind "More".
    assert.ok(card("mistral"), "Mistral has a key, so it shows");
    assert.ok(card("corti"), "Corti has a credential, so it shows");
    assert.equal(card("openrouter"), null, "OpenRouter waits behind More providers");
    const more = page().querySelector('[data-setting-id="connections.more"] [data-setting-expand]');
    assert.equal(more.getAttribute("aria-expanded"), "false");
    await act(() => more.click());
    assert.ok(card("openrouter"), "expanding shows the rest");
    assert.ok(card("deepgram"));

    // Replace never puts the saved key in the field, and cancelling keeps it.
    const replace = card("openai").querySelector('button[aria-label="Replace API key"]');
    assert.ok(replace, "a Replace control");
    await act(() => replace.click());
    const field = card("openai").querySelector("input");
    assert.ok(field, "the replace field opened");
    assert.equal(field.value, "", "starts empty");
    noRawSecret("while replacing");
    await act(() => card("openai").querySelector('button[aria-label="Cancel editing"]').click());
    assert.equal(card("openai").querySelector("input"), null);
    assert.equal(useSettingsStore.getState().openaiApiKey, SECRETS.openaiApiKey, "unchanged");

    // Remove asks first, naming what uses the key; cancelling keeps it.
    const remove = [...card("openai").querySelectorAll("button")].find(
      (button) => button.textContent === "Remove"
    );
    await act(() => remove.click());
    const dialog = doc.querySelector('[role="alertdialog"], [role="dialog"]');
    assert.ok(dialog, "a confirmation");
    assert.ok(dialog.textContent.includes("Cleanup"), "it names the feature using the key");
    noRawSecret("in the confirmation");
    const cancel = [...dialog.querySelectorAll("button")].find((button) =>
      /cancel/i.test(button.textContent)
    );
    await act(() => cancel.click());
    assert.equal(useSettingsStore.getState().openaiApiKey, SECRETS.openaiApiKey, "kept");

    // Local models: what's on disk, what uses it, and the built-in search model.
    const local = page().querySelector('[data-setting-id="connections.localModels"]');
    assert.ok(local.querySelector('[data-local-model="whisper:base"]'));
    assert.ok(local.querySelector('[data-local-model="llm:qwen3-4b-q4_k_m"]'));
    assert.ok(local.querySelector('[data-local-model="embedding:all-MiniLM-L6-v2"]'));
    assert.equal(local.querySelector('[data-local-model="whisper:small"]'), null, "not on disk");
    assert.ok(page().querySelector('[data-setting-id="connections.keepLoaded"] [role="switch"]'));

    // A Used by chip opens the feature's model setting...
    await act(() => card("openai").querySelector('[data-usage-feature="cleanup"]').click());
    assert.deepEqual(shown(), ["cleanup"]);
    // ...and the feature's key field links back to the provider's card.
    const manage = [...doc.querySelectorAll('[data-settings-page-id="cleanup"] button')].find(
      (button) => button.textContent.includes("Manage keys in AI Connections")
    );
    assert.ok(manage, "Cleanup's OpenAI key field links to AI Connections");
    await act(() => manage.click());
    assert.deepEqual(shown(), ["connections"]);
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
    // Cleanup now runs on the managed deployment, not the OpenAI key.
    assert.equal(card("openai").querySelector('[data-usage-feature="cleanup"]'), null);
    noRawSecret("managed");

    assert.deepEqual(errors, [], "nothing logged an error");
  }
);

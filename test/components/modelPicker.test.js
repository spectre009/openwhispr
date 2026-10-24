const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");

// The model picker on a real feature page (SettingsModal → SettingsLayer →
// Cleanup) in happy-dom: it opens with the filter focused and the selection
// marked, filters as you type, picks with ↑/↓ and Enter, closes on Esc without
// leaving Settings, keeps unavailable entries listed (not pickable, their link
// followed), and the custom-endpoint and self-hosted fields under it write the
// same store keys the old editor's panels did.

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

const LOCAL_MODEL = "qwen3.5-4b-q4_k_m";

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
    listWhisperModels: { success: true, cache_dir: "", models: [] },
    listParakeetModels: { success: true, cache_dir: "", models: [] },
    modelGetAll: [
      {
        id: LOCAL_MODEL,
        name: "Qwen3.5 4B",
        size: "2.7GB",
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

test(
  "the model picker on Cleanup, Voice Assistant and Note Formatting",
  { timeout: 90000 },
  async (t) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const h = React.createElement;
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-model-picker-",
      resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    });
    const { default: SettingsModal } = await vite.ssrLoadModule("/components/SettingsModal.tsx");
    const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
    const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const { useCopilotStore } = await vite.ssrLoadModule("/stores/copilotStore.ts");
    const { REASONING_PROVIDERS } = await vite.ssrLoadModule("/models/ModelRegistry.ts");
    const { default: reasoningService } = await vite.ssrLoadModule("/services/ReasoningService.ts");
    t.after(() => reasoningService.destroy());

    const groq = REASONING_PROVIDERS.groq.models;

    // The endpoints' /models lists.
    const originalFetch = globalThis.fetch;
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      const models = String(url).includes("192.168.1.5")
        ? [{ id: "qwen3:8b" }, { id: "llama3.2:3b" }]
        : [{ id: "my-model" }, { id: "other-model" }];
      return new Response(JSON.stringify({ data: models }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

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
    const shown = () =>
      [...doc.querySelectorAll("[data-settings-page-id]")]
        .filter((element) => !element.classList.contains("hidden"))
        .map((element) => element.getAttribute("data-settings-page-id"));
    const editor = () =>
      doc.querySelector(
        '[data-settings-page-id="cleanup"] [data-setting-id="dictation.cleanup.model"]'
      );
    const trigger = () => editor().querySelector("[data-model-picker-trigger]");
    const menu = () => doc.querySelector("[data-model-picker-menu]");
    const option = (id) => menu()?.querySelector(`[data-option-id="${id}"]`) ?? null;
    const visibleOptions = () =>
      [...(menu()?.querySelectorAll("[data-option-id]") ?? [])].map((node) =>
        node.getAttribute("data-option-id")
      );
    const filter = () => menu().querySelector('input[role="combobox"]');
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
    const openMenu = async () => {
      await act(() => trigger().click());
      assert.ok(menu(), "the menu opened");
    };
    const state = () => useSettingsStore.getState();
    const cleanupKeys = () => {
      const s = state();
      return {
        mode: s.cleanupMode,
        cloudMode: s.cleanupCloudMode,
        provider: s.cleanupProvider,
        model: s.cleanupModel,
        cloudBaseUrl: s.cleanupCloudBaseUrl,
        remoteUrl: s.cleanupRemoteUrl,
      };
    };

    await render({ section: "cleanup", id: 1 });
    // Main has answered: not signed in to GitHub Copilot.
    await act(() =>
      useCopilotStore.setState({
        status: { configured: true, state: "signedOut", login: "" },
        loaded: true,
      })
    );
    await act(() =>
      useSettingsStore.setState({
        isSignedIn: false,
        useCleanupModel: true,
        cleanupMode: "providers",
        cleanupCloudMode: "byok",
        cleanupProvider: "groq",
        cleanupModel: groq[0].value,
        cleanupCloudBaseUrl: "",
        cleanupRemoteUrl: "",
        groqApiKey: "gsk-test",
        openaiApiKey: "",
        anthropicApiKey: "",
        geminiApiKey: "",
        openrouterApiKey: "",
        tinfoilApiKey: "",
        cortiApiKey: "",
      })
    );
    assert.deepEqual(shown(), ["cleanup"]);
    const groqIds = groq.map((model) => model.value);

    // The button: model, then connection · account.
    assert.ok(trigger(), "the picker's button");
    assert.ok(trigger().textContent.includes(groq[0].label), trigger().textContent);
    assert.ok(trigger().textContent.includes("Groq · API key"));
    // The key itself lives on AI Connections; the editor links there.
    assert.ok(
      [...editor().querySelectorAll("button")].some((button) =>
        button.textContent.includes("Manage keys in AI Connections")
      )
    );

    // Opening: filter focused, the selection marked, every connection listed.
    await openMenu();
    assert.equal(doc.activeElement, filter(), "the filter has focus");
    assert.equal(option(`provider:groq:${groqIds[0]}`).getAttribute("aria-selected"), "true");
    for (const id of [
      "cloud",
      "copilot:signIn",
      "provider:anthropic:addKey",
      "custom",
      "selfHosted",
    ]) {
      assert.ok(option(id), `${id} is listed`);
    }
    assert.ok(option(`local:${LOCAL_MODEL}`), "the downloaded local model");
    assert.ok(option("local:download"));
    // Unavailable entries say why.
    assert.equal(option("cloud").getAttribute("aria-disabled"), "true");
    assert.ok(option("cloud").textContent.includes("Sign in to your OpenWhispr account"));
    assert.equal(option("provider:anthropic:addKey").getAttribute("aria-disabled"), "true");
    assert.ok(option("provider:anthropic:addKey").textContent.includes("Add an API key"));

    // An unavailable entry can't be picked.
    const before = cleanupKeys();
    await act(() => option("provider:anthropic:addKey").click());
    assert.ok(menu(), "still open");
    assert.deepEqual(cleanupKeys(), before, "nothing picked");

    // Esc closes the menu, not Settings.
    await key("Escape");
    assert.equal(menu(), null, "Esc closed the menu");
    assert.deepEqual(shown(), ["cleanup"]);
    assert.equal(closeRequests, 0, "and left Settings open");

    // Type to filter, then ↓ and Enter.
    await openMenu();
    await type(filter(), "groq");
    assert.deepEqual(
      visibleOptions(),
      groqIds.map((id) => `provider:groq:${id}`),
      "only Groq's models"
    );
    await key("ArrowDown");
    await key("Enter");
    assert.equal(menu(), null, "picking closes the menu");
    assert.equal(state().cleanupProvider, "groq");
    assert.equal(state().cleanupModel, groqIds[1], "↓ then Enter picked the second Groq model");
    assert.ok(trigger().textContent.includes(groq[1].label));

    // Enter on an unavailable entry follows its link.
    await openMenu();
    await type(filter(), "anthropic");
    assert.deepEqual(visibleOptions(), ["provider:anthropic:addKey"]);
    await key("Enter");
    assert.deepEqual(shown(), ["connections"], "Add an API key opened AI Connections");
    assert.equal(menu(), null);

    // Clicking an entry's link does the same.
    await render({ section: "cleanup", id: 2 });
    assert.deepEqual(shown(), ["cleanup"]);
    await openMenu();
    await act(() => option("local:download").click());
    assert.deepEqual(shown(), ["connections"], "Download more models opened AI Connections");
    await render({ section: "cleanup", id: 3 });

    // Custom endpoint: its fields open under the picker; the pick happens on a model there.
    await openMenu();
    await act(() => option("custom").click());
    assert.equal(menu(), null);
    assert.equal(state().cleanupProvider, "groq", "browsing writes nothing");
    const endpoint = () => editor().querySelector('input[placeholder="https://api.openai.com/v1"]');
    assert.ok(endpoint(), "the custom endpoint's URL field");
    await type(endpoint(), "https://llm.example.com/v1");
    const apply = [...editor().querySelectorAll("button")].find((button) =>
      button.textContent.includes("Apply & Refresh")
    );
    await act(() => apply.click());
    await act(() => settle(50));
    assert.equal(state().cleanupCloudBaseUrl, "https://llm.example.com/v1");
    assert.ok(fetched.some((url) => url.startsWith("https://llm.example.com/v1/models")));
    const card = (label) =>
      [...editor().querySelectorAll("span")].find((span) => span.textContent === label);
    assert.ok(card("my-model"), "the endpoint's models");
    await act(() => card("my-model").click());
    assert.deepEqual(cleanupKeys(), {
      mode: "providers",
      cloudMode: "byok",
      provider: "custom",
      model: "my-model",
      cloudBaseUrl: "https://llm.example.com/v1",
      remoteUrl: "",
    });
    assert.ok(trigger().textContent.includes("my-model"));
    assert.ok(trigger().textContent.includes("llm.example.com"));

    // This feature's key for the endpoint: replaced, never shown, and removable.
    await act(() => useSettingsStore.setState({ cleanupCustomApiKey: "sk-custom-SECRET-1234" }));
    assert.ok(!editor().outerHTML.includes("sk-custom-SECRET-1234"), "the key never shows");
    const removeKey = [...editor().querySelectorAll("button")].find(
      (button) => button.textContent === "Remove"
    );
    assert.ok(removeKey, "a Remove control");
    await act(() => removeKey.click());
    assert.equal(state().cleanupCustomApiKey, "");

    // Self-hosted: picks the mode (as its card did), then its server and model fields.
    await openMenu();
    await act(() => option("selfHosted").click());
    assert.equal(state().cleanupMode, "self-hosted");
    assert.equal(state().cleanupCloudMode, "byok");
    const server = () =>
      editor().querySelector('input[placeholder="http://192.168.1.126:11434/v1"]');
    assert.ok(server(), "the server URL field");
    await type(server(), "http://192.168.1.5:11434/v1");
    const applyServer = [...editor().querySelectorAll("button")].find((button) =>
      button.textContent.includes("Apply & Refresh")
    );
    await act(() => applyServer.click());
    await act(() => settle(50));
    assert.equal(state().cleanupRemoteUrl, "http://192.168.1.5:11434/v1");
    await act(() => card("qwen3:8b").click());
    assert.equal(state().cleanupModel, "qwen3:8b");
    assert.equal(state().cleanupProvider, "custom", "self-hosted keeps the provider, as before");

    // Back to Groq; the local model from the list is pickable too.
    await openMenu();
    await act(() => option(`local:${LOCAL_MODEL}`).click());
    assert.deepEqual(
      [state().cleanupMode, state().cleanupProvider, state().cleanupModel],
      ["local", "qwen", LOCAL_MODEL]
    );
    assert.ok(
      editor().querySelector('[data-setting-id="dictation.cleanup.model.keepLoaded"]'),
      "Keep model loaded under a local pick"
    );
    await openMenu();
    await act(() => option(`provider:groq:${groqIds[0]}`).click());
    assert.deepEqual(
      [state().cleanupMode, state().cleanupProvider, state().cleanupModel],
      ["providers", "groq", groqIds[0]]
    );
    assert.equal(
      editor().querySelector('[data-setting-id="dictation.cleanup.model.keepLoaded"]'),
      null
    );

    // Voice Assistant: Copilot is listed, with why it can't be picked there.
    await act(() => useSettingsStore.setState({ useDictationAgent: true }));
    await render({ section: "assistant", id: 4 });
    assert.deepEqual(shown(), ["assistant"]);
    const assistantTrigger = doc.querySelector(
      '[data-settings-page-id="assistant"] [data-setting-id="assistant.model"] [data-model-picker-trigger]'
    );
    await act(() => assistantTrigger.click());
    assert.equal(option("copilot:unsupported").getAttribute("aria-disabled"), "true");
    assert.ok(
      option("copilot:unsupported").textContent.includes(
        "Copilot serves Cleanup, Styles, Translation and Note Formatting only"
      )
    );
    assert.equal(option("copilot:signIn"), null);
    await key("Escape");
    assert.equal(menu(), null);

    // Note formatting: each field it borrows from Cleanup, with Override.
    await act(() =>
      useSettingsStore.setState({
        noteFormattingMode: "providers",
        noteFormattingCloudMode: "",
        noteFormattingProvider: "",
        noteFormattingModel: "",
        noteFormattingCloudBaseUrl: "",
        noteFormattingRemoteUrl: "",
      })
    );
    await render({ section: "noteFormatting", id: 5 });
    assert.deepEqual(shown(), ["noteFormatting"]);
    const formatting = () =>
      doc.querySelector(
        '[data-settings-page-id="noteFormatting"] [data-setting-id="notes.formatting.model"]'
      );
    const field = (name) => formatting().querySelector(`[data-inherited-field="${name}"]`);
    assert.ok(field("provider").textContent.includes("Groq"));
    assert.ok(field("provider").textContent.includes("inherited from Cleanup"));
    assert.ok(field("model").textContent.includes(groq[0].label));
    assert.equal(
      formatting().querySelector("[data-model-picker-trigger]"),
      null,
      "no picker button"
    );
    assert.equal(state().noteFormattingProvider, "", "showing it wrote nothing");
    const override = [...field("model").querySelectorAll("button")].find(
      (button) => button.textContent === "Override"
    );
    await act(() => override.click());
    assert.ok(menu(), "Override opens the picker");
    assert.equal(state().noteFormattingModel, "", "opening wrote nothing");
    await act(() => option(`provider:groq:${groqIds[1]}`).click());
    assert.equal(state().noteFormattingProvider, "groq");
    assert.equal(state().noteFormattingModel, groqIds[1]);
    assert.equal(field("provider"), null, "nothing inherited any more");
    assert.ok(formatting().querySelector("[data-model-picker-trigger]"));

    assert.deepEqual(errors, [], "nothing logged an error");
  }
);

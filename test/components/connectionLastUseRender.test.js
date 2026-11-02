const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");

// "Last recorded use" on Settings › AI Connections, rendered for real
// (SettingsModal → SettingsPage → AiConnectionsPage) in happy-dom: main's
// record is read when the page shows and followed while it's open; a card or
// row with a record shows "Last recorded use: <feature>, OK / failed,
// <reason>" with a local time (and the last failure under an OK), one
// without shows no line, and nothing about a key reaches the page.

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

const GROQ_KEY = "gsk_SECRET-groq-LASTUSE";
const GEMINI_KEY = "AIzaSECRET-gemini-LASTUSE";

const main = { outcomes: {}, emitOutcomes: null, gets: 0 };

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
    modelGetAll: [],
  };
  const overrides = {
    connectionChecksRun: async (request) => ({
      results: {},
      pending: request.descriptors.map((descriptor) => descriptor.id),
    }),
    onConnectionCheckResult: () => () => {},
    connectionOutcomesGet: async () => {
      main.gets += 1;
      return { outcomes: main.outcomes };
    },
    onConnectionOutcomesChanged: (callback) => {
      main.emitOutcomes = callback;
      return () => {};
    },
  };
  happyWindow.electronAPI = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== "string") return undefined;
        if (overrides[name]) return overrides[name];
        if (/^on[A-Z]/.test(name)) return () => () => {};
        return () => Promise.resolve(results[name]);
      },
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

const timeOf = (at) =>
  new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(at));
const dateTimeOf = (at) =>
  new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));

test("AI Connections shows each connection's last recorded use", { timeout: 120000 }, async (t) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const h = React.createElement;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-connection-last-use-render-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { default: SettingsModal } = await vite.ssrLoadModule("/components/SettingsModal.tsx");
  const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useCopilotStore } = await vite.ssrLoadModule("/stores/copilotStore.ts");
  const { useOpenWhisprCloudStore } = await vite.ssrLoadModule("/stores/openWhisprCloudStore.ts");
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
  let nextId = 1;
  const render = async (section) => {
    const request = { section, id: nextId++ };
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
      await fn();
      await settle();
    });
    await settle();
  };
  const page = () => doc.querySelector('[data-settings-page-id="connections"]');
  const entry = (id) => page().querySelector(`[data-setting-id="connections.${id}"]`);
  const lastUse = (id) => entry(id).querySelector("[data-connection-last-use]");
  const noRawSecret = (when) => {
    const html = doc.documentElement.outerHTML;
    for (const secret of [GROQ_KEY, GEMINI_KEY]) {
      assert.ok(!html.includes(secret), `${when}: ${secret} rendered`);
    }
  };

  // Times within today (the line shows the time alone) and one yesterday.
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const earlier = startOfDay + 1000;
  const now = startOfDay + 2000;
  const yesterday = startOfDay - 60 * 60 * 1000;
  main.outcomes = {
    "provider:groq": {
      last: { feature: "cleanup", ok: true, code: "OK", at: earlier },
      lastFailure: null,
    },
  };

  await render("cleanup");
  await act(() => {
    useOpenWhisprCloudStore.setState({ disabled: true });
    useCopilotStore.setState({
      loaded: true,
      status: { configured: true, state: "signedOut", login: "" },
    });
    useSettingsStore.setState({
      secretsHydrated: true,
      isSignedIn: false,
      groqApiKey: GROQ_KEY,
      geminiApiKey: GEMINI_KEY,
      useCleanupModel: true,
      cleanupMode: "providers",
      cleanupProvider: "groq",
      cleanupModel: "llama-3.3-70b-versatile",
      transcriptionMode: "local",
      meetingTranscriptionMode: "local",
      uploadTranscriptionMode: "local",
      chatAgentMode: "local",
      dictationAgentMode: "local",
      useDictationTranslation: false,
      customConnection: null,
    });
  });
  assert.equal(main.gets, 0, "read only when the page shows");

  // ── Showing the page reads main's record ────────────────────────────────
  await render("connections");
  assert.ok(main.gets >= 1);
  assert.equal(lastUse("groq").getAttribute("data-connection-last-use"), "ok");
  assert.equal(lastUse("groq").textContent, `Last recorded use: Cleanup, OK · ${timeOf(earlier)}`);
  assert.equal(lastUse("gemini"), null, "no record, no line");
  noRawSecret("on show");

  // ── A failure, as it's recorded ─────────────────────────────────────────
  await act(() =>
    main.emitOutcomes({
      outcomes: {
        "provider:groq": {
          last: { feature: "styles", ok: false, code: "PROVIDER_AUTH_FAILED", at: now },
          lastFailure: { feature: "styles", ok: false, code: "PROVIDER_AUTH_FAILED", at: now },
        },
      },
    })
  );
  assert.equal(lastUse("groq").getAttribute("data-connection-last-use"), "failed");
  assert.equal(
    lastUse("groq").textContent,
    `Last recorded use: Styles, failed, key rejected · ${timeOf(now)}`
  );
  assert.equal(lastUse("groq").querySelector("[data-connection-last-failure]"), null);

  // ── OK again: the last failure under it; an unused row's older use ──────
  await act(() =>
    main.emitOutcomes({
      outcomes: {
        "provider:groq": {
          last: { feature: "recognition", ok: true, code: "OK", at: now + 1000 },
          lastFailure: { feature: "styles", ok: false, code: "PROVIDER_AUTH_FAILED", at: now },
        },
        "provider:gemini": {
          last: { feature: "chat", ok: false, code: "PROVIDER_RATE_LIMITED", at: yesterday },
          lastFailure: {
            feature: "chat",
            ok: false,
            code: "PROVIDER_RATE_LIMITED",
            at: yesterday,
          },
        },
        "provider:openai": {
          last: { feature: "chat", ok: true, code: "OK", at: now },
          lastFailure: null,
        },
      },
    })
  );
  const groqLine = lastUse("groq");
  assert.ok(
    groqLine.textContent.startsWith(`Last recorded use: Recognition, OK · ${timeOf(now + 1000)}`)
  );
  assert.equal(
    groqLine.querySelector("[data-connection-last-failure]").textContent,
    `Last failure: Styles, key rejected · ${timeOf(now)}`
  );
  assert.equal(
    lastUse("gemini").textContent,
    `Last recorded use: Chat, failed, rate limited · ${dateTimeOf(yesterday)}`,
    "a row, with its date when it isn't today"
  );
  assert.equal(entry("openai"), null, "a record for something the page doesn't list shows nowhere");

  // ── A key change cleared them in main: the lines go ─────────────────────
  await act(() => main.emitOutcomes({ outcomes: {} }));
  assert.equal(lastUse("groq"), null);
  assert.equal(lastUse("gemini"), null);
  noRawSecret("after the changes");
  assert.deepEqual(errors, []);
});

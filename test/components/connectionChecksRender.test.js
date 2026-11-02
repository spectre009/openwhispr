const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Connection checks on Settings › AI Connections, rendered for real
// (SettingsModal → SettingsPage → AiConnectionsPage) in happy-dom, with main's
// queue scripted: showing the page checks every saved connection (reusing
// answers younger than ten minutes: shown again within them, nothing is
// sent), the summary says what's checking and then what was found, each card
// and row has its pill (the previous result stays, with a spinner, while a
// Check runs) and a problem box with what to do, the Settings menu's dot
// comes only from a connection a feature uses, and the model picker shows a
// failed check beside the option, which stays pickable.

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

const GROQ_KEY = "gsk_SECRET-groq-RENDER";
const GEMINI_KEY = "AIzaSECRET-gemini-RENDER";

// Main, as the page sees it: every run recorded, answers streamed by the test.
const main = { runs: [], emit: null, calls: [] };

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
    connectionChecksRun: async (request) => {
      main.runs.push(request);
      return { results: {}, pending: request.descriptors.map((descriptor) => descriptor.id) };
    },
    onConnectionCheckResult: (callback) => {
      main.emit = callback;
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
        return (...args) => {
          main.calls.push([name, args]);
          return Promise.resolve(results[name]);
        };
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

test(
  "AI Connections checks every saved connection and flags what a feature uses",
  { timeout: 120000 },
  async (t) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const h = React.createElement;
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-connection-checks-render-",
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
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    t.after(() => {
      console.error = originalError;
      Date.now = realNow;
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
    const render = async (section) => {
      request = { section, id: nextId++ };
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
    const act = async (fn, ms = 30) => {
      await React.act(async () => {
        await fn();
        await settle(ms);
      });
      await settle();
    };
    const page = () => doc.querySelector('[data-settings-page-id="connections"]');
    const entry = (id) => page().querySelector(`[data-setting-id="connections.${id}"]`);
    const summary = () => page().querySelector("[data-connection-health-summary]");
    const pill = (id) => entry(id).querySelector("[data-connection-health]");
    const navFlag = () =>
      doc.querySelector('[data-settings-nav="connections"] [data-settings-nav-flag]');
    const lastRun = () => main.runs.at(-1);
    const descriptorOf = (id) => {
      for (const run of [...main.runs].reverse()) {
        const found = run.descriptors.find((descriptor) => descriptor.id === id);
        if (found) return found;
      }
      return null;
    };
    const answer = (id, fields) =>
      act(() =>
        main.emit({
          id,
          generation: descriptorOf(id).generation,
          result: {
            reachable: true,
            credentials: "accepted",
            models: {},
            proof: "key",
            code: "OK",
            checkedAt: Date.now(),
            generation: descriptorOf(id).generation,
            ...fields,
          },
        })
      );
    const noRawSecret = (when) => {
      const html = doc.documentElement.outerHTML;
      for (const secret of [GROQ_KEY, GEMINI_KEY]) {
        assert.ok(!html.includes(secret), `${when}: ${secret} rendered`);
      }
      assert.ok(!JSON.stringify(main.runs).includes("SECRET"), `${when}: a key went to main`);
    };

    // Settings opens elsewhere first: hydration (keys from main) settles there.
    await render("cleanup");
    assert.equal(main.runs.length, 0, "nothing checked off the page");
    // Groq runs Cleanup (and Note Formatting through it); Gemini is saved, unused.
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

    // ── Showing the page checks every saved connection ───────────────────────
    await render("connections");
    assert.equal(main.runs.length, 1, "one automatic run");
    assert.equal(lastRun().fresh, false);
    assert.equal(lastRun().maxAgeMs, 10 * 60 * 1000);
    assert.deepEqual(
      lastRun().descriptors.map((descriptor) => descriptor.id),
      ["provider:gemini", "provider:groq"],
      "used or not"
    );
    assert.deepEqual(descriptorOf("provider:groq").models, ["llama-3.3-70b-versatile"]);
    assert.equal(summary().getAttribute("data-connection-health-summary"), "muted");
    assert.ok(summary().textContent.includes("Checking 2 connections…"));
    assert.ok(summary().querySelector("[data-connection-check-all]").disabled);
    assert.equal(pill("groq").getAttribute("data-connection-health"), "unchecked");
    assert.ok(pill("groq").hasAttribute("data-checking"));
    assert.ok(pill("groq").textContent.includes("Checking…"));
    noRawSecret("on show");

    // ── Answers: Groq's key rejected, Gemini's works ────────────────────────
    await answer("provider:groq", {
      credentials: "rejected",
      code: "PROVIDER_AUTH_FAILED",
      httpStatus: 401,
      models: { "llama-3.3-70b-versatile": "unknown" },
    });
    await answer("provider:gemini", { httpStatus: 200 });
    assert.equal(summary().getAttribute("data-connection-health-summary"), "danger");
    assert.ok(summary().textContent.includes("1 connection has a problem"));
    assert.ok(
      summary().querySelector('[data-summary-count="working"]').textContent.includes("1 working")
    );
    assert.equal(pill("groq").getAttribute("data-connection-health"), "rejected");
    assert.ok(pill("groq").textContent.startsWith("Key rejected · "));
    assert.equal(pill("gemini").getAttribute("data-connection-health"), "ok");
    assert.ok(pill("gemini").textContent.includes("Key works"));
    const problem = entry("groq").querySelector('[data-connection-problem="rejected"]');
    assert.ok(problem.textContent.includes("Groq didn't accept this key."));
    assert.ok(problem.textContent.includes("Affected: Cleanup"), "names what fails");
    assert.ok(problem.textContent.includes("Key rejected (401)"));
    assert.ok(problem.textContent.includes("api.groq.com reachable"));
    assert.ok(problem.querySelector('[data-problem-action="replaceKey"]'));
    assert.ok(problem.querySelector('[data-problem-action="checkAgain"]'));
    assert.ok([...problem.querySelectorAll("a")].some((link) => link.textContent === "Get a key"));
    assert.equal(
      navFlag().getAttribute("data-settings-nav-flag"),
      "danger",
      "a used connection fails"
    );
    // Replace key opens the key's replace field, empty.
    await act(() => problem.querySelector('[data-problem-action="replaceKey"]').click());
    const field = entry("groq").querySelector("input");
    assert.ok(field, "the replace field");
    assert.equal(field.value, "");
    await act(() => entry("groq").querySelector('button[aria-label="Cancel editing"]').click());
    noRawSecret("with a problem");

    // ── Check: fresh, only this card; the last result stays meanwhile ────────
    await act(() => entry("groq").querySelector("[data-connection-check]").click());
    assert.equal(main.runs.length, 2);
    assert.equal(lastRun().fresh, true);
    assert.deepEqual(
      lastRun().descriptors.map((descriptor) => descriptor.id),
      ["provider:groq"]
    );
    assert.equal(pill("groq").getAttribute("data-connection-health"), "rejected", "kept");
    assert.ok(pill("groq").hasAttribute("data-checking"), "with its spinner");
    assert.ok(entry("groq").querySelector("[data-connection-check]").disabled);
    await answer("provider:groq", { models: { "llama-3.3-70b-versatile": "offered" } });
    assert.equal(pill("groq").getAttribute("data-connection-health"), "ok");
    assert.equal(
      entry("groq")
        .querySelector('[data-usage-feature="cleanup"]')
        .getAttribute("data-model-check"),
      "offered",
      "its model chip gets ✓"
    );
    assert.equal(entry("groq").querySelector("[data-connection-problem]"), null);
    assert.equal(navFlag(), null);
    assert.ok(summary().textContent.includes("All 2 connections work"));

    // ── Shown again within ten minutes: nothing sent ────────────────────────
    await render("cleanup");
    await render("connections");
    assert.equal(main.runs.length, 2, "no run");
    // After ten minutes: checked again, automatically.
    skew += 11 * 60 * 1000;
    await render("cleanup");
    await render("connections");
    assert.equal(main.runs.length, 3);
    assert.equal(lastRun().fresh, false);
    await answer("provider:groq", {});
    assert.ok(
      summary().querySelector("[data-connection-check-all]").disabled,
      "Check all waits for the checks running"
    );
    await answer("provider:gemini", {});

    // ── Check all ───────────────────────────────────────────────────────────
    await act(() => summary().querySelector("[data-connection-check-all]").click());
    assert.equal(lastRun().fresh, true);
    assert.deepEqual(
      lastRun().descriptors.map((descriptor) => descriptor.id),
      ["provider:gemini", "provider:groq"]
    );
    await answer("provider:groq", {});

    // ── An unused connection's failure: a pill and an amber summary, no dot ─
    await answer("provider:gemini", {
      credentials: "rejected",
      code: "PROVIDER_AUTH_FAILED",
      httpStatus: 400,
    });
    assert.equal(pill("gemini").getAttribute("data-connection-health"), "rejected");
    assert.equal(summary().getAttribute("data-connection-health-summary"), "warning");
    assert.equal(navFlag(), null, "nothing uses Gemini");
    assert.ok(
      entry("gemini")
        .querySelector('[data-connection-problem="rejected"]')
        .textContent.includes("no feature is affected")
    );
    // A rate limit on the used one: amber dot.
    await answer("provider:groq", {
      credentials: "unknown",
      code: "PROVIDER_RATE_LIMITED",
      httpStatus: 429,
    });
    assert.equal(navFlag().getAttribute("data-settings-nav-flag"), "warning");

    // ── The model picker: advisory, never unavailable ───────────────────────
    await render("cleanup");
    const trigger = doc.querySelector(
      '[data-settings-page-id="cleanup"] [data-setting-id="dictation.cleanup.model"] [data-model-picker-trigger]'
    );
    assert.ok(
      trigger.textContent.includes("Groq was rate limited (checked"),
      "the pick's own line"
    );
    await act(() => trigger.click());
    const menu = doc.querySelector("[data-model-picker-menu]");
    const advised = [...menu.querySelectorAll("[data-picker-advice]")].map((node) =>
      node.closest('[role="option"]')
    );
    const geminiOptions = advised.filter((option) =>
      option.getAttribute("data-option-id").startsWith("provider:gemini:")
    );
    assert.ok(geminiOptions.length > 0, "Gemini's options carry the check");
    for (const option of geminiOptions) {
      assert.equal(option.getAttribute("aria-disabled"), null, "still pickable");
      assert.ok(option.textContent.includes("Google Gemini's key was rejected (checked"));
      assert.ok(
        option
          .querySelector("[data-picker-advice-link]")
          .textContent.includes("Fix on AI Connections")
      );
    }
    noRawSecret("in the picker");
    assert.deepEqual(errors, []);
  }
);

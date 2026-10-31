const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Renders the real Settings (SettingsModal → SettingsLayer → SettingsPage) in
// happy-dom with a stubbed preload, and opens every page through the same
// destination strings the app uses: each page renders its header and body,
// visited pages stay mounted (hidden), a Preferences block shows on its page
// only, and each feature has one on/off switch, in its header.

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
  // The preload: every call resolves to nothing (or a neutral value below),
  // every subscription returns its cleanup.
  const results = {
    getUpdateStatus: {
      updateAvailable: false,
      updateDownloaded: false,
      isDevelopment: true,
      isSupported: false,
    },
    getUpdateInfo: null,
    getAutoStartEnabled: { enabled: false, requiresApproval: false },
    listGpus: [],
    getAudioStorageUsage: { fileCount: 0, totalBytes: 0 },
    checkWhisperInstallation: { installed: false, working: false },
    getAppVersion: { version: "0.0.0" },
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
  happyWindow.localStorage.setItem("settings.llmsTab", JSON.stringify("dictationTranslation"));
  happyWindow.localStorage.setItem("settings.speechToTextTab", JSON.stringify("upload"));
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
  "every page renders from its destination, and visited pages stay mounted",
  { timeout: 90000 },
  async (t) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const h = React.createElement;
    const path = require("node:path");
    const vite = await createRendererServer(t, {
      resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    });
    const { default: SettingsModal } = await vite.ssrLoadModule("/components/SettingsModal.tsx");
    const { SETTINGS_PAGE_IDS } = await vite.ssrLoadModule("/components/settings/settingsPages.ts");
    const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
    const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");

    // ReasoningService (imported via Prompt Studio) starts its cache cleanup interval on load.
    const { default: reasoningService } = await vite.ssrLoadModule("/services/ReasoningService.ts");
    t.after(() => reasoningService.destroy());

    const errors = [];
    const originalError = console.error;
    console.error = (...args) => {
      const text = args.map(String).join(" ");
      // act() warnings aren't failures here.
      if (!/i18next|not wrapped in act|act\(\.\.\.\)/.test(text)) errors.push(text);
    };
    t.after(() => {
      console.error = originalError;
    });

    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
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

    const doc = happyWindow.document;
    const body = (page) => doc.querySelector(`[data-settings-page-id="${page}"]`);
    const shown = () =>
      [...doc.querySelectorAll("[data-settings-page-id]")]
        .filter((element) => !element.classList.contains("hidden"))
        .map((element) => element.getAttribute("data-settings-page-id"));
    const anchors = (id) => doc.querySelectorAll(`[data-setting-id="${id}"]`).length;

    // A bare legacy "llms" uses the tab Language Models last showed, once.
    let id = 1;
    await render({ section: "llms", id: id++ });
    assert.deepEqual(shown(), ["translation"]);
    assert.equal(happyWindow.localStorage.getItem("settings.llmsTab"), null, "the key is retired");
    assert.equal(happyWindow.localStorage.getItem("settings.speechToTextTab"), null);
    await render({ section: "speechToText", id: id++ });
    assert.deepEqual(shown(), ["fileTranscription"]);
    await render({ section: "llms", id: id++ });
    assert.deepEqual(shown(), ["cleanup"], "used once: the default page now");

    // Every page, by its id; each keeps the ones before it mounted.
    for (const page of SETTINGS_PAGE_IDS) {
      await render({ section: page, id: id++ });
      const expected = ["account", "plansBilling", "workspace"].includes(page)
        ? // Signed out with Cloud on: Workspace falls back to Profile.
          page === "workspace"
          ? "account"
          : page
        : page;
      assert.deepEqual(shown(), [expected], `${page} shows alone`);
      assert.ok(
        body(expected).querySelector("[data-settings-page-header] h2"),
        `${page} has a header`
      );
      assert.ok(body(expected).textContent.trim().length > 0, `${page} has a body`);
    }
    for (const page of SETTINGS_PAGE_IDS) {
      if (page === "workspace") continue;
      assert.ok(body(page), `${page} stayed mounted`);
    }

    // Each feature switch is one control, in the page header.
    for (const settingId of [
      "dictation.cleanup.enabled",
      "assistant.enabled",
      "translation.enabled",
    ]) {
      assert.equal(anchors(settingId), 1, settingId);
      const anchor = doc.querySelector(`[data-setting-id="${settingId}"]`);
      assert.ok(anchor.closest("[data-settings-page-header]"), `${settingId} is in the header`);
      assert.ok(anchor.querySelector('[role="switch"]'));
    }
    // Every Preferences row is rendered once, on its page.
    for (const [settingId, page] of [
      ["preferences.theme", "appearance"],
      ["preferences.uiLanguage", "appearance"],
      ["dictation.language", "recognition"],
      ["dictation.recognition.dictionaryOrder", "recognition"],
      ["dictation.output.autoPaste", "output"],
      ["dictation.output.autoLearn", "output"],
      ["preferences.sounds.dictation", "audio"],
      ["preferences.microphone", "audio"],
      ["preferences.notifications", "notifications"],
      ["preferences.floatingIcon", "floatingIcon"],
      ["preferences.startup.launchAtLogin", "startup"],
      ["notes.files.enabled", "noteFiles"],
      ["notes.import.granola", "noteFiles"],
    ]) {
      assert.equal(anchors(settingId), 1, `${settingId} renders once`);
      assert.ok(
        body(page).querySelector(`[data-setting-id="${settingId}"]`),
        `${settingId} on ${page}`
      );
    }
    assert.ok(body("styles").querySelector('[data-setting-id="dictation.styles"]'));
    assert.equal(body("cleanup").querySelector('[data-setting-id="dictation.styles"]'), null);

    // The breadcrumb and the nav follow the page.
    await render({ section: "meetings", id: id++ });
    assert.deepEqual(shown(), ["noteFormatting"]);
    const crumb = doc.querySelector("[data-settings-layer] header h1").textContent;
    assert.equal(crumb, "SettingsNotes & UploadsNote Formatting");
    assert.equal(
      doc.querySelector('[data-settings-nav="noteFormatting"]').getAttribute("aria-current"),
      "page"
    );
    assert.equal(
      doc.querySelector('[data-settings-nav="notes"]').getAttribute("aria-expanded"),
      "true"
    );
    assert.equal(
      doc.querySelector('[data-settings-nav="cleanup"]'),
      null,
      "Dictation is collapsed"
    );

    assert.deepEqual(errors, [], "nothing logged an error");
  }
);

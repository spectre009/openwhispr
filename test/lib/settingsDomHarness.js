// Shared happy-dom setup for rendering Settings pieces (as settingsPagesRender
// does): DOM globals, a stubbed preload that records every call, and a console
// capture. Each test file runs in its own process, so globals stay per file.

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

const NEUTRAL_RESULTS = {
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

/**
 * Installs happy-dom as the global window. `api` overrides preload methods by
 * name (functions); every other call resolves to a neutral value, every `on*`
 * subscription returns its cleanup (or runs `api`'s, to deliver broadcasts),
 * and each call is recorded in `calls`.
 */
async function installSettingsDom({ api = {}, storage = {} } = {}) {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "http://localhost/" });
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", window);
  for (const name of DOM_GLOBALS) {
    const value = window[name];
    define(name, typeof value === "function" && /^[a-z]/.test(name) ? value.bind(window) : value);
  }
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, window[name].bind(window));
  }
  const calls = [];
  window.electronAPI = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== "string") return undefined;
        if (/^on[A-Z]/.test(name)) {
          return typeof api[name] === "function" ? api[name] : () => () => {};
        }
        return (...args) => {
          calls.push([name, args]);
          if (typeof api[name] === "function") return api[name](...args);
          return Promise.resolve(NEUTRAL_RESULTS[name]);
        };
      },
    }
  );
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => [],
      getUserMedia: async () => ({ getTracks: () => [] }),
      addEventListener() {},
      removeEventListener() {},
    },
  });
  return { window, calls, close: () => window.happyDOM.close() };
}

/** Records console output (and keeps React's act() noise out of `errors`). */
function captureConsole(t) {
  const lines = [];
  const errors = [];
  const original = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    original[level] = console[level];
    console[level] = (...args) => {
      const text = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ");
      lines.push(text);
      if (level === "error" && !/i18next|not wrapped in act|act\(\.\.\.\)/.test(text)) {
        errors.push(text);
      }
    };
  }
  t.after(() => Object.assign(console, original));
  return { lines, errors };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { installSettingsDom, captureConsole, settle };

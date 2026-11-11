const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");
const translations = require("../../src/locales/en/translation.json");

const click = (button) => button.dispatchEvent({ type: "click", bubbles: true, button: 0 });

async function setup(t, electronAPI = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { location: { search: "", pathname: "/" }, electronAPI } });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-toast-settle-",
    // The real card measures itself with ResizeObserver, which the fake DOM lacks.
    mockModules: {
      "/dictation/DictationErrorCard": "export function DictationErrorCard() { return null; }",
    },
  });
  const [{ default: i18n }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  });
  root = createRoot(container);
  return {
    container,
    vite,
    i18n,
    render: async (element) => React.act(async () => root.render(element)),
  };
}

async function renderProvider(h, Child) {
  const { ToastProvider } = await h.vite.ssrLoadModule("/components/ui/Toast.tsx");
  const { useToast } = await h.vite.ssrLoadModule("/components/ui/useToast.ts");
  const probe = {};
  function Probe() {
    probe.context = useToast();
    return Child ? React.createElement(Child, { context: probe.context }) : null;
  }
  await h.render(React.createElement(ToastProvider, null, React.createElement(Probe)));
  return probe;
}

test("a dictation error a newer one replaces settles at once, and only once", async (t) => {
  const h = await setup(t);
  const probe = await renderProvider(h);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const events = [];
  let first;
  await React.act(async () => {
    first = probe.context.toast({
      title: "Transcription failed",
      presentation: "dictation-error",
      duration: 0,
      dismissible: true,
      onSettled: () => events.push("first settled"),
      onRemoved: () => events.push("first removed"),
    });
  });
  await React.act(async () => t.mock.timers.tick(60_000));
  assert.deepEqual(events, [], "a card that stays until dismissed hasn't gone");

  await React.act(async () => {
    probe.context.toast({
      title: "Paste failed",
      presentation: "dictation-error",
      duration: 0,
      dismissible: true,
      onRemoved: () => events.push("second removed"),
    });
  });
  assert.deepEqual(events, ["first settled", "first removed"]);
  assert.equal(probe.context.toastCount, 1);

  await React.act(async () => probe.context.dismiss(first));
  await React.act(async () => t.mock.timers.tick(201));
  assert.deepEqual(events, ["first settled", "first removed"], "the replaced card is gone already");
  assert.equal(probe.context.toastCount, 1);

  await React.act(async () => probe.context.dismissByPresentation("dictation-error"));
  assert.deepEqual(events, ["first settled", "first removed", "second removed"]);
  await React.act(async () => t.mock.timers.tick(201));
  assert.equal(probe.context.toastCount, 0);
});

test("a listener that throws still lets its toast go", async (t) => {
  const h = await setup(t);
  const probe = await renderProvider(h);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let id;
  await React.act(async () => {
    id = probe.context.toast({
      title: "Saved",
      duration: 0,
      onSettled: () => {
        throw new Error("listener failed");
      },
    });
  });
  await React.act(async () => probe.context.dismiss(id));
  await React.act(async () => t.mock.timers.tick(201));
  assert.equal(probe.context.toastCount, 0);
});

test("suggested dictionary words offer Review and Add on the shared card", async (t) => {
  let suggested;
  const calls = [];
  let accept = { success: false };
  const h = await setup(t, {
    onCorrectionsSuggested: (listener) => {
      suggested = listener;
      return () => {};
    },
    openDictionarySuggestions: async () => calls.push("review"),
    acceptDictionarySuggestions: async (ids) => {
      calls.push(["accept", ids]);
      return accept;
    },
  });
  const { useMainProcessNotifications } = await h.vite.ssrLoadModule(
    "/hooks/useMainProcessNotifications.tsx"
  );
  function Notifications({ context }) {
    useMainProcessNotifications({ toast: context.toast, dismiss: context.dismiss, t: h.i18n.t });
    return null;
  }
  const probe = await renderProvider(h, Notifications);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const button = (label) =>
    findElement(h.container, (e) => e.tagName === "BUTTON" && e.textContent.trim() === label);
  const review = translations.app.toasts.reviewSuggestions;
  const add = translations.app.toasts.addSuggested;

  await React.act(async () => suggested([{ id: 7, word: "Kusto" }]));
  assert.ok(button(review) && button(add));

  await React.act(async () => click(button(add)));
  assert.deepEqual(calls, [["accept", [7]]]);
  assert.equal(probe.context.toastCount, 1, "a refused Add keeps the toast");

  accept = { success: true };
  await React.act(async () => click(button(add)));
  await React.act(async () => t.mock.timers.tick(201));
  assert.equal(probe.context.toastCount, 0);

  await React.act(async () => suggested([{ id: 8, word: "Aria" }]));
  await React.act(async () => click(button(review)));
  await React.act(async () => t.mock.timers.tick(201));
  assert.deepEqual(calls.at(-1), "review");
  assert.equal(probe.context.toastCount, 0, "Review opens the Dictionary and closes the toast");
});

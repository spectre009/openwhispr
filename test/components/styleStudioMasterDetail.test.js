const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// Settings › Styles as master–detail (ui/StyleStudio.tsx): the styles listed on
// the left (Plain first, each with how it runs, its keys and its switch), the
// selected style's editor on the right. Selecting, switching a style on or off
// and a request from the Hotkeys page behave as before the layout changed: the
// same selection state, the same store write, the same focus request.

const STYLE = (id, name, emoji, enabled, extra = {}) => ({
  id,
  name,
  emoji,
  instruction: `Write it as ${name}.`,
  enabled,
  runMode: "two-step",
  appGlossary: true,
  examples: [],
  useVoice: false,
  hotkey: null,
  origin: "starter",
  updatedAt: 1,
  ...extra,
});

const LIBRARY = {
  version: 1,
  dictationStyleId: "plain",
  seededStarters: ["starter-teams", "starter-requirements", "starter-email"],
  styles: [
    STYLE("starter-teams", "Teams chat", "💬", true, { hotkey: "Control+Alt+1" }),
    STYLE("starter-requirements", "Requirements", "📋", false),
    STYLE("starter-email", "Email", "✉️", false, { runMode: "one-step" }),
  ],
};

let dom;
test.before(async () => {
  dom = await installSettingsDom({
    api: { getPlatform: () => "win32" },
    storage: { dictationKey: "Control+`", dictationStyles: JSON.stringify(LIBRARY) },
  });
});

test.after(async () => {
  await dom.close();
});

test("Styles lists its styles beside the selected one's editor", { timeout: 90000 }, async (t) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const consoleOutput = captureConsole(t);
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const h = React.createElement;
  const vite = await createRendererServer(t, {
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  await vite.ssrLoadModule("/i18n.ts");
  const { default: StyleStudio } = await vite.ssrLoadModule("/components/ui/StyleStudio.tsx");
  const styleStore = await vite.ssrLoadModule("/stores/styleStore.ts");
  const library = await vite.ssrLoadModule("/config/styles/library.ts");
  // ReasoningService (imported via the style test runs) starts its cache cleanup interval on load.
  const { default: reasoningService } = await vite.ssrLoadModule("/services/ReasoningService.ts");
  t.after(() => reasoningService.destroy());

  const scrolled = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this);
  };

  const doc = dom.window.document;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  const act = async (fn, ms = 30) => {
    await React.act(async () => {
      await fn();
      await settle(ms);
    });
    await settle();
  };
  await act(() => root.render(h(StyleStudio)));

  const rows = () => [...doc.querySelectorAll("[data-style-row]")];
  const rowButton = (id) => doc.querySelector(`[data-style-row="${id}"] > button`);
  const detail = () => doc.querySelector("[data-style-detail]");
  const record = () => JSON.parse(dom.window.localStorage.getItem("dictationStyles"));

  // Master–detail: the list, then the editor, side by side on a wide container.
  const list = doc.querySelector('[data-setting-id="dictation.styles.list"]');
  const grid = list.parentElement;
  assert.match(grid.className, /@3xl:grid-cols-\[260px_minmax\(0,1fr\)\]/);
  assert.equal(grid.children[0], list);
  assert.equal(grid.children[1], detail());
  assert.ok(grid.parentElement.className.includes("@container"));

  // Plain first (built in, cleanup only, the dictation hotkey's style), then the styles.
  assert.deepEqual(
    rows().map((row) => row.getAttribute("data-style-row")),
    ["plain", "starter-teams", "starter-requirements", "starter-email"]
  );
  const plain = rows()[0];
  assert.match(plain.textContent, /Plain/);
  assert.match(plain.textContent, /Cleanup only/);
  assert.match(plain.textContent, /In use/);
  assert.equal(plain.querySelector("kbd").textContent, "Ctrl+`");
  assert.equal(plain.querySelector('[role="switch"]'), null, "Plain is always on");
  const teams = rows()[1];
  assert.match(teams.textContent, /💬/);
  assert.match(teams.textContent, /Two steps/);
  assert.equal(teams.querySelector("kbd").textContent, "Ctrl+Alt+1");
  assert.equal(teams.querySelector('[role="switch"]').getAttribute("aria-checked"), "true");
  assert.match(rows()[3].textContent, /One step/);
  assert.equal(rows()[2].querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
  assert.match(
    [...list.querySelectorAll("button")].at(-1).textContent,
    /New style/,
    "New style ends the list"
  );

  // Plain is selected first; the detail says what it is.
  assert.equal(detail().getAttribute("data-style-detail"), "plain");
  assert.equal(rowButton("plain").getAttribute("aria-current"), "true");
  assert.match(detail().textContent, /Built-in/);

  // Selecting a row selects the style and shows its View tab.
  await act(() => rowButton("starter-teams").click());
  assert.equal(detail().getAttribute("data-style-detail"), "starter-teams");
  assert.equal(rowButton("starter-teams").getAttribute("aria-current"), "true");
  assert.equal(rowButton("plain").hasAttribute("aria-current"), false);
  assert.match(detail().textContent, /Teams chat/);
  assert.match(detail().textContent, /Write it as Teams chat\./);
  const before = record();
  assert.deepEqual(
    before.styles.map((style) => style.enabled),
    [true, false, false]
  );
  assert.deepEqual(record(), before, "selecting writes nothing");

  // The switch writes what saveStyle(id, { enabled }) wrote before, and only that.
  const expected = JSON.parse(JSON.stringify(before));
  assert.equal(library.updateStyle(expected, "starter-requirements", { enabled: true }), true);
  await act(() => rows()[2].querySelector('[role="switch"]').click());
  const after = record();
  const withoutTimes = (value) => ({
    ...value,
    styles: value.styles.map((style) => ({ ...style, updatedAt: 0 })),
  });
  assert.deepEqual(withoutTimes(after), withoutTimes(expected));
  assert.deepEqual(styleStore.useStyleStore.getState().library.styles[1].enabled, true);
  assert.equal(
    detail().getAttribute("data-style-detail"),
    "starter-teams",
    "switching another style doesn't change the selection"
  );

  // The Hotkeys page's request: selects the style, back on View, scrolls and focuses its row.
  const customize = [...detail().querySelectorAll("button")].find((button) =>
    /Customize/.test(button.textContent)
  );
  await act(() => customize.click());
  scrolled.length = 0;
  await act(() => styleStore.requestStyleFocus("starter-email"), 150);
  assert.equal(detail().getAttribute("data-style-detail"), "starter-email");
  assert.equal(rowButton("starter-email").getAttribute("aria-current"), "true");
  assert.match(detail().textContent, /Write it as Email\./, "the View tab shows");
  assert.equal(scrolled.length, 1, "scrolled once");
  assert.ok(scrolled[0].contains(list), "to the styles");
  assert.equal(doc.activeElement, rowButton("starter-email"), "the row has focus");
  assert.equal(styleStore.useStyleStore.getState().focusStyleId, null, "the request is spent");

  // The list request scrolls to the styles and keeps the selection.
  scrolled.length = 0;
  await act(() => styleStore.requestStyleFocus(styleStore.STYLE_LIST_FOCUS), 150);
  assert.equal(scrolled.length, 1);
  assert.equal(detail().getAttribute("data-style-detail"), "starter-email");

  // New style opens an empty editor on the right.
  const newStyle = [...list.querySelectorAll("button")].at(-1);
  await act(() => newStyle.click());
  assert.equal(detail().getAttribute("data-style-detail"), "__new__");
  assert.equal(newStyle.getAttribute("aria-pressed"), "true");
  assert.deepEqual(withoutTimes(record()), withoutTimes(expected), "still nothing saved");

  assert.deepEqual(consoleOutput.errors, [], "nothing logged an error");
});

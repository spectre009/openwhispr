const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Renders the real Settings layer shell and its controller in happy-dom, with a
// Radix popover and a ConfirmDialog in the content, the way SettingsPage has
// them. The app region beside it goes inert while Settings is open, as in
// ControlPanel.

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
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
  // Radix FocusScope walks tabbables with a TreeWalker.
  "NodeFilter",
];

let happyWindow;

test.before(async () => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window({ url: "http://localhost/" });
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function mountSettings(t) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const h = React.createElement;
  const vite = await createRendererServer(t);
  const { default: SettingsLayer } = await vite.ssrLoadModule(
    "/components/settings/SettingsLayer.tsx"
  );
  const { useSettingsLayerController } = await vite.ssrLoadModule(
    "/components/settings/useSettingsLayerController.ts"
  );
  const { useSettingsVisible } = await vite.ssrLoadModule(
    "/components/settings/useSettingsVisible.ts"
  );
  const { Popover, PopoverTrigger, PopoverContent } = await vite.ssrLoadModule(
    "/components/ui/popover.tsx"
  );
  const { ConfirmDialog } = await vite.ssrLoadModule("/components/ui/dialog.tsx");

  const api = { mounts: 0, unmounts: 0, visible: [], view: null };
  const NoIcon = () => null;

  function Body() {
    const visible = useSettingsVisible();
    const [draft, setDraft] = React.useState("");
    const [popoverOpen, setPopoverOpen] = React.useState(false);
    const [dialogOpen, setDialogOpen] = React.useState(false);
    const [capturing, setCapturing] = React.useState(false);
    Object.assign(api, { draft, setDraft, setPopoverOpen, setDialogOpen, setCapturing });
    api.popoverOpen = popoverOpen;
    api.dialogOpen = dialogOpen;
    React.useEffect(() => {
      api.mounts++;
      return () => {
        api.unmounts++;
      };
    }, []);
    React.useEffect(() => {
      api.visible.push(visible);
    }, [visible]);
    return h(
      "div",
      null,
      h("input", { id: "field", defaultValue: "" }),
      h(
        Popover,
        { open: popoverOpen, onOpenChange: setPopoverOpen },
        h(PopoverTrigger, { id: "popover-trigger" }, "Info"),
        h(PopoverContent, null, h("button", { id: "in-popover" }, "inside"))
      ),
      h(ConfirmDialog, {
        open: dialogOpen,
        onOpenChange: setDialogOpen,
        title: "Delete?",
        onConfirm: () => {},
      }),
      capturing ? h("div", { "data-capturing": "true", tabIndex: 0, id: "capture" }) : null
    );
  }

  function Harness() {
    const settings = useSettingsLayerController();
    api.settings = settings;
    return h(
      "div",
      { id: "region" },
      h(
        "main",
        { id: "app", inert: settings.open, "aria-hidden": settings.open || undefined },
        h("button", { id: "opener", onClick: () => settings.openSettings() }, "Settings")
      ),
      settings.mounted &&
        h(
          SettingsLayer,
          {
            open: settings.open,
            onRequestClose: () => settings.closeSettings(),
            railItems: [
              { id: "home", label: "Home", icon: NoIcon },
              { id: "personal-notes", label: "Notes", icon: NoIcon },
            ],
            activeView: "personal-notes",
            onSelectView: (view) => {
              if (settings.closeSettings()) api.view = view;
            },
            onOpenSearch: () => {},
            navItems: [
              { id: "general", label: "Preferences", icon: NoIcon, group: "App" },
              { id: "hotkeys", label: "Hotkeys", icon: NoIcon, group: "App" },
            ],
            activeSection: "general",
            sectionLabel: "Preferences",
            onSectionChange: () => {},
            navigationKey: 0,
            returnFocusRef: settings.returnFocusRef,
            getFallbackFocus: () => happyWindow.document.getElementById("opener"),
          },
          h(Body)
        )
    );
  }

  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  const act = async (callback) => {
    await React.act(async () => {
      await callback();
      await settle();
    });
    await settle();
  };
  await act(() => root.render(h(Harness)));

  const doc = happyWindow.document;
  const layer = () => doc.querySelector("[data-settings-layer]");
  const byId = (id) => doc.getElementById(id);
  const backButton = () =>
    [...layer().querySelectorAll("button")].find((button) =>
      button.textContent.includes("settingsLayer.backTo")
    );
  const pressEscape = () =>
    (doc.activeElement ?? doc.body).dispatchEvent(
      new happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
  const popupOpen = () =>
    doc.querySelector("[data-radix-popper-content-wrapper] [data-state='open']") !== null;
  const open = async () => {
    byId("opener").focus();
    await act(() => byId("opener").click());
  };
  return { api, act, layer, byId, backButton, pressEscape, popupOpen, open, doc };
}

test("Settings stays mounted when closed, hidden and inert, and keeps its state", async (t) => {
  const s = await mountSettings(t);
  assert.equal(s.layer(), null, "nothing is mounted before the first open");

  await s.open();
  assert.ok(s.layer());
  assert.equal(s.api.mounts, 1);
  await s.act(() => s.api.setDraft("unsaved prompt"));

  await s.act(() => s.backButton().click());
  assert.equal(s.api.settings.open, false);
  assert.ok(s.layer(), "still mounted after closing");
  assert.ok(s.layer().className.split(/\s+/).includes("hidden"));
  assert.ok(s.layer().hasAttribute("inert"));

  await s.open();
  assert.equal(s.api.mounts, 1, "reopening does not remount the content");
  assert.equal(s.api.unmounts, 0);
  assert.equal(s.api.draft, "unsaved prompt");
  assert.ok(!s.layer().className.split(/\s+/).includes("hidden"));
  assert.ok(!s.layer().hasAttribute("inert"));
  assert.deepEqual(s.api.visible, [true, false, true], "useSettingsVisible follows open");
});

test("the app beside Settings is inert only while it is open", async (t) => {
  const s = await mountSettings(t);
  assert.ok(!s.byId("app").hasAttribute("inert"));
  await s.open();
  assert.ok(s.byId("app").hasAttribute("inert"));
  assert.equal(s.byId("app").getAttribute("aria-hidden"), "true");
  await s.act(() => s.backButton().click());
  assert.ok(!s.byId("app").hasAttribute("inert"));
  assert.ok(!s.byId("app").hasAttribute("aria-hidden"));
});

test("leaving Settings closes an open popup first, then Settings", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  await s.act(() => s.api.setPopoverOpen(true));
  assert.ok(s.popupOpen(), "the popover is open");

  await s.act(() => s.backButton().click());
  assert.equal(s.api.popoverOpen, false, "Back closed the popover");
  assert.equal(s.api.settings.open, true, "and kept Settings open");

  await s.act(() => s.backButton().click());
  assert.equal(s.api.settings.open, false);
});

test("the rail closes a popup first, then leaves for the view", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  await s.act(() => s.api.setPopoverOpen(true));
  const home = s.layer().querySelector('button[aria-label="Home"]');
  await s.act(() => home.click());
  assert.equal(s.api.popoverOpen, false);
  assert.equal(s.api.settings.open, true);
  assert.equal(s.api.view, null);

  await s.act(() => home.click());
  assert.equal(s.api.settings.open, false);
  assert.equal(s.api.view, "home");
});

test("a modal dialog in Settings refuses every way out", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  await s.act(() => s.api.setDialogOpen(true));

  await s.act(() => s.backButton().click());
  assert.equal(s.api.settings.open, true);
  assert.equal(s.api.dialogOpen, true, "the dialog is never dismissed for Settings");

  let closed;
  await s.act(() => {
    closed = s.api.settings.closeSettings();
  });
  assert.equal(closed, false);
  assert.equal(s.api.settings.open, true);
});

test("Esc closes the popover, and only the next Esc closes Settings", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  await s.act(() => s.api.setPopoverOpen(true));
  assert.ok(s.popupOpen());
  await s.act(() => s.pressEscape());
  assert.equal(s.api.popoverOpen, false);
  assert.equal(s.api.settings.open, true);

  await s.act(() => s.pressEscape());
  assert.equal(s.api.settings.open, false);
});

test("Esc closes the dialog, not Settings", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  await s.act(() => s.api.setDialogOpen(true));
  assert.ok(s.doc.querySelector('[role="dialog"][data-state="open"]'));
  await s.act(() => s.pressEscape());
  assert.equal(s.api.dialogOpen, false);
  assert.equal(s.api.settings.open, true);
});

test("Esc leaves a text field first, and does nothing during a hotkey capture", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  s.byId("field").focus();
  await s.act(() => s.pressEscape());
  assert.notEqual(s.doc.activeElement, s.byId("field"));
  assert.equal(s.api.settings.open, true);

  await s.act(() => s.api.setCapturing(true));
  s.byId("capture").focus();
  await s.act(() => s.pressEscape());
  assert.equal(s.api.settings.open, true, "Esc may be the key being captured");

  await s.act(() => s.api.setCapturing(false));
  await s.act(() => s.pressEscape());
  assert.equal(s.api.settings.open, false);
});

test("focus moves into Settings on open and back to the opener on close", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  assert.equal(s.doc.activeElement, s.layer(), "the layer itself, not its first button");
  await s.act(() => s.pressEscape());
  assert.equal(s.api.settings.open, false);
  assert.equal(s.doc.activeElement, s.byId("opener"));
});

test("a palette result leaves Settings even though the palette is still open", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  const palette = s.doc.createElement("div");
  palette.setAttribute("role", "dialog");
  palette.setAttribute("data-state", "open");
  palette.setAttribute("data-command-palette", "");
  s.doc.body.appendChild(palette);
  t.after(() => palette.remove());

  let closed;
  await s.act(() => {
    closed = s.api.settings.closeSettings();
  });
  assert.equal(closed, false, "Ctrl+, under the palette is refused");

  await s.act(() => {
    closed = s.api.settings.closeSettings({ ignore: palette });
  });
  assert.equal(closed, true);
  assert.equal(s.api.settings.open, false);
});

test("Ctrl+, toggles: a bare open keeps the page, a second press closes", async (t) => {
  const s = await mountSettings(t);
  await s.act(() => s.api.settings.toggleSettings());
  assert.equal(s.api.settings.open, true);
  assert.equal(s.api.settings.request, null, "a bare open makes no navigation request");
  await s.act(() => s.api.settings.openSettings("meetings"));
  assert.deepEqual(s.api.settings.request, { section: "meetings", id: 1 });
  await s.act(() => s.api.settings.openSettings("meetings"));
  assert.deepEqual(s.api.settings.request, { section: "meetings", id: 2 });
  await s.act(() => s.api.settings.toggleSettings());
  assert.equal(s.api.settings.open, false);
});

// ControlPanel is too large to render here, so its wiring is read from source:
// the layer is a sibling of the inert sidebar and <main>, mounted once and
// never keyed (a key would remount it, losing drafts), and every request for
// Settings goes through the controller.
test("ControlPanel keeps the app inert under Settings and the layer mounted", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (file) => fs.readFileSync(path.join(__dirname, "../../src", file), "utf8");
  const panel = read("components/ControlPanel.tsx");

  const sidebar = panel.match(/<div\s+ref=\{sidebarContainerRef\}[\s\S]*?>/)?.[0] ?? "";
  assert.match(sidebar, /inert=\{showSettings\}/);
  assert.match(sidebar, /aria-hidden=\{showSettings \|\| undefined\}/);
  const main = panel.match(/<main\s[\s\S]*?>/)?.[0] ?? "";
  assert.match(main, /inert=\{showSettings\}/);
  assert.match(main, /aria-hidden=\{showSettings \|\| undefined\}/);

  const afterMain = panel.slice(panel.indexOf("</main>"));
  assert.match(
    afterMain,
    /\{settingsMounted && \(\s*<Suspense fallback=\{null\}>\s*<SettingsModal/
  );
  const modal = afterMain.match(/<SettingsModal[\s\S]*?\/>/)?.[0] ?? "";
  assert.doesNotMatch(modal, /\bkey=/);
  assert.doesNotMatch(panel, /setShowSettings|setSettingsSection/);

  // The markers the close rules look for are the ones the components render.
  assert.match(read("components/settings/SettingsLayer.tsx"), /data-settings-layer=""/);
  assert.match(read("components/CommandSearch.tsx"), /data-command-palette=""/);
  const policy = read("components/settings/settingsLayerPolicy.ts");
  assert.match(policy, /SETTINGS_LAYER_ATTRIBUTE = "data-settings-layer"/);
  assert.match(policy, /COMMAND_PALETTE_ATTRIBUTE = "data-command-palette"/);

  // Each palette result leaves Settings before revealing what was picked.
  for (const callback of ["onNoteSelect", "onContainerSelect", "onTranscriptSelect"]) {
    const body = panel.match(new RegExp(`${callback}=\\{[^{]*\\{([\\s\\S]*?)\\n {10}\\}\\}`))?.[1];
    assert.ok(body, `${callback} is wired`);
    assert.match(body.trim(), /^closeSettingsForPalette\(\);/, `${callback} leaves Settings first`);
  }
});

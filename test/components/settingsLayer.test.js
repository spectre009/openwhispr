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
  "localStorage",
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

async function mountSettings(t, { page: initialPage = "recognition", layerWidth = null } = {}) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (layerWidth !== null) {
    // Every observed element reports this width: the layer's, so the nav folds to icons below 900.
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        setTimeout(() => this.callback([{ target, contentRect: { width: layerWidth } }], this));
      }
      disconnect() {}
    };
    t.after(() => {
      globalThis.ResizeObserver = original;
    });
  }
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
      // A table's search marks itself while it has a query, so Esc clears it (#2959).
      h("input", { id: "clearing-field", defaultValue: "query", "data-escape-clears": "" }),
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
    const [search, setSearch] = React.useState(null);
    const [page, setPage] = React.useState(initialPage);
    const [navigationKey, setNavigationKey] = React.useState(0);
    api.settings = settings;
    api.setSearch = setSearch;
    api.search = search;
    api.page = page;
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
            navGroups: [
              {
                id: "features",
                label: "Features",
                items: [
                  {
                    id: "dictation",
                    label: "Dictation",
                    icon: NoIcon,
                    page: "recognition",
                    children: [
                      { id: "recognition", label: "Recognition", icon: NoIcon },
                      { id: "cleanup", label: "Cleanup", icon: NoIcon },
                    ],
                  },
                  { id: "translation", label: "Translation", icon: NoIcon, page: "translation" },
                ],
              },
              {
                id: "elsewhere",
                label: "Elsewhere",
                items: [
                  {
                    id: "dictionary",
                    label: "Dictionary & Glossary",
                    icon: NoIcon,
                    onSelect: () => {
                      api.elsewhere = "dictionary";
                    },
                  },
                ],
              },
            ],
            activePage: page,
            breadcrumb: page === "translation" ? ["Features", "Translation"] : ["Dictation", page],
            onNavigate: (next) => {
              setPage(next);
              setNavigationKey((key) => key + 1);
            },
            navigationKey,
            returnFocusRef: settings.returnFocusRef,
            getFallbackFocus: () => happyWindow.document.getElementById("opener"),
            navTop: h("input", { id: "search-field" }),
            header: h("div", { id: "nav-header" }, "Workspace picker"),
            compactHeader: h("div", { id: "nav-compact-header" }, "W"),
            searchActive: !!search,
            onClearSearch: () => setSearch(null),
            onFocusSearch: () => happyWindow.document.getElementById("search-field")?.focus(),
            searchResults: search ? h("div", { id: "results" }, search) : undefined,
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

test("Esc in a field that clears on Esc is left to the field: Settings neither blurs nor closes", async (t) => {
  // Upstream's SidebarModal test (#2959) for the Settings layer: Radix saw Esc on the
  // document before the field's own handler; the layer asks the field the same way.
  const s = await mountSettings(t);
  await s.open();
  s.byId("clearing-field").focus();
  await s.act(() => s.pressEscape());
  assert.equal(s.doc.activeElement, s.byId("clearing-field"), "focus stays in the field");
  assert.equal(s.api.settings.open, true);

  // An unmarked field still gives up focus, and the next Esc leaves Settings.
  s.byId("field").focus();
  await s.act(() => s.pressEscape());
  assert.notEqual(s.doc.activeElement, s.byId("field"));
  assert.equal(s.api.settings.open, true);
  await s.act(() => s.pressEscape());
  assert.equal(s.api.settings.open, false);
});

test("the nav's header shows above the pages, and its compact form in the icon nav", async (t) => {
  const wide = await mountSettings(t);
  await wide.open();
  assert.ok(wide.layer().querySelector("#nav-header"));
  assert.equal(wide.layer().querySelector("#nav-compact-header"), null);
});

test("the icon nav shows the compact header in the header's place", async (t) => {
  const narrow = await mountSettings(t, { layerWidth: 800 });
  await narrow.open();
  await narrow.act(() => {});
  assert.equal(narrow.layer().querySelector("#nav-header"), null);
  assert.ok(narrow.layer().querySelector("#nav-compact-header"));
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

test("search results replace the page, which stays mounted with its drafts", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  await s.act(() => s.api.setDraft("half-written prompt"));
  const page = s.layer().querySelector("[data-settings-page]");
  assert.ok(page.contains(s.byId("field")), "the page sits in its own wrapper");

  await s.act(() => s.api.setSearch("theme"));
  assert.ok(s.byId("results"), "the results show in the content column");
  assert.ok(page.className.split(/\s+/).includes("hidden"), "the page is hidden, not unmounted");
  assert.equal(s.api.mounts, 1);
  assert.equal(s.api.unmounts, 0);

  await s.act(() => s.api.setSearch(null));
  assert.equal(s.byId("results"), null);
  assert.ok(!page.className.split(/\s+/).includes("hidden"));
  assert.equal(s.api.draft, "half-written prompt");
  assert.ok(s.layer().querySelector("[data-settings-scroller]"), "reveal finds the scroller");
});

test("Ctrl+F and / focus the search field; / still types in a text field", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  const press = (target, init) =>
    target.dispatchEvent(
      new happyWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    );

  s.layer().focus();
  await s.act(() => press(s.layer(), { key: "/" }));
  assert.equal(s.doc.activeElement, s.byId("search-field"));

  s.byId("field").focus();
  let event;
  await s.act(() => {
    event = new happyWindow.KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    s.byId("field").dispatchEvent(event);
  });
  assert.equal(s.doc.activeElement, s.byId("field"), "/ types in the field");
  assert.equal(event.defaultPrevented, false);

  await s.act(() => press(s.byId("field"), { key: "f", ctrlKey: true }));
  assert.equal(s.doc.activeElement, s.byId("search-field"), "Ctrl+F works from a field too");

  // Not while a popup is open over Settings.
  s.byId("field").focus();
  await s.act(() => s.api.setPopoverOpen(true));
  await s.act(() => press(s.doc.activeElement ?? s.doc.body, { key: "f", ctrlKey: true }));
  assert.notEqual(s.doc.activeElement, s.byId("search-field"));
});

test("Esc clears an active search before it leaves Settings", async (t) => {
  const s = await mountSettings(t);
  await s.open();
  await s.act(() => s.api.setSearch("theme"));
  s.layer().focus();
  await s.act(() => s.pressEscape());
  assert.equal(s.api.search, null, "the first Esc clears the search");
  assert.equal(s.api.settings.open, true);
  await s.act(() => s.pressEscape());
  assert.equal(s.api.settings.open, false);
});

test("the nav lists an open parent's pages, marks the page, and links out", async (t) => {
  localStorage.clear();
  const s = await mountSettings(t);
  await s.open();
  const nav = (id) => s.layer().querySelector(`[data-settings-nav="${id}"]`);
  const toggle = (id) => s.layer().querySelector(`[data-settings-nav-toggle="${id}"]`);
  const header = () => s.layer().querySelector("header h1").textContent;

  // Dictation › Recognition is open: its pages show, Recognition is the page.
  assert.equal(toggle("dictation").getAttribute("aria-expanded"), "true");
  assert.equal(nav("recognition").getAttribute("aria-current"), "page");
  assert.equal(nav("dictation").hasAttribute("aria-current"), false, "its page row is the page");
  assert.equal(nav("dictation").hasAttribute("aria-expanded"), false, "the chevron has it");
  assert.equal(nav("cleanup").closest("[hidden]"), null);
  assert.match(header(), /settingsModal\.title.*Dictation.*recognition/);

  await s.act(() => nav("cleanup").click());
  assert.equal(s.api.page, "cleanup");
  assert.equal(nav("cleanup").getAttribute("aria-current"), "page");
  assert.equal(nav("recognition").hasAttribute("aria-current"), false);

  // A page elsewhere moves only the highlight: Dictation stays open.
  await s.act(() => nav("translation").click());
  assert.equal(s.api.page, "translation");
  assert.equal(toggle("dictation").getAttribute("aria-expanded"), "true");
  assert.equal(nav("cleanup").closest("[hidden]"), null, "nothing folds under the pointer");
  assert.equal(nav("cleanup").hasAttribute("aria-current"), false);
  assert.equal(nav("translation").getAttribute("aria-current"), "page");
  assert.match(header(), /Features.*Translation/);

  // A parent's name opens its first page.
  await s.act(() => nav("dictation").click());
  assert.equal(s.api.page, "recognition");

  // Group labels head their items; Elsewhere links leave Settings, not navigate.
  const groups = [...s.layer().querySelectorAll('nav [role="group"]')];
  assert.deepEqual(
    groups.map((group) => group.getAttribute("aria-label")),
    ["Features", "Elsewhere"]
  );
  await s.act(() => nav("dictionary").click());
  assert.equal(s.api.elsewhere, "dictionary");
  assert.equal(s.api.page, "recognition");
});

test("a parent's chevron opens and closes it; closed around the page, the parent row is the page", async (t) => {
  localStorage.clear();
  const s = await mountSettings(t);
  await s.open();
  const nav = (id) => s.layer().querySelector(`[data-settings-nav="${id}"]`);
  const toggle = (id) => s.layer().querySelector(`[data-settings-nav-toggle="${id}"]`);
  const pages = () => s.doc.getElementById(toggle("dictation").getAttribute("aria-controls"));

  assert.equal(toggle("dictation").tagName, "BUTTON");
  assert.notEqual(toggle("dictation"), nav("dictation"), "its own button, beside the name");
  assert.equal(toggle("dictation").getAttribute("aria-label"), "settingsLayer.hidePages");
  assert.ok(pages().contains(nav("cleanup")), "aria-controls names the pages' list");
  assert.equal(pages().hidden, false);

  // Closed while inside it: the pages hide and the parent row stands in for Recognition.
  await s.act(() => toggle("dictation").click());
  assert.equal(s.api.page, "recognition", "the chevron never navigates");
  assert.equal(toggle("dictation").getAttribute("aria-expanded"), "false");
  assert.equal(toggle("dictation").getAttribute("aria-label"), "settingsLayer.showPages");
  assert.equal(pages().hidden, true);
  assert.equal(nav("dictation").getAttribute("aria-current"), "page");
  assert.equal(nav("recognition").hasAttribute("aria-current"), false);
  assert.deepEqual(JSON.parse(localStorage.getItem("settings.navOpenParents")), []);

  // Leaving keeps it closed; going back in (its name) opens it.
  await s.act(() => nav("translation").click());
  assert.equal(nav("dictation").hasAttribute("aria-current"), false);
  assert.equal(toggle("dictation").getAttribute("aria-expanded"), "false");
  await s.act(() => nav("dictation").click());
  assert.equal(s.api.page, "recognition");
  assert.equal(toggle("dictation").getAttribute("aria-expanded"), "true");
  assert.equal(nav("recognition").getAttribute("aria-current"), "page");
  assert.deepEqual(JSON.parse(localStorage.getItem("settings.navOpenParents")), ["dictation"]);

  // Reopened by hand from elsewhere, it stays open.
  await s.act(() => nav("translation").click());
  await s.act(() => toggle("dictation").click());
  await s.act(() => toggle("dictation").click());
  assert.equal(toggle("dictation").getAttribute("aria-expanded"), "true");
  assert.equal(s.api.page, "translation");
});

test("the open parents are remembered: one closed by hand stays closed on the next start", async (t) => {
  localStorage.setItem("settings.navOpenParents", JSON.stringify([]));
  const s = await mountSettings(t, { page: "translation" });
  await s.open();
  const toggle = s.layer().querySelector('[data-settings-nav-toggle="dictation"]');
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("the open parents: Dictation open the first time", async (t) => {
  localStorage.clear();
  const s = await mountSettings(t, { page: "translation" });
  await s.open();
  const toggle = s.layer().querySelector('[data-settings-nav-toggle="dictation"]');
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
});

test("the open parents: a start inside a closed parent opens it; unknown ids are dropped", async (t) => {
  localStorage.setItem("settings.navOpenParents", JSON.stringify(["somethingElse"]));
  const s = await mountSettings(t);
  await s.open();
  const toggle = s.layer().querySelector('[data-settings-nav-toggle="dictation"]');
  assert.equal(toggle.getAttribute("aria-expanded"), "true", "going into Recognition opens it");
  assert.deepEqual(JSON.parse(localStorage.getItem("settings.navOpenParents")), ["dictation"]);
});

test("the icon nav below 900 px: the same chevron, the same rules", async (t) => {
  localStorage.clear();
  const s = await mountSettings(t, { layerWidth: 800 });
  await s.open();
  await s.act(() => {});
  const nav = (id) => s.layer().querySelector(`[data-settings-nav="${id}"]`);
  const toggle = (id) => s.layer().querySelector(`[data-settings-nav-toggle="${id}"]`);
  assert.equal(nav("dictation").getAttribute("aria-label"), "Dictation", "icons only");
  assert.equal(nav("cleanup").getAttribute("aria-label"), "Cleanup");
  assert.equal(toggle("dictation").getAttribute("aria-expanded"), "true");

  await s.act(() => nav("translation").click());
  assert.equal(toggle("dictation").getAttribute("aria-expanded"), "true", "leaving keeps it open");
  await s.act(() => nav("cleanup").click());
  await s.act(() => toggle("dictation").click());
  assert.equal(nav("cleanup").closest("[hidden]") !== null, true);
  assert.equal(nav("dictation").getAttribute("aria-current"), "page");
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
  // A Settings result chosen in the palette leaves focus in Settings, not on <body>.
  assert.match(
    read("components/CommandSearch.tsx"),
    /onCloseAutoFocus=\{\(event\) => \{[\s\S]*?settingOpenedRef\.current[\s\S]*?event\.preventDefault\(\);\s*focusSettingsAfterPalette\(document\);/
  );
  const policy = read("components/settings/settingsLayerPolicy.ts");
  assert.match(policy, /SETTINGS_LAYER_ATTRIBUTE = "data-settings-layer"/);
  assert.match(policy, /COMMAND_PALETTE_ATTRIBUTE = "data-command-palette"/);

  // Each palette result leaves Settings before revealing what was picked.
  for (const callback of ["onNoteSelect", "onContainerSelect", "onTranscriptSelect"]) {
    const body = panel.match(new RegExp(`${callback}=\\{[^{]*\\{([\\s\\S]*?)\\n {10}\\}\\}`))?.[1];
    assert.ok(body, `${callback} is wired`);
    assert.match(body.trim(), /^closeSettingsForPalette\(\);/, `${callback} leaves Settings first`);
  }
  // A Settings result opens Settings at it, or leaves it (past the palette) for an app page.
  const settingSelect = panel.match(/onSettingSelect=\{[^{]*\{([\s\S]*?)\n {10}\}\}/)?.[1] ?? "";
  assert.match(settingSelect, /openElsewhere\(action\.location, true\)/);
  assert.match(settingSelect, /openSettings\(action\.destination\)/);
  assert.match(panel, /fromPalette \? closeSettingsForPalette\(\) : closeSettings\(\)/);
  assert.match(panel, /onOpenElsewhere=\{openElsewhere\}/);
});

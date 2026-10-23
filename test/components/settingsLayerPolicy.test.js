const test = require("node:test");
const assert = require("node:assert/strict");

// The rules every way out of Settings goes through: what counts as an open
// popup or dialog (Radix portals them into the body, outside the layer), the
// Esc order, and where focus goes once Settings hides.

let happyWindow;
let policy;

test.before(async () => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window();
  const mod = await import("../../src/components/settings/settingsLayerPolicy.ts");
  policy = mod.default ?? mod;
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

function freshDocument() {
  const document = happyWindow.document;
  document.body.innerHTML = "";
  return document;
}

function html(document, markup) {
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.appendChild(host);
  return host;
}

const LAYER = `<section data-settings-layer=""><input id="field" /><button id="inside">x</button></section>`;

test("one Esc does one thing, in order", () => {
  const { decideSettingsEscape } = policy;
  const base = {
    composing: false,
    capturing: false,
    overlayOpen: false,
    handled: false,
    editableFocused: false,
    searchActive: false,
  };
  assert.equal(decideSettingsEscape(base), "close");
  assert.equal(decideSettingsEscape({ ...base, searchActive: true }), "clearSearch");
  assert.equal(
    decideSettingsEscape({ ...base, searchActive: true, editableFocused: true }),
    "blur"
  );
  for (const blocker of ["overlayOpen", "capturing", "composing", "handled"]) {
    assert.equal(
      decideSettingsEscape({ ...base, [blocker]: true, editableFocused: true, searchActive: true }),
      "none",
      blocker
    );
  }
  // A popup that didn't take the key (focus elsewhere) is closed; one that did isn't.
  assert.equal(
    decideSettingsEscape({ ...base, overlayOpen: true, popupOpen: true, editableFocused: true }),
    "dismissPopup"
  );
  assert.equal(
    decideSettingsEscape({ ...base, overlayOpen: true, popupOpen: true, handled: true }),
    "none"
  );
});

test("a modal dialog or a capture keeps Settings open; a popup closes first", () => {
  const { decideSettingsClose } = policy;
  const none = { dialog: false, popup: false };
  assert.equal(decideSettingsClose({ capturing: false, overlays: none }), "close");
  assert.equal(
    decideSettingsClose({ capturing: false, overlays: { dialog: false, popup: true } }),
    "dismissPopup"
  );
  assert.equal(
    decideSettingsClose({ capturing: false, overlays: { dialog: true, popup: true } }),
    "blocked"
  );
  assert.equal(decideSettingsClose({ capturing: true, overlays: none }), "blocked");
});

test("open Radix layers are told apart from closing ones and tooltips", () => {
  const { readOpenOverlays } = policy;
  const cases = [
    // A popover: role="dialog" inside its popper wrapper is a popup, not a modal.
    [
      `<div data-radix-popper-content-wrapper><div role="dialog" data-state="open"></div></div>`,
      { dialog: false, popup: true },
    ],
    [
      `<div data-radix-popper-content-wrapper><div role="menu" data-state="open"></div></div>`,
      { dialog: false, popup: true },
    ],
    // Playing its exit animation: already closed.
    [
      `<div data-radix-popper-content-wrapper><div role="listbox" data-state="closed"></div></div>`,
      { dialog: false, popup: false },
    ],
    [
      `<div data-radix-popper-content-wrapper><div data-state="delayed-open"><span role="tooltip">tip</span></div></div>`,
      { dialog: false, popup: false },
    ],
    // An item-aligned select renders outside a popper wrapper.
    [`<div role="listbox" data-state="open"></div>`, { dialog: false, popup: true }],
    [`<div role="dialog" data-state="open"></div>`, { dialog: true, popup: false }],
    [`<div role="alertdialog" data-state="open"></div>`, { dialog: true, popup: false }],
    [`<div role="dialog" data-state="closed"></div>`, { dialog: false, popup: false }],
  ];
  for (const [markup, expected] of cases) {
    const document = freshDocument();
    html(document, markup);
    assert.deepEqual(readOpenOverlays(document, null), expected, markup);
  }
});

test("a hand-rolled dropdown counts through its expanded trigger inside Settings", () => {
  const { readOpenOverlays } = policy;
  const document = freshDocument();
  html(
    document,
    `<section data-settings-layer=""><button aria-haspopup="listbox" aria-expanded="true"></button><button aria-expanded="true">disclosure</button></section>`
  );
  const layer = document.querySelector("[data-settings-layer]");
  assert.deepEqual(readOpenOverlays(document, layer), { dialog: false, popup: true });
  layer.querySelector("[aria-haspopup]").setAttribute("aria-expanded", "false");
  assert.deepEqual(readOpenOverlays(document, layer), { dialog: false, popup: false });
});

test("leaving for a palette result ignores the palette, not other dialogs", () => {
  const { readOpenOverlays } = policy;
  const document = freshDocument();
  html(document, `<div role="dialog" data-state="open" data-command-palette=""></div>`);
  const palette = document.querySelector("[data-command-palette]");
  assert.deepEqual(readOpenOverlays(document, null, palette), { dialog: false, popup: false });
  assert.deepEqual(readOpenOverlays(document, null), { dialog: true, popup: false });
  html(document, `<div role="alertdialog" data-state="open"></div>`);
  assert.deepEqual(readOpenOverlays(document, null, palette), { dialog: true, popup: false });
});

test("a close request dismisses an open popup instead of hiding Settings", () => {
  const { requestSettingsClose, isPopupDismissal } = policy;
  const document = freshDocument();
  html(document, LAYER);
  html(
    document,
    `<div data-radix-popper-content-wrapper><div role="dialog" data-state="open"><input id="popupField" /></div></div>`
  );
  const field = document.getElementById("popupField");
  field.focus();
  const seen = [];
  const listener = (event) => seen.push([event.key, isPopupDismissal(event), event.target]);
  document.addEventListener("keydown", listener, true);
  try {
    assert.equal(requestSettingsClose(document), false);
  } finally {
    document.removeEventListener("keydown", listener, true);
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "Escape");
  assert.equal(seen[0][1], true, "marked so Settings' own Esc rules skip it");
  assert.equal(seen[0][2], field, "sent where a user's Esc would go");
});

test("a hand-rolled dropdown is closed at its trigger, wherever focus is", () => {
  const { requestSettingsClose, isPopupDismissal } = policy;
  const document = freshDocument();
  html(
    document,
    `<section data-settings-layer=""><button id="other">x</button><button id="trigger" aria-haspopup="listbox" aria-expanded="true"></button></section>`
  );
  document.getElementById("other").focus();
  const seen = [];
  const listener = (event) => seen.push([isPopupDismissal(event), event.target.id]);
  document.addEventListener("keydown", listener, true);
  try {
    assert.equal(requestSettingsClose(document), false);
  } finally {
    document.removeEventListener("keydown", listener, true);
  }
  assert.deepEqual(seen, [[true, "trigger"]]);
});

test("a close request is refused under a modal dialog or a hotkey capture", () => {
  const { requestSettingsClose } = policy;
  let document = freshDocument();
  html(document, LAYER);
  html(document, `<div role="dialog" data-state="open"></div>`);
  let dispatched = 0;
  const count = () => dispatched++;
  document.addEventListener("keydown", count, true);
  assert.equal(requestSettingsClose(document), false);
  assert.equal(dispatched, 0, "a modal dialog is never dismissed for Settings");
  document.removeEventListener("keydown", count, true);

  document = freshDocument();
  html(document, `<section data-settings-layer=""><div data-capturing="true"></div></section>`);
  assert.equal(requestSettingsClose(document), false);

  document = freshDocument();
  html(document, LAYER);
  assert.equal(requestSettingsClose(document), true);
});

test("Esc leaves text fields, not buttons or checkboxes", () => {
  const { isEditableElement } = policy;
  const document = freshDocument();
  const host = html(
    document,
    `<input id="text" /><input id="search" type="search" /><input id="check" type="checkbox" /><input id="range" type="range" /><input id="ro" readonly /><textarea id="area"></textarea><button id="button"></button><div id="rich" contenteditable="true"></div>`
  );
  const editable = (id) => isEditableElement(host.querySelector(`#${id}`));
  assert.equal(editable("text"), true);
  assert.equal(editable("search"), true);
  assert.equal(editable("area"), true);
  assert.equal(editable("rich"), true);
  assert.equal(editable("check"), false);
  assert.equal(editable("range"), false);
  assert.equal(editable("ro"), false);
  assert.equal(editable("button"), false);
});

test("the Esc context reads overlays, capture and the focused field", () => {
  const { readEscapeContext } = policy;
  const document = freshDocument();
  html(document, LAYER);
  const layer = document.querySelector("[data-settings-layer]");
  document.getElementById("field").focus();
  const event = new happyWindow.KeyboardEvent("keydown", { key: "Escape" });
  assert.deepEqual(readEscapeContext(document, layer, event, false), {
    composing: false,
    capturing: false,
    overlayOpen: false,
    popupOpen: false,
    editableFocused: true,
    searchActive: false,
  });
  const composing = new happyWindow.KeyboardEvent("keydown", {
    key: "Escape",
    isComposing: true,
  });
  assert.equal(readEscapeContext(document, layer, composing, false).composing, true);
});

test("closing gives focus back, falls back when it's gone, and never stays inside", () => {
  const { restoreFocusAfterSettings } = policy;
  const document = freshDocument();
  html(document, LAYER);
  const app = html(document, `<button id="before">before</button><button id="nav">nav</button>`);
  const layer = document.querySelector("[data-settings-layer]");
  const before = app.querySelector("#before");
  const nav = app.querySelector("#nav");

  document.getElementById("inside").focus();
  restoreFocusAfterSettings(document, layer, before, () => nav);
  assert.equal(document.activeElement, before);

  // What had focus was removed (another view opened): the fallback takes it.
  document.getElementById("inside").focus();
  before.remove();
  restoreFocusAfterSettings(document, layer, before, () => nav);
  assert.equal(document.activeElement, nav);

  // No fallback either: focus leaves the hidden layer.
  document.getElementById("inside").focus();
  restoreFocusAfterSettings(document, layer, null, () => null);
  assert.ok(!layer.contains(document.activeElement));

  // Focus that moved elsewhere as Settings closed (the palette) is left alone.
  const palette = html(document, `<input id="palette" />`).querySelector("#palette");
  palette.focus();
  restoreFocusAfterSettings(document, layer, nav, () => nav);
  assert.equal(document.activeElement, palette);
});

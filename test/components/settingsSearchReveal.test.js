const test = require("node:test");
const assert = require("node:assert/strict");

// Landing on a setting after a search result: revealSetting waits for an
// anchor that mounts late (sections and sub-tabs render lazily), opens a
// collapsed block only while it hides the setting, falls back to a stable
// parent when the row isn't rendered in this state, scrolls and flashes
// exactly once, and never changes a value.

let happyWindow;

test.before(async () => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window({ url: "http://localhost/" });
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of ["document", "Node", "Element", "HTMLElement", "MutationObserver"]) {
    define(name, happyWindow[name]);
  }
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

async function load() {
  const mod = await import("../../src/components/settings/search/revealSetting.ts");
  return mod.default ?? mod;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// happy-dom has no layout: hidden means under [hidden], `.hidden` or a closed <details>.
function isVisible(element) {
  for (let node = element; node; node = node.parentElement) {
    if (node.hasAttribute?.("hidden") || node.classList?.contains("hidden")) return false;
    const parent = node.parentElement;
    if (parent?.tagName === "DETAILS" && !parent.open && node.tagName !== "SUMMARY") return false;
  }
  return true;
}

function setup(t, html) {
  const root = happyWindow.document.createElement("section");
  root.setAttribute("data-settings-layer", "");
  root.innerHTML = html;
  happyWindow.document.body.appendChild(root);
  t.after(() => root.remove());
  const scrolled = [];
  happyWindow.HTMLElement.prototype.scrollIntoView = function (options) {
    scrolled.push({ id: this.getAttribute("data-setting-id"), options });
  };
  return { root, scrolled };
}

function watchFlashes(root) {
  const flashes = [];
  const observer = new happyWindow.MutationObserver((records) => {
    for (const record of records) {
      const element = record.target;
      if (element.hasAttribute("data-search-flash")) {
        flashes.push(element.getAttribute("data-setting-id"));
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-search-flash"],
  });
  return { flashes, stop: () => observer.disconnect() };
}

test("waits for an anchor that mounts late, then scrolls to it and flashes it once", async (t) => {
  const { revealSetting } = await load();
  const { root, scrolled } = setup(t, `<div id="page"></div>`);
  const watch = watchFlashes(root);
  t.after(watch.stop);

  const landing = revealSetting({
    root,
    anchor: "preferences.theme",
    isVisible,
    flashMs: 80,
    reducedMotion: false,
  });
  await wait(60);
  // The section renders a few frames after the navigation.
  root.querySelector("#page").innerHTML =
    `<div data-setting-id="preferences.theme"><input type="checkbox" id="toggle"></div>`;
  const element = await landing;

  assert.equal(element?.getAttribute("data-setting-id"), "preferences.theme");
  assert.ok(element.hasAttribute("data-search-flash"), "flashing while it lands");
  assert.deepEqual(scrolled, [
    { id: "preferences.theme", options: { block: "center", behavior: "smooth" } },
  ]);
  assert.equal(root.querySelector("#toggle").checked, false, "the setting is untouched");

  await wait(120);
  assert.ok(!element.hasAttribute("data-search-flash"), "the flash ends");
  assert.deepEqual(watch.flashes, ["preferences.theme"], "flashed exactly once");
});

test("skips a hidden copy of the anchor and lands on the one that shows", async (t) => {
  const { revealSetting } = await load();
  const { root } = setup(
    t,
    `<div class="hidden" id="other-tab"><div data-setting-id="dictation.stt.vad" id="hidden-copy"></div></div>
     <div class="hidden" id="this-tab"><div data-setting-id="dictation.stt.vad" id="shown-copy"></div></div>`
  );
  const landing = revealSetting({ root, anchor: "dictation.stt.vad", isVisible, flashMs: 20 });
  await wait(40);
  // The sub-tab switches in an effect after the navigation.
  root.querySelector("#this-tab").classList.remove("hidden");
  const element = await landing;
  assert.equal(element.id, "shown-copy");
});

test("a copy on another page (still showing in the same frame) is not the one it lands on", async (t) => {
  const { revealSetting } = await load();
  const { root } = setup(
    t,
    `<div data-settings-page-id="liveRecording" id="old-page"><div data-setting-id="dictation.stt.vad" id="old-copy"></div></div>
     <div data-settings-page-id="recognition" class="hidden" id="new-page"><div data-setting-id="dictation.stt.vad" id="new-copy"></div></div>`
  );
  const landing = revealSetting({
    root,
    anchor: "dictation.stt.vad",
    page: "recognition",
    isVisible,
    flashMs: 20,
  });
  await wait(40);
  assert.ok(!root.querySelector("#old-copy").hasAttribute("data-search-flash"));
  root.querySelector("#old-page").classList.add("hidden");
  root.querySelector("#new-page").classList.remove("hidden");
  const element = await landing;
  assert.equal(element.id, "new-copy");
});

test("opens a collapsed block to reveal the setting inside, without clicking anything else", async (t) => {
  const { revealSetting } = await load();
  const { root } = setup(
    t,
    `<details data-setting-id="advanced"><summary>Advanced</summary>
       <div data-setting-id="advanced.threshold"><button id="inner">Reset</button></div>
     </details>`
  );
  let clicks = 0;
  root.querySelector("#inner").addEventListener("click", () => clicks++);
  const element = await revealSetting({
    root,
    anchor: "advanced.threshold",
    expand: ["advanced"],
    isVisible,
    flashMs: 20,
  });
  assert.equal(root.querySelector("details").open, true);
  assert.equal(element?.getAttribute("data-setting-id"), "advanced.threshold");
  assert.equal(clicks, 0);
});

test("an aria-expanded trigger is clicked once to expand its block", async (t) => {
  const { revealSetting } = await load();
  const { root } = setup(
    t,
    `<div data-setting-id="block"><button data-setting-expand aria-expanded="false" id="more">More</button>
       <div id="body" hidden><div data-setting-id="block.row"></div></div></div>`
  );
  let clicks = 0;
  const trigger = root.querySelector("#more");
  trigger.addEventListener("click", () => {
    clicks++;
    trigger.setAttribute("aria-expanded", "true");
    root.querySelector("#body").removeAttribute("hidden");
  });
  const element = await revealSetting({
    root,
    anchor: "block.row",
    expand: ["block"],
    isVisible,
    flashMs: 20,
  });
  assert.equal(element?.getAttribute("data-setting-id"), "block.row");
  assert.equal(clicks, 1);
});

test("a block isn't opened while the setting already shows outside it", async (t) => {
  const { revealSetting } = await load();
  const { root } = setup(
    t,
    `<div data-setting-id="connections.copilot" id="card"></div>
     <div data-setting-id="connections.more"><button data-setting-expand aria-expanded="false" id="fold">Add a provider</button></div>`
  );
  let clicks = 0;
  root.querySelector("#fold").addEventListener("click", () => clicks++);
  const element = await revealSetting({
    root,
    anchor: "connections.copilot",
    expand: ["connections.more"],
    isVisible,
    flashMs: 20,
  });
  assert.equal(element?.id, "card");
  assert.equal(clicks, 0, "the fold stays closed");
  assert.equal(root.querySelector("#fold").getAttribute("aria-expanded"), "false");
});

test("a setting the block hides (not rendered until it opens) opens the block", async (t) => {
  const { revealSetting } = await load();
  const { root } = setup(
    t,
    `<div data-setting-id="connections.more"><button data-setting-expand aria-expanded="false" id="fold">Add a provider</button></div>`
  );
  let clicks = 0;
  const fold = root.querySelector("#fold");
  fold.addEventListener("click", () => {
    clicks++;
    fold.setAttribute("aria-expanded", "true");
    // Rows render once the fold is open, as React does a moment later.
    setTimeout(() => {
      fold.insertAdjacentHTML(
        "afterend",
        `<div><div data-setting-id="connections.openai" id="row"></div></div>`
      );
    }, 10);
  });
  const element = await revealSetting({
    root,
    anchor: "connections.openai",
    expand: ["connections.more"],
    isVisible,
    flashMs: 20,
  });
  assert.equal(element?.id, "row");
  assert.equal(clicks, 1);
});

test("a row that isn't rendered in this state lands on its stable parent", async (t) => {
  const { revealSetting } = await load();
  const { root } = setup(
    t,
    `<div data-setting-id="hotkeys.dictation" style="height: 2000px"><input id="hotkey"></div>`
  );
  const started = Date.now();
  const element = await revealSetting({
    root,
    anchor: "hotkeys.activationMode",
    fallbackAnchor: "hotkeys.dictation",
    fallbackGraceMs: 60,
    isVisible,
    flashMs: 20,
  });
  assert.equal(element?.getAttribute("data-setting-id"), "hotkeys.dictation");
  assert.ok(Date.now() - started >= 50, "the row itself got a moment to render first");
});

test("the row wins over its parent when it renders within the grace period", async (t) => {
  const { revealSetting } = await load();
  const { root } = setup(t, `<div data-setting-id="system.developer.debug" id="parent"></div>`);
  const landing = revealSetting({
    root,
    anchor: "system.developer.logs",
    fallbackAnchor: "system.developer.debug",
    fallbackGraceMs: 300,
    isVisible,
    flashMs: 20,
  });
  await wait(40);
  root
    .querySelector("#parent")
    .insertAdjacentHTML("beforeend", `<div data-setting-id="system.developer.logs"></div>`);
  const element = await landing;
  assert.equal(element?.getAttribute("data-setting-id"), "system.developer.logs");
});

test("nothing shows up in time, or a newer navigation aborts: no flash", async (t) => {
  const { revealSetting } = await load();
  const { root, scrolled } = setup(t, `<div data-setting-id="other"></div>`);
  const watch = watchFlashes(root);
  t.after(watch.stop);

  assert.equal(
    await revealSetting({ root, anchor: "never", isVisible, timeoutMs: 80 }),
    null,
    "times out"
  );

  const controller = new AbortController();
  const landing = revealSetting({ root, anchor: "late", isVisible, signal: controller.signal });
  await wait(30);
  controller.abort();
  root.insertAdjacentHTML("beforeend", `<div data-setting-id="late"></div>`);
  assert.equal(await landing, null);
  await wait(30);
  assert.deepEqual(watch.flashes, []);
  assert.deepEqual(scrolled, []);
});

test("a new flash ends the previous one; tall blocks align to the top; reduced motion jumps", async (t) => {
  const { revealSetting, flashElement } = await load();
  const { root, scrolled } = setup(
    t,
    `<div data-settings-scroller="">
       <div data-setting-id="first"></div>
       <div data-setting-id="tall"></div>
     </div>`
  );
  const scroller = root.querySelector("[data-settings-scroller]");
  Object.defineProperty(scroller, "clientHeight", { value: 600 });
  const tall = root.querySelector('[data-setting-id="tall"]');
  tall.getBoundingClientRect = () => ({ height: 900, top: 0, bottom: 900, left: 0, right: 0 });

  const first = root.querySelector('[data-setting-id="first"]');
  flashElement(first, 1000);
  assert.ok(first.hasAttribute("data-search-flash"));

  await revealSetting({ root, anchor: "tall", isVisible, reducedMotion: true, flashMs: 20 });
  assert.ok(!first.hasAttribute("data-search-flash"), "the earlier flash was ended");
  assert.ok(tall.hasAttribute("data-search-flash"));
  assert.deepEqual(scrolled.at(-1), { id: "tall", options: { block: "start", behavior: "auto" } });
});

// Ctrl+K: choosing a Settings result used to leave focus on <body> (the palette
// returns focus to what had it before, which is inert under Settings).
test("the landed row takes focus when nothing in Settings has it, and gives up its tabindex", async (t) => {
  const { focusLandedSetting } = await load();
  const { root } = setup(
    t,
    `<input id="search" /><div data-setting-id="row" id="row"></div><button data-setting-id="control" id="control"></button>`
  );
  root.tabIndex = -1;
  const doc = happyWindow.document;
  const row = root.querySelector("#row");

  doc.activeElement?.blur?.();
  focusLandedSetting(root, row);
  assert.equal(doc.activeElement, row);
  assert.equal(row.getAttribute("tabindex"), "-1");
  root.querySelector("#search").focus();
  assert.equal(row.hasAttribute("tabindex"), false, "focusable only while it has focus");

  // Focus the user put in Settings (the search field) stays there.
  focusLandedSetting(root, row);
  assert.equal(doc.activeElement, root.querySelector("#search"));

  // A control that reacts to keys isn't focused; the layer is.
  doc.activeElement.blur();
  focusLandedSetting(root, root.querySelector("#control"));
  assert.equal(doc.activeElement, root);
  // From the layer root, a later landing moves on to the row.
  focusLandedSetting(root, row);
  assert.equal(doc.activeElement, row);
});

test("closing the palette after a Settings result focuses the flashed row, else the layer", async (t) => {
  const { focusSettingsAfterPalette, focusLandedSetting } = await load();
  const doc = happyWindow.document;
  const { root } = setup(t, `<div data-setting-id="row" id="row"></div>`);
  root.tabIndex = -1;

  doc.activeElement?.blur?.();
  focusSettingsAfterPalette(doc);
  assert.equal(doc.activeElement, root, "the reveal hasn't landed yet");

  root.querySelector("#row").setAttribute("data-search-flash", "");
  doc.activeElement.blur();
  focusSettingsAfterPalette(doc);
  assert.equal(doc.activeElement, root.querySelector("#row"));

  // A closed (inert) Settings layer is left alone.
  doc.activeElement.blur();
  root.setAttribute("inert", "");
  focusLandedSetting(root, root.querySelector("#row"));
  assert.notEqual(doc.activeElement, root.querySelector("#row"));
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

// AutoGrowTextarea and ClampedText in happy-dom. happy-dom has no layout, so
// heights are faked: a rendered textarea is 20 px per line (at least its rows),
// a ClampedText clip 20 px per line of its text, and anything under a [hidden]
// ancestor reads 0, as display: none does in Chromium. ResizeObserver is a fake
// the tests fire by hand.

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "getComputedStyle",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "InputEvent",
  "DOMRect",
];

const LINE = 20;
const lines = (text) => String(text ?? "").split("\n").length;

let happyWindow;
const observers = [];

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    observers.push(this);
  }
  observe(target) {
    this.targets.add(target);
  }
  unobserve(target) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}

function resize(target, width) {
  for (const observer of observers) {
    if (observer.targets.has(target)) {
      observer.callback([{ target, contentRect: { width, height: 0 } }], observer);
    }
  }
}

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
  define("ResizeObserver", FakeResizeObserver);

  const rendered = (el) => !el.closest("[hidden]");
  Object.defineProperty(happyWindow.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (!this.isConnected || !rendered(this)) return 0;
      if (this.tagName === "TEXTAREA") {
        return Math.max(Number(this.getAttribute("rows")) || 2, lines(this.value)) * LINE;
      }
      if (this.hasAttribute("data-clamped-text")) return lines(this.textContent) * LINE;
      return 0;
    },
  });
  // The caret mirror (an offscreen div): its marker span sits on the line after
  // the text before it.
  const offsetTop = Object.getOwnPropertyDescriptor(happyWindow.HTMLElement.prototype, "offsetTop");
  Object.defineProperty(happyWindow.HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get() {
      if (this.tagName === "SPAN" && this.parentElement?.style.left === "-9999px") {
        return (lines(this.previousSibling?.textContent ?? "") - 1) * LINE;
      }
      return offsetTop.get.call(this);
    },
  });
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(t) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t);
  const { AutoGrowTextarea } = await vite.ssrLoadModule("/components/ui/AutoGrowTextarea.tsx");
  const { default: ClampedText } = await vite.ssrLoadModule("/components/ui/ClampedText.tsx");
  const { SettingsVisibleProvider } = await vite.ssrLoadModule(
    "/components/settings/useSettingsVisible.ts"
  );

  const doc = happyWindow.document;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
    observers.length = 0;
  });
  const act = async (callback) => {
    await React.act(async () => {
      await callback();
      await settle();
    });
  };
  const render = (element) => act(() => root.render(element));
  return {
    React,
    h: React.createElement,
    AutoGrowTextarea,
    ClampedText,
    SettingsVisibleProvider,
    doc,
    act,
    render,
  };
}

const text = (count) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

test("AutoGrowTextarea is as tall as its text and follows value changes", async (t) => {
  const s = await setup(t);
  const view = (value) =>
    s.h(s.AutoGrowTextarea, { value, onChange: () => {}, minRows: 3, "aria-label": "Prompt" });

  await s.render(view(text(6)));
  const field = s.doc.querySelector("textarea");
  assert.equal(field.style.height, `${6 * LINE}px`);
  assert.equal(field.getAttribute("rows"), "3", "minRows is the floor");
  assert.match(field.className, /\bresize-none\b/);
  assert.match(field.className, /\boverflow-hidden\b/, "never scrolls inside");
  assert.equal(field.getAttribute("aria-label"), "Prompt", "other props pass through");

  await s.render(view(text(14)));
  assert.equal(field.style.height, `${14 * LINE}px`);

  await s.render(view("short"));
  assert.equal(field.style.height, `${3 * LINE}px`, "shrinks back to minRows");
});

test("AutoGrowTextarea measures again when hidden Settings is shown, and never stores 0", async (t) => {
  const s = await setup(t);
  let api;
  function Harness() {
    const [visible, setVisible] = s.React.useState(false);
    const [value, setValue] = s.React.useState(text(6));
    api = { setVisible, setValue };
    return s.h(
      s.SettingsVisibleProvider,
      { value: visible },
      s.h(
        "div",
        { hidden: !visible },
        s.h(s.AutoGrowTextarea, { value, onChange: () => {}, minRows: 3 })
      )
    );
  }

  // Mounted while Settings is hidden: nothing to measure yet.
  await s.render(s.h(Harness));
  const field = s.doc.querySelector("textarea");
  assert.equal(field.style.height, "", "no height while hidden, not 0");

  await s.act(() => api.setVisible(true));
  assert.equal(field.style.height, `${6 * LINE}px`, "measured once shown");

  // Updated while hidden again (another window changed the draft).
  await s.act(() => api.setVisible(false));
  assert.equal(field.style.height, `${6 * LINE}px`, "keeps its last real height while hidden");
  await s.act(() => api.setValue(text(11)));
  assert.equal(field.style.height, `${6 * LINE}px`, "can't measure while hidden, keeps it");

  await s.act(() => api.setVisible(true));
  assert.equal(field.style.height, `${11 * LINE}px`, "re-measured on reopen");
});

test("AutoGrowTextarea measures again when its page is revealed or its width changes", async (t) => {
  const s = await setup(t);
  // A page body inside visible Settings, mounted hidden (one tab at a time).
  await s.render(
    s.h(
      "div",
      { id: "page", hidden: true },
      s.h(s.AutoGrowTextarea, { value: text(8), onChange: () => {} })
    )
  );
  const field = s.doc.querySelector("textarea");
  resize(field, 0);
  assert.equal(field.style.height, "");

  s.doc.getElementById("page").removeAttribute("hidden");
  await s.act(() => resize(field, 600));
  assert.equal(field.style.height, `${8 * LINE}px`, "shown: its width went from 0 to 600");

  // Our own height change doesn't loop: same width, no new measure.
  field.style.height = "1px";
  resize(field, 600);
  assert.equal(field.style.height, "1px");
  resize(field, 400);
  assert.equal(field.style.height, `${8 * LINE}px`, "a narrower field rewraps and is measured");
});

test("AutoGrowTextarea scrolls the page to keep the caret in view as it grows", async (t) => {
  const s = await setup(t);
  let setValue;
  function Harness() {
    const [value, set] = s.React.useState(text(6));
    setValue = set;
    return s.h(
      "div",
      { id: "scroller", style: { overflowY: "auto" } },
      s.h(s.AutoGrowTextarea, { value, onChange: () => {} })
    );
  }
  await s.render(s.h(Harness));
  const scroller = s.doc.getElementById("scroller");
  const field = s.doc.querySelector("textarea");
  // A 200 px viewport; the field starts 100 px down the content.
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
  scroller.getBoundingClientRect = () => new happyWindow.DOMRect(0, 0, 600, 200);
  field.getBoundingClientRect = () =>
    new happyWindow.DOMRect(0, 100 - scroller.scrollTop, 600, parseFloat(field.style.height));

  field.focus();
  await s.act(() => setValue(text(10)));
  // Caret on line 10: its bottom is 100 + 9 * 20 + 24 (line) + 8 (margin) = 312.
  assert.equal(field.style.height, `${10 * LINE}px`);
  assert.equal(scroller.scrollTop, 312 - 200, "scrolled just enough to show the caret");

  field.blur();
  await s.act(() => setValue(text(16)));
  assert.equal(scroller.scrollTop, 112, "doesn't move the page for a field without focus");
});

test("ClampedText shows Show all only when the text is taller than the clamp", async (t) => {
  const s = await setup(t);
  const view = (body) => s.h(s.ClampedText, { collapsedRem: 6 }, s.h("pre", { id: "body" }, body));

  // 6rem = 96 px; 2 lines = 40 px fit.
  await s.render(view(text(2)));
  const clip = s.doc.querySelector("[data-clamped-text]");
  assert.equal(clip.getAttribute("data-clamped-text"), "fits");
  assert.equal(s.doc.querySelector("button"), null, "no toggle for short text");

  await s.render(view(text(20)));
  const button = s.doc.querySelector("button");
  assert.ok(button, "toggle once it overflows");
  assert.equal(button.getAttribute("type"), "button");
  assert.equal(button.textContent, "common.showAll");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(button.getAttribute("aria-controls"), clip.id);
  assert.equal(clip.getAttribute("data-clamped-text"), "collapsed");
  assert.equal(clip.style.maxHeight, "6rem");
  assert.match(clip.style.maskImage || clip.style.webkitMaskImage || "", /linear-gradient/);

  await s.act(() => button.click());
  assert.equal(button.textContent, "common.showLess");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(clip.getAttribute("data-clamped-text"), "expanded");
  assert.equal(clip.style.maxHeight, "", "shows everything");

  await s.act(() => button.click());
  assert.equal(button.textContent, "common.showAll");
  assert.equal(clip.style.maxHeight, "6rem", "collapses again");

  await s.render(view(text(3)));
  assert.equal(s.doc.querySelector("button"), null, "the toggle goes when the text fits again");
});

test("ClampedText mounted while hidden measures once shown", async (t) => {
  const s = await setup(t);
  await s.render(
    s.h(
      "div",
      { id: "page", hidden: true },
      s.h(s.ClampedText, { collapsedRem: 6 }, s.h("pre", null, text(20)))
    )
  );
  assert.equal(s.doc.querySelector("button"), null, "unknown while hidden");
  const clip = s.doc.querySelector("[data-clamped-text]");
  assert.equal(clip.style.maxHeight, "6rem", "clamped from the start, so no flash when shown");

  s.doc.getElementById("page").removeAttribute("hidden");
  await s.act(() => resize(clip.firstElementChild, 600));
  assert.equal(s.doc.querySelector("button")?.textContent, "common.showAll");
});

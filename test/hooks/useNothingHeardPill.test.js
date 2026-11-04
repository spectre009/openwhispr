const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The pill's quiet end of a short empty dictation (the red spin-down): it
// plays for the whole beat, then settles to idle, or, with auto-hide, stays
// faded until its window has hidden; the next dictation ends it at once.

async function mountPill(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-nothing-heard-pill-" });
  const { useNothingHeardPill } = await vite.ssrLoadModule("/hooks/useNothingHeardPill.ts");
  const { NOTHING_HEARD_TIMING } = await vite.ssrLoadModule("/helpers/voicePillPresentation.js");

  let props = { seq: 0, interrupted: false, autoHide: false };
  let phase;
  function Harness() {
    phase = useNothingHeardPill(props);
    return null;
  }
  root = createRoot(container);
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await React.act(async () => {
      root.render(React.createElement(Harness));
    });
  };
  const wait = (ms) =>
    React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  await render();
  return { render, wait, phase: () => phase, timing: NOTHING_HEARD_TIMING };
}

test("the spin-down plays for the whole beat, then the pill settles to idle", async (t) => {
  const pill = await mountPill(t);
  assert.equal(pill.phase(), null);
  await pill.render({ seq: 1 });
  assert.equal(pill.phase(), "playing");
  await pill.wait(pill.timing.totalMs - 300);
  assert.equal(pill.phase(), "playing", "never cut short");
  await pill.wait(400);
  assert.equal(pill.phase(), null);
});

test("with auto-hide the pill stays faded until its window hides, then is idle again", async (t) => {
  const pill = await mountPill(t);
  await pill.render({ seq: 1, autoHide: true });
  await pill.wait(pill.timing.totalMs + 100);
  assert.equal(pill.phase(), "faded");
  // Something keeps the window up (a card, a panel, auto-hide turned off).
  await pill.render({ autoHide: false });
  assert.equal(pill.phase(), null);
});

test("a faded pill shows again after its hold, whatever happened to the hide", async (t) => {
  const pill = await mountPill(t);
  await pill.render({ seq: 1, autoHide: true });
  await pill.wait(pill.timing.totalMs + 100);
  assert.equal(pill.phase(), "faded");
  await pill.wait(pill.timing.fadedHoldMs + 100);
  assert.equal(pill.phase(), null);
});

test("a new dictation ends it at once, and no late timer brings it back", async (t) => {
  const pill = await mountPill(t);
  await pill.render({ seq: 1, autoHide: true });
  assert.equal(pill.phase(), "playing");
  await pill.render({ interrupted: true });
  assert.equal(pill.phase(), null);
  await pill.wait(pill.timing.totalMs + 100);
  assert.equal(pill.phase(), null);
  await pill.render({ interrupted: false });
  assert.equal(pill.phase(), null, "the next idle is plain idle");
  // The next quiet end plays again.
  await pill.render({ seq: 2 });
  assert.equal(pill.phase(), "playing");
});

test("a quiet end that lands while a dictation is under way never plays", async (t) => {
  const pill = await mountPill(t);
  await pill.render({ seq: 1, interrupted: true });
  assert.equal(pill.phase(), null);
  await pill.render({ interrupted: false });
  assert.equal(pill.phase(), null);
});

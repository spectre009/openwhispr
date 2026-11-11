const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The assistant's pill (the agent window) while its take records takes the
// floating icon's recording look: the style from Settings → Floating icon →
// While recording, in the assistant's color, and the recording time when REC
// or "Show recording time" asks for it. It replaced the dictation window's
// assistant pill, which took the same look.

const LISTENING = {
  waveform: true,
  thinking: false,
  waiting: false,
  buttons: ["expand", "keyboard", "close"],
};
const VARS = { "--recording-accent": "#7c3aed", "--recording-on-accent": "#ffffff" };

// startedAgoMs: the take's start, taken right before the render.
async function renderPill(t, { startedAgoMs, ...props }) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-recording-look-" });
  const { AgentPill } = await vite.ssrLoadModule("/components/agent/AgentPill.tsx");
  if (startedAgoMs !== undefined) props.recordingStartedAt = Date.now() - startedAgoMs;
  return renderToStaticMarkup(
    React.createElement(AgentPill, {
      controls: LISTENING,
      recording: true,
      readLevel: () => 0,
      onAction: () => {},
      recordingVars: VARS,
      ...props,
    })
  );
}

const rootTag = (markup) => markup.match(/^<div[^>]*>/)?.[0] ?? "";

test("the look follows the style only while the take records", async () => {
  const { resolveAgentPillRecordingLook } = await import("../../src/helpers/recordingIndicator.js");
  const look = (overrides) =>
    resolveAgentPillRecordingLook({
      style: "classic",
      showElapsed: false,
      recording: true,
      ...overrides,
    });
  assert.deepEqual(look({}), { chromeStyle: null, showTime: false, recDot: false });
  assert.deepEqual(look({ style: "solid" }), {
    chromeStyle: "solid",
    showTime: false,
    recDot: false,
  });
  assert.deepEqual(look({ style: "rec" }), { chromeStyle: "rec", showTime: true, recDot: true });
  assert.deepEqual(look({ showElapsed: true }), {
    chromeStyle: null,
    showTime: true,
    recDot: false,
  });
  assert.deepEqual(look({ style: "rec", showElapsed: true, recording: false }), {
    chromeStyle: null,
    showTime: false,
    recDot: false,
  });
  assert.equal(look({ style: "nonsense" }).chromeStyle, null, "an unknown style reads as Classic");
});

test("a styled take paints the pill in the recording color, with its controls in its foreground", async (t) => {
  const markup = await renderPill(t, { recordingStyle: "solid" });
  const root = rootTag(markup);
  assert.match(root, /data-recording-style="solid"/);
  assert.match(root, /--recording-accent:#7c3aed/);
  assert.match(markup, /agent-pill-waveform[^"]*text-inherit/);
  assert.doesNotMatch(markup, /agent-pill-elapsed/, "Solid shows no time of its own");
});

test("REC shows the blinking dot and the time before the waveform", async (t) => {
  const markup = await renderPill(t, {
    recordingStyle: "rec",
    startedAgoMs: 7_400,
  });
  assert.match(rootTag(markup), /data-recording-style="rec"/);
  const dot = markup.indexOf("agent-pill-rec-dot");
  const time = markup.indexOf("0:07");
  const wave = markup.indexOf("agent-pill-waveform");
  assert.ok(dot > 0 && time > dot && wave > time, "dot, time, then the waveform");
});

test("Classic with the recording time keeps today's pill and adds the time after the waveform", async (t) => {
  const markup = await renderPill(t, {
    recordingShowElapsed: true,
    startedAgoMs: 65_400,
  });
  assert.doesNotMatch(rootTag(markup), /data-recording-style/);
  assert.doesNotMatch(markup, /agent-pill-rec-dot/);
  assert.ok(markup.indexOf("1:05") > markup.indexOf("agent-pill-waveform"));
});

test("nothing changes outside a recording take: idle, a notice, or thinking", async (t) => {
  for (const props of [
    { recording: false },
    { notice: "Didn't catch that" },
    { controls: { ...LISTENING, waveform: false, thinking: true } },
  ]) {
    const markup = await renderPill(t, {
      recordingStyle: "rec",
      startedAgoMs: 0,
      ...props,
    });
    assert.doesNotMatch(rootTag(markup), /data-recording-style|--recording-accent/);
    assert.doesNotMatch(markup, /agent-pill-elapsed|agent-pill-rec-dot/);
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODULE_URL = pathToFileURL(path.join(__dirname, "../../src/utils/dictationCues.js")).href;

class FakeParam {
  constructor() {
    this.value = 0;
  }
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class FakeNode {
  constructor(context, kind) {
    this.context = context;
    this.kind = kind;
    this.connections = [];
    this.startedAt = null;
    this.stopped = false;
  }
  connect(node) {
    this.connections.push(node);
    return node;
  }
  disconnect() {
    this.connections = [];
  }
  start(when = this.context.currentTime) {
    this.startedAt = when;
    this.context.nodes.push(this);
  }
  stop() {
    this.stopped = true;
  }
}

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = { kind: "destination" };
    this.outputLatency = 0.05;
    this.baseLatency = 0;
    this.nodes = [];
    FakeAudioContext.last = this;
  }
  createOscillator() {
    const node = new FakeNode(this, "oscillator");
    node.frequency = new FakeParam();
    return node;
  }
  createGain() {
    const node = new FakeNode(this, "gain");
    node.gain = new FakeParam();
    return node;
  }
  createConstantSource() {
    const node = new FakeNode(this, "constant");
    node.offset = new FakeParam();
    return node;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
}

let cues;
// One module for the file (it keeps its context and warm-up in module state), so every
// test ends with the output released and only looks at the nodes it created.
async function loadCues(t) {
  globalThis.window = { AudioContext: FakeAudioContext };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  cues ??= await import(MODULE_URL);
  return cues;
}

function settle(t, context) {
  cues.releaseCueOutput();
  t.mock.timers.tick(1000);
  if (context) context.currentTime += 100;
}

const since = (context, mark) => context.nodes.slice(mark);
const warmSources = (nodes) => nodes.filter((n) => n.kind === "constant");
const toneStarts = (nodes) => nodes.filter((n) => n.kind === "oscillator").map((n) => n.startedAt);

test("a cue starts soon, but never before the output has had 0.25 s to wake", async (t) => {
  const { cueStartTime } = await loadCues(t);
  assert.equal(cueStartTime(10, null), 10.005);
  assert.equal(cueStartTime(10, 9.99), 10.24);
  assert.equal(cueStartTime(10, 5), 10.005, "an output warm for a while plays at once");
});

test("the hotkey press wakes the output with an inaudible signal", async (t) => {
  const { warmCueOutput } = await loadCues(t);
  assert.equal(await warmCueOutput(), true);
  const context = FakeAudioContext.last;
  const [source] = warmSources(context.nodes);
  assert.ok(source, "a constant source is playing");
  assert.ok(
    source.offset.value > 0 && source.offset.value <= 0.0001,
    "non-zero, but −80 dBFS or less"
  );
  assert.deepEqual(source.connections, [context.destination]);

  assert.equal(await warmCueOutput(), true);
  assert.equal(warmSources(context.nodes).length, 1, "a second press reuses the warm-up");
  settle(t, context);
});

test("the start cue waits for the wake lead, then the output stays awake for the stop cue", async (t) => {
  const { warmCueOutput, playStartCue, playStopCue, releaseCueOutput } = await loadCues(t);
  const context = FakeAudioContext.last;
  const mark = context.nodes.length;
  const pressAt = context.currentTime;
  await warmCueOutput();
  context.currentTime = pressAt + 0.213;

  const start = await playStartCue();
  assert.equal(start.played, true);
  assert.equal(start.wasWarm, true);
  assert.equal(start.warmedForMs, 213);
  assert.equal(start.delayedMs, 32);
  assert.ok(Math.abs(toneStarts(since(context, mark))[0] - (pressAt + 0.25)) < 1e-9);

  const [source] = warmSources(since(context, mark));
  t.mock.timers.tick(60000);
  assert.equal(source.stopped, false, "held for the whole recording");

  context.currentTime += 60;
  const stop = await playStopCue();
  assert.equal(stop.delayedMs, 0, "the stop cue plays at once on an awake output");

  releaseCueOutput();
  t.mock.timers.tick(1000);
  assert.equal(source.stopped, true, "released once the recording ended");
  context.currentTime += 100;
});

test("a press whose recording never starts lets the output sleep again", async (t) => {
  const { warmCueOutput } = await loadCues(t);
  const context = FakeAudioContext.last;
  const mark = context.nodes.length;
  await warmCueOutput();
  const [source] = warmSources(since(context, mark));
  t.mock.timers.tick(9999);
  assert.equal(source.stopped, false);
  t.mock.timers.tick(1);
  assert.equal(source.stopped, true);
  context.currentTime += 100;
});

test("a cue on a cold output wakes it first and starts 0.25 s later", async (t) => {
  const { playStopCue } = await loadCues(t);
  const context = FakeAudioContext.last;
  const mark = context.nodes.length;
  const stop = await playStopCue();
  assert.equal(stop.wasWarm, false);
  assert.equal(stop.delayedMs, 245, "0.25 s after the wake, versus the usual 5 ms");
  assert.ok(Math.abs(toneStarts(since(context, mark))[0] - (context.currentTime + 0.25)) < 1e-9);
  settle(t, context);
});

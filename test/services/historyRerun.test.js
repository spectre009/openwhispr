const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { normalizeTrace } = require("../../src/helpers/stepHistory.js");

// Everything after speech-to-text for a dictation already in History
// (services/historyRerun.ts): what Re-transcribe runs after main's
// re-transcription, and all of Re-run cleanup. The boundary runs with the
// dictation's captured target app, its route (plain cleanup, its style, its
// translation chain), the snippet expansion a live dictation does after it,
// and one completion that main may refuse as overtaken. The language model is
// a stub; synthetic text only.

const RULE = {
  id: "rule-little-buddy",
  canonical: "Little Buddy",
  enabled: true,
  revision: 1,
  apps: ["Code.exe"],
  spellings: [
    { text: "littlebuddy", scope: "anywhere" },
    { text: "everybody", scope: "start" },
  ],
};

const TEAMS = Object.freeze({
  id: "teams",
  name: "Teams chat",
  emoji: "💬",
  instruction: "Write it as a short, friendly Teams message.",
  enabled: true,
  runMode: "two-step",
  appGlossary: true,
  examples: [],
  useVoice: false,
  hotkey: null,
});

async function setup(t) {
  const { window } = installBrowserGlobals(t);
  const calls = [];
  const updates = [];
  let reply = (text) => text;
  globalThis.__rerunProcess = async (text, model, agentName, config = {}) => {
    calls.push({ text, model, config });
    config.onDispatch?.({ provider: "local", model: model || "stub" });
    return reply(text, config);
  };
  globalThis.__rerunRoute = () => ({ kind: "cleanup" });
  globalThis.__rerunStyles = {};
  t.after(() => {
    delete globalThis.__rerunProcess;
    delete globalThis.__rerunRoute;
    delete globalThis.__rerunStyles;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-history-rerun-",
    mockModules: {
      "/ReasoningService": `export default {
        processText: (...args) => globalThis.__rerunProcess(...args),
        destroy() {},
      };`,
      "/helpers/audioManager": `export function resolveReasoningRoute(...args) {
        return globalThis.__rerunRoute(...args);
      }`,
      "/stores/styleStore": `export function resolveStyleForRetry(id) {
        return globalThis.__rerunStyles[id] ?? null;
      }`,
      "/utils/logger": `export default {
        debug() {}, info() {}, warn() {}, error() {}, logReasoning() {},
      };`,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useGlossaryStore } = await vite.ssrLoadModule("/stores/glossaryStore.ts");
  const rerun = await vite.ssrLoadModule("/services/historyRerun.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  useSettingsStore.setState({
    customPrompts: { cleanup: "" },
    cleanupMode: "local",
    cleanupProvider: "local",
    cleanupModel: "test-model",
    useCleanupModel: true,
    snippets: [],
    preferredLanguage: "en",
    translationSourceLanguage: "auto",
    translationTargetLanguage: "fr",
  });
  useGlossaryStore.setState({ revision: 3, rules: [RULE], loaded: true });
  let completion = (id, text, rawText) => ({
    success: true,
    transcription: { id, text, raw_text: rawText },
  });
  window.electronAPI.updateTranscriptionText = async (id, text, rawText, options) => {
    updates.push({ id, text, rawText, trace: options?.trace });
    return completion(id, text, rawText, options);
  };
  window.electronAPI.pasteText = async () => assert.fail("a re-run never pastes");
  const notices = { cleanupFailed: [], styleNotApplied: [] };
  return {
    ...rerun,
    calls,
    updates,
    notices,
    useSettingsStore,
    setReply: (next) => {
      reply = next;
    },
    setCompletion: (next) => {
      completion = next;
    },
    run: (input) =>
      rerun.rerunAfterSpeechToText(
        {
          id: 7,
          routeKind: null,
          currentText: input.rawText,
          stt: { provider: "groq", model: "whisper-large-v3", ms: null },
          targetApp: null,
          runId: "run-1",
          ...input,
        },
        {
          cleanupFailed: (error) => notices.cleanupFailed.push(error),
          styleNotApplied: (name, reason) => notices.styleNotApplied.push({ name, reason }),
        }
      ),
  };
}

const capturedSteps = (overrides = {}) => ({
  success: true,
  status: "captured",
  route: "cleanup",
  context: {
    targetApp: "Code.exe",
    intents: { voiceAgent: false, translation: false, wakeWord: false },
  },
  steps: [
    {
      kind: "stt",
      outcome: "ok",
      output: "hello",
      provider: "groq",
      model: "whisper-large-v3",
      ms: 812,
      errorCode: null,
      prompt: null,
      detail: null,
    },
  ],
  ...overrides,
});

test("Re-run cleanup reuses the stored speech-to-text step and the captured target app", async (t) => {
  const h = await setup(t);
  h.setReply((text) => `${text} Thanks!`);
  const steps = capturedSteps();
  const raw = "Hello, everybody. So littlebuddy, check this.";
  const outcome = await h.run({
    rawText: raw,
    stt: h.reusedSttStep(steps),
    targetApp: h.targetAppFromSteps(steps),
  });

  // The app-scoped "start" spelling applies, as it did when it was dictated.
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].text, "Hello, Little Buddy. So Little Buddy, check this.");
  assert.equal(outcome.status, "updated");
  assert.equal(h.updates.length, 1);
  const { text, rawText, trace } = h.updates[0];
  assert.equal(text, "Hello, Little Buddy. So Little Buddy, check this. Thanks!");
  assert.equal(rawText, raw, "the raw transcript stays raw");
  assert.equal(trace.runId, "run-1");
  assert.equal(trace.context.targetApp, "Code.exe");
  assert.deepEqual(trace.steps[0], {
    kind: "stt",
    outcome: "ok",
    output: raw,
    provider: "groq",
    model: "whisper-large-v3",
    ms: null,
    detail: { reused: "stored" },
  });
  assert.deepEqual(
    trace.steps.map((step) => step.kind),
    ["stt", "glossary", "cleanup", "finalize"]
  );
  // Main keeps the marker through its validation.
  assert.deepEqual(normalizeTrace(trace).steps[0].detail, { reused: "stored" });
});

test("without a stored speech-to-text step the reused one says its provenance is unknown", async (t) => {
  const h = await setup(t);
  const none = { success: true, status: "none", steps: [] };
  const stt = h.reusedSttStep(none);
  assert.deepEqual(stt, { provider: null, model: null, ms: null, reused: "unknown" });
  assert.equal(h.targetAppFromSteps(none), null);
  await h.run({ rawText: "so littlebuddy check this", stt });
  const { trace } = h.updates[0];
  assert.deepEqual(trace.steps[0].detail, { reused: "unknown" });
  assert.equal(trace.steps[0].provider, null);
  assert.equal(trace.context.targetApp, null);
  assert.deepEqual(normalizeTrace(trace).steps[0].detail, { reused: "unknown" });
});

test("no target app: only anywhere spellings apply, and no cleanup keeps the correction", async (t) => {
  const h = await setup(t);
  h.useSettingsStore.setState({ useCleanupModel: false });
  const raw = "Hello, everybody. So littlebuddy, check this.";
  await h.run({ rawText: raw });
  assert.equal(h.calls.length, 0);
  assert.equal(h.updates[0].text, "Hello, everybody. So Little Buddy, check this.");
});

test("snippets expand after the boundary, as a live dictation's do, and end the trace", async (t) => {
  const h = await setup(t);
  h.useSettingsStore.setState({
    useCleanupModel: false,
    snippets: [{ trigger: "my sig", replacement: "Dmitri, Platform team" }],
  });
  await h.run({ rawText: "Thanks, my sig" });
  const { text, trace } = h.updates[0];
  assert.equal(text, "Thanks, Dmitri, Platform team");
  assert.equal(trace.finalText, "Thanks, Dmitri, Platform team");
  assert.deepEqual(trace.steps.at(-1), {
    kind: "finalize",
    outcome: "ok",
    output: "Thanks, Dmitri, Platform team",
    provider: null,
    model: null,
    ms: 0,
    detail: { snippets: true },
  });
});

test("a styled dictation re-runs its style: cleanup, then the restyle", async (t) => {
  const h = await setup(t);
  globalThis.__rerunStyles.teams = TEAMS;
  h.setReply((text, config) =>
    config.systemPrompt
      ? "Hey! Can you check this, Little Buddy? 🙂"
      : "So, Little Buddy, check this."
  );
  const outcome = await h.run({ rawText: "so littlebuddy check this", routeKind: "style:teams" });
  assert.equal(outcome.status, "updated");
  assert.equal(h.calls.length, 2);
  const { text, trace } = h.updates[0];
  assert.equal(text, "Hey! Can you check this, Little Buddy? 🙂");
  assert.equal(trace.route, "style");
  assert.deepEqual(trace.context.style, { id: "teams", runMode: "two-step" });
  const style = trace.steps.find((step) => step.kind === "style");
  assert.deepEqual(style.detail, { styleId: "teams", runMode: "two-step" });

  // The user chose Plain because the style was deleted: cleanup only.
  h.calls.length = 0;
  await h.run({ rawText: "so littlebuddy check this", routeKind: "style:teams", plainStyle: true });
  assert.equal(h.calls.length, 1);
  assert.equal(h.updates.at(-1).trace.route, "cleanup");
});

test("a translation dictation re-runs cleanup, then the translation", async (t) => {
  const h = await setup(t);
  globalThis.__rerunRoute = () => ({
    kind: "translation",
    model: "translate-model",
    cleanupReachable: true,
    cleanupConfig: {},
    config: { systemPrompt: "Translate into French." },
  });
  h.setReply((text, config) =>
    config.systemPrompt ? "Alors, Little Buddy, regarde ça." : "So, Little Buddy, check this."
  );
  await h.run({ rawText: "so littlebuddy check this", routeKind: "translation" });
  const { text, trace } = h.updates[0];
  assert.equal(text, "Alors, Little Buddy, regarde ça.");
  assert.equal(trace.route, "translation");
  assert.equal(trace.context.intents.translation, true);
  assert.deepEqual(
    trace.steps.map((step) => step.kind),
    ["stt", "glossary", "cleanup", "translation", "finalize"]
  );
});

test("a failed cleanup says why, keeps the corrected text and stores only the allowlisted reason", async (t) => {
  const h = await setup(t);
  h.setReply(() => {
    throw Object.assign(new Error("so littlebuddy check this: quota exceeded for org-123"), {
      code: "PROVIDER_QUOTA_EXHAUSTED",
      messageKey: "providerErrors.quotaExhausted",
      messageParams: { provider: "OpenAI", error: "so littlebuddy check this" },
      settingsTarget: "llms",
      technicalDetails: { status: 402, underlyingError: '{"error":"insufficient_quota"}' },
    });
  });
  const outcome = await h.run({ rawText: "so littlebuddy check this" });
  assert.equal(outcome.status, "updated");
  assert.equal(h.notices.cleanupFailed.length, 1);
  const { text, trace } = h.updates[0];
  assert.equal(text, "so Little Buddy check this", "the corrected transcript is the floor");
  const cleanup = trace.steps.find((step) => step.kind === "cleanup");
  assert.equal(cleanup.outcome, "failed");
  assert.deepEqual(cleanup.detail, {
    failure: {
      code: "PROVIDER_QUOTA_EXHAUSTED",
      messageKey: "providerErrors.quotaExhausted",
      messageParams: { provider: "OpenAI" },
      settingsTarget: "llms",
    },
  });
});

test("a re-run a newer one overtook reports stale and nothing else", async (t) => {
  const h = await setup(t);
  h.setCompletion(() => ({ success: false, stale: true }));
  const outcome = await h.run({ rawText: "so littlebuddy check this" });
  assert.deepEqual(outcome, { status: "stale" });
});

test("an assistant command is never re-run as a cleanup", async (t) => {
  const h = await setup(t);
  assert.equal(h.wasAssistantCommand(capturedSteps({ route: "agent" })), true);
  assert.equal(
    h.wasAssistantCommand(
      capturedSteps({
        route: "none",
        context: { targetApp: null, intents: { voiceAgent: true } },
      })
    ),
    true
  );
  assert.equal(h.wasAssistantCommand(capturedSteps()), false);
  assert.equal(h.wasAssistantCommand({ success: true, status: "none", steps: [] }), false);
});

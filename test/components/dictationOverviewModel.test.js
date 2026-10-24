const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { translators } = require("../lib/settingsSearchFixtures");

// Dictation › Overview as data (settings/dictationOverviewModel.ts): the strip's
// six nodes come from the current settings through the resolvers the feature
// pages and pickers use, and the last dictation's saved steps become columns
// named as History › View steps names them.

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };

const ALL_KEYS = {
  openai: true,
  groq: true,
  xai: true,
  mistral: true,
  gemini: true,
  corti: true,
  tinfoil: true,
  deepgram: true,
  assemblyai: true,
};

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

const library = ({
  teams = true,
  requirements = false,
  email = false,
  hotkeyStyle = "plain",
} = {}) => ({
  version: 1,
  dictationStyleId: hotkeyStyle,
  seededStarters: ["starter-teams", "starter-requirements", "starter-email"],
  styles: [
    STYLE("starter-teams", "Teams chat", "💬", teams, teams ? { hotkey: "Control+Alt+1" } : {}),
    STYLE("starter-requirements", "Requirements", "📋", requirements),
    STYLE("starter-email", "Email", "✉️", email, { runMode: "one-step" }),
  ],
});

const RULE = (id, enabled = true, spellings = [{ text: "little body", scope: "anywhere" }]) => ({
  id,
  canonical: "Little Buddy",
  spellings,
  apps: [],
  enabled,
  revision: 1,
});

let loaded;
async function load(t) {
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
    window: { electronAPI: { getPlatform: () => "win32" } },
  });
  if (loaded) return loaded;
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-dictation-overview-" });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const model = await vite.ssrLoadModule("/components/settings/dictationOverviewModel.ts");
  const hotkeys = await vite.ssrLoadModule("/utils/hotkeys.ts");
  const { t: translate } = await translators("en");
  loaded = { ...store, ...model, ...hotkeys, t: translate };
  return loaded;
}

function sttContext(current, overrides = {}) {
  return {
    policy: UNMANAGED,
    cloudDisabled: false,
    isSignedIn: false,
    keys: ALL_KEYS,
    localModels: [{ id: "base", engine: "whisper", size: "142 MB" }],
    ...overrides,
    current: {
      mode: "providers",
      cloudProvider: "groq",
      cloudModel: "whisper-large-v3-turbo",
      cloudBaseUrl: "",
      localProvider: "whisper",
      localModel: "base",
      remoteUrl: "",
      remoteModel: "",
      ...current,
    },
  };
}

function pipeline(lib, overrides = {}) {
  const { settings: settingsPatch, ...rest } = overrides;
  lib.useSettingsStore.setState({
    useCleanupModel: true,
    cleanupMode: "providers",
    cleanupProvider: "anthropic",
    cleanupModel: "claude-haiku-4-5",
    dictationKey: "Control+`",
    customDictionary: ["Kubernetes", "OpenWhispr", "Copilot"],
    snippets: [
      { trigger: "sig", replacement: "Best, D." },
      { trigger: "addr", replacement: "1 Main St" },
    ],
    autoPasteEnabled: true,
    ...settingsPatch,
  });
  const nodes = lib.buildDictationPipeline({
    settings: lib.useSettingsStore.getState(),
    policy: UNMANAGED,
    stt: sttContext({}),
    styleLibrary: library(),
    styleBindings: [
      { hotkey: "Control+Alt+1", styleId: "starter-teams", active: true, error: null },
    ],
    glossaryRules: [RULE("a"), RULE("b"), RULE("off", false), RULE("empty", true, [])],
    autoLearn: false,
    t: lib.t,
    ...rest,
  });
  return Object.fromEntries(nodes.map((node) => [node.id, node]));
}

test("the strip lists six steps in order, each opening its page", async (t) => {
  const lib = await load(t);
  const nodes = pipeline(lib);
  assert.deepEqual(Object.keys(nodes), [
    "recognition",
    "dictionary",
    "cleanup",
    "style",
    "personality",
    "output",
  ]);
  assert.deepEqual(nodes.recognition.target, { kind: "page", page: "recognition" });
  assert.deepEqual(nodes.dictionary.target, {
    kind: "elsewhere",
    location: { view: "dictionary" },
  });
  assert.deepEqual(nodes.cleanup.target, { kind: "page", page: "cleanup" });
  assert.deepEqual(nodes.style.target, { kind: "page", page: "styles" });
  assert.deepEqual(nodes.output.target, { kind: "page", page: "output" });
  // Personality isn't built: no target, drawn as planned.
  assert.equal(nodes.personality.target, undefined);
  assert.equal(nodes.personality.planned, true);
  assert.equal(nodes.personality.status, "Planned");
  assert.deepEqual(
    Object.values(nodes).map((node) => node.title),
    ["Recognition", "Dictionary & Glossary", "Cleanup", "Style", "Personality", "Output"]
  );
});

test("cleanup on shows provider · model and the prompt in use; off is dimmed", async (t) => {
  const lib = await load(t);
  const on = pipeline(lib).cleanup;
  assert.equal(on.value, "Anthropic · Claude Haiku 4.5");
  assert.equal(on.status, "Prompt: Default (built-in)");
  assert.equal(on.off, false);

  const off = pipeline(lib, { settings: { useCleanupModel: false } }).cleanup;
  assert.equal(off.value, "Off");
  assert.equal(off.status, "Text stays as recognized; a style can still restyle it");
  assert.equal(off.off, true);
});

test("recognition: cloud and local engines as the picker shows them, with its warning", async (t) => {
  const lib = await load(t);
  const cloud = pipeline(lib).recognition;
  assert.match(cloud.value, /Whisper/i);
  assert.equal(cloud.status, "Groq · API key");
  assert.equal(cloud.warning, undefined, "a saved key runs");

  const noKey = pipeline(lib, { stt: sttContext({}, { keys: { ...ALL_KEYS, groq: false } }) });
  assert.equal(noKey.recognition.warning, "No API key saved");

  const local = pipeline(lib, { stt: sttContext({ mode: "local" }) }).recognition;
  assert.equal(local.status, "Local model · on this computer");
  assert.equal(local.warning, undefined, "the model is on disk");

  const missing = pipeline(lib, {
    stt: sttContext({ mode: "local" }, { localModels: [] }),
  }).recognition;
  assert.equal(
    missing.warning,
    "No Whisper model downloaded: pick another model, or download one in AI Connections"
  );

  const cloudOff = pipeline(lib, {
    stt: sttContext({ mode: "openwhispr" }, { cloudDisabled: true }),
  }).recognition;
  assert.equal(cloudOff.value, "Automatic");
  assert.equal(cloudOff.warning, "Turned off in Privacy & Data");
});

test("dictionary, style and output read the stores they summarize", async (t) => {
  const lib = await load(t);
  const nodes = pipeline(lib);
  // Only active glossary rules count (on, with a spelling).
  assert.equal(nodes.dictionary.value, "Dictionary: 3 · Glossary: 2 · Snippets: 2");
  assert.equal(nodes.dictionary.status, "Opens the Dictionary page");

  const hotkey = lib.formatHotkeyListLabel("Control+`");
  assert.equal(nodes.style.value, `${hotkey}: Plain`);
  assert.equal(nodes.style.status, "On: 1 of 3 · With a hotkey: 1");

  const allOff = pipeline(lib, {
    styleLibrary: library({ teams: false }),
    styleBindings: [],
  }).style;
  assert.equal(allOff.status, "On: 0 of 3 · With a hotkey: 0");

  const styled = pipeline(lib, { styleLibrary: library({ hotkeyStyle: "starter-teams" }) }).style;
  assert.equal(styled.value, `${hotkey}: 💬 Teams chat`);

  assert.equal(nodes.output.value, "Automatic pasting: On");
  assert.equal(nodes.output.status, "Auto-learn from corrections: Off");
  const outputOn = pipeline(lib, { autoLearn: true, settings: { autoPasteEnabled: false } }).output;
  assert.equal(outputOn.value, "Automatic pasting: Off");
  assert.equal(outputOn.status, "Auto-learn from corrections: On");
});

const STT_TEXT = "so um the meeting with little body is uh moved to thursday";
const GLOSSARY_TEXT = "so um the meeting with Little Buddy is uh moved to thursday";
const CLEANUP_TEXT = "The meeting with Little Buddy is moved to Thursday.";
const STYLED_TEXT = "Meeting with Little Buddy moved to Thursday.";

function steps() {
  const step = (kind, output, extra = {}) => ({
    kind,
    outcome: "ok",
    output,
    provider: null,
    model: null,
    ms: null,
    errorCode: null,
    prompt: null,
    detail: null,
    ...extra,
  });
  return {
    success: true,
    status: "captured",
    context: { targetApp: "Code.exe" },
    steps: [
      step("stt", STT_TEXT, { provider: "groq", model: "whisper-large-v3-turbo", ms: 400 }),
      step("glossary", GLOSSARY_TEXT, {
        ms: 1,
        detail: {
          revision: 3,
          rulesFired: [{ ruleId: "a", from: "little body", to: "Little Buddy", index: 23 }],
        },
      }),
      step("cleanup", CLEANUP_TEXT, { model: "claude-haiku-4-5", ms: 700 }),
      step("style", STYLED_TEXT, {
        model: "claude-haiku-4-5",
        ms: 500,
        detail: { styleId: "starter-teams", runMode: "two-step" },
      }),
      // A finalize step that changed nothing is left out.
      step("finalize", STYLED_TEXT, { ms: 0 }),
    ],
  };
}

test("the last dictation's steps become columns named as View steps names them", async (t) => {
  const lib = await load(t);
  const columns = lib.lastDictationColumns(steps(), { t: lib.t, styleLibrary: library() });
  assert.deepEqual(
    columns.map((column) => column.label),
    ["Speech-to-Text", "Glossary", "Cleanup", "Style", "Pasted"]
  );
  const [stt, glossary, cleanup, style, pasted] = columns;
  assert.equal(stt.text, STT_TEXT);
  assert.deepEqual(stt.facts, ["whisper-large-v3-turbo", "400 ms"]);
  // The glossary column marks what it replaced and what it wrote.
  assert.deepEqual(glossary.segments, [
    { text: "so um the meeting with " },
    { text: "little body", change: "removed" },
    { text: "Little Buddy", change: "added" },
    { text: " is uh moved to thursday" },
  ]);
  assert.equal(glossary.facts[0], "Corrections: 1");
  assert.equal(cleanup.text, CLEANUP_TEXT);
  assert.deepEqual(style.facts.slice(0, 2), ["💬 Teams chat", "Two steps"]);
  assert.equal(style.text, STYLED_TEXT);
  assert.equal(pasted.text, undefined);
  assert.deepEqual(pasted.facts, ["App: Code.exe", "1.6 s in total"]);
});

test("a skipped glossary, no corrections, a snippet finalize and a failed step", async (t) => {
  const lib = await load(t);
  const result = steps();
  result.steps[1] = { ...result.steps[1], detail: { revision: 3, rulesFired: [] } };
  result.steps[2] = { ...result.steps[2], outcome: "failed", output: GLOSSARY_TEXT };
  result.steps.push({
    ...result.steps[4],
    output: `${STYLED_TEXT} Best, D.`,
    detail: { snippets: true },
  });
  const columns = lib.lastDictationColumns(result, { t: lib.t, styleLibrary: library() });
  assert.deepEqual(
    columns.map((column) => column.label),
    ["Speech-to-Text", "Glossary", "Cleanup", "Style", "Snippets", "Pasted"]
  );
  assert.equal(columns[1].note, "No corrections");
  assert.equal(columns[1].text, undefined);
  assert.equal(columns[2].outcome, "Failed");

  result.steps[1] = { ...result.steps[1], outcome: "skipped" };
  const skipped = lib.lastDictationColumns(result, { t: lib.t, styleLibrary: library() });
  assert.equal(skipped[1].outcome, "Skipped");
  assert.equal(skipped[1].text, undefined);
  assert.equal(skipped[1].note, undefined);
});

test("glossary marks need offsets that line up; otherwise the corrected text shows", async (t) => {
  const lib = await load(t);
  const fired = [
    { ruleId: "b", from: "thursday", to: "Thursday", index: 50 },
    { ruleId: "a", from: "little body", to: "Little Buddy", index: 23 },
  ];
  assert.deepEqual(
    lib.glossaryDiffSegments(STT_TEXT, fired).map((segment) => segment.change ?? "same"),
    ["same", "removed", "added", "same", "removed", "added"]
  );
  assert.equal(lib.glossaryDiffSegments(STT_TEXT, [{ ...fired[1], index: 3 }]), null);
  assert.equal(lib.glossaryDiffSegments(STT_TEXT, [{ ...fired[1], index: null }]), null);
  assert.equal(lib.glossaryDiffSegments(STT_TEXT, [fired[1], { ...fired[1] }]), null, "overlap");
  assert.equal(lib.glossaryDiffSegments(null, fired), null);

  const result = steps();
  result.steps[1].detail.rulesFired[0].index = 2;
  const [, glossary] = lib.lastDictationColumns(result, { t: lib.t, styleLibrary: library() });
  assert.equal(glossary.segments, undefined);
  assert.equal(glossary.text, GLOSSARY_TEXT);
});

test("the last dictation is the newest completed row", async (t) => {
  const lib = await load(t);
  const row = (id, status, deleted_at = null) => ({ id, status, deleted_at });
  assert.equal(lib.pickLastDictation([]), undefined);
  assert.equal(
    lib.pickLastDictation([row(5, "failed"), row(4, "completed", "x"), row(3, "completed")]).id,
    3
  );
});

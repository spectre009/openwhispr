const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Retry from history runs the same post-speech-to-text boundary as a live
// dictation. History records no target app, so only "anywhere" corrections
// apply, and cleanup sees the corrected transcript. Synthetic fixtures only.

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

// Extracts the real retryTranscription callback from ControlPanel.tsx and runs
// it without mounting the application shell (as cleanupOutputValidation does).
function loadRetryCallback() {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../src/components/ControlPanel.tsx"),
    "utf8"
  );
  const parsed = ts.createSourceFile(
    "ControlPanel.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let callback;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "retryTranscription") {
      callback = node.initializer.arguments[0].getText(parsed);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(callback, "the history retry callback must be present");
  return ts.transpileModule(`const retry = ${callback};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

test("retry from history applies the glossary once, before cleanup", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-retry-glossary-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const settingsModule = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { runPostTranscription } = await vite.ssrLoadModule("/helpers/postTranscription.ts");
  const { providerErrorToastProps } = await vite.ssrLoadModule("/utils/describeProviderError.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  settingsModule.useSettingsStore.setState({
    customPrompts: { cleanup: "" },
    cleanupMode: "local",
    cleanupProvider: "local",
    cleanupModel: "test-model",
  });
  const code = loadRetryCallback();

  const run = async ({ row, useCleanupModel, cleanupReply }) => {
    const sentToCleanup = [];
    const updates = [];
    const toasts = [];
    let displayedRow;
    window.electronAPI.processLocalReasoning = async (...args) => {
      sentToCleanup.push(JSON.stringify(args));
      return { success: true, text: cleanupReply };
    };
    window.electronAPI.retryTranscription = async () => ({ success: true, transcription: row });
    window.electronAPI.updateTranscriptionText = async (id, text, rawText) => {
      updates.push({ id, text, rawText });
      return { success: true, transcription: { ...row, text, raw_text: rawText } };
    };
    const retry = vm.runInNewContext(`${code}\nretry`, {
      require: (id) => {
        if (id === "../services/ReasoningService") return { __esModule: true, default: service };
        if (id === "../stores/settingsStore") return settingsModule;
        throw new Error(`Unexpected history retry import: ${id}`);
      },
      window,
      getSettings: settingsModule.getSettings,
      getManagedTranscriptionResolution: () => null,
      isTranscriptionContextAllowed: () => true,
      usePolicyStore,
      useCleanupModel,
      getAgentName: () => "OpenWhispr",
      hasTextContent: (text) => typeof text === "string" && text.trim().length > 0,
      applyChineseScript: async (text) => text,
      resolveChineseScriptTarget: () => null,
      updateInStore: (value) => {
        displayedRow = value;
      },
      toast: (value) => toasts.push(value),
      t: (key) => key,
      providerErrorToastProps,
      runPostTranscription,
      getGlossarySnapshot: () => ({ revision: 3, rules: [RULE] }),
    });
    await retry(row.id);
    return { sentToCleanup, updates, toasts, displayedRow };
  };

  await t.test("cleanup gets the corrected transcript and the raw one stays raw", async () => {
    const raw = "So littlebuddy, check this.";
    const { sentToCleanup, updates, displayedRow } = await run({
      row: { id: 7, text: raw, raw_text: raw },
      useCleanupModel: true,
      cleanupReply: "So Little Buddy, check this!",
    });
    assert.equal(sentToCleanup.length, 1);
    assert.match(sentToCleanup[0], /So Little Buddy, check this\./);
    assert.doesNotMatch(sentToCleanup[0], /littlebuddy/);
    assert.deepEqual(updates, [{ id: 7, text: "So Little Buddy, check this!", rawText: raw }]);
    assert.equal(displayedRow.text, "So Little Buddy, check this!");
  });

  await t.test("without cleanup the correction alone is saved", async () => {
    const raw = "So littlebuddy, check this.";
    const { updates } = await run({
      row: { id: 8, text: raw, raw_text: raw },
      useCleanupModel: false,
      cleanupReply: "unused",
    });
    assert.deepEqual(updates, [{ id: 8, text: "So Little Buddy, check this.", rawText: raw }]);
  });

  await t.test("no target app is recorded, so start-of-dictation spellings stay", async () => {
    const raw = "Hello, everybody. I need you to look at this.";
    const { updates, displayedRow } = await run({
      row: { id: 9, text: raw, raw_text: raw },
      useCleanupModel: false,
      cleanupReply: "unused",
    });
    assert.deepEqual(updates, []);
    assert.equal(displayedRow.text, raw);
  });
});

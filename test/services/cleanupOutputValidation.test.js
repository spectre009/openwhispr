const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";
const DUPLICATE = `**Cleaned transcript:**\n${CLEAN}\n\n${CLEAN}`;

test("cleanup validates completed provider output using the request's prompt settings", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cleanup-output-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  const setCustomPrompt = (cleanup) => useSettingsStore.setState({ customPrompts: { cleanup } });
  setCustomPrompt("");
  window.electronAPI.processLocalReasoning = async () => ({ success: true, text: DUPLICATE });
  const process = (config = {}) =>
    service.processText(RAW, "test-model", null, {
      provider: "local",
      ...config,
    });

  await t.test("a complete but duplicated local answer fails cleanup", async () => {
    await assert.rejects(process(), { code: "CLEANUP_OUTPUT_INVALID" });
  });

  await t.test("custom and explicit non-cleanup prompts remain unmodified", async () => {
    for (const config of [
      { systemPrompt: "Repeat the text twice" },
      { inferenceScope: "noteFormatting" },
      { requiresAgent: true },
    ]) {
      assert.equal(await process(config), DUPLICATE);
    }
    // A saved custom cleanup prompt turns the check off, as on a real dictation.
    setCustomPrompt("Repeat the text twice");
    assert.equal(await process({ inferenceScope: "dictationCleanup" }), DUPLICATE);
    setCustomPrompt("");
    await assert.rejects(process({ inferenceScope: "dictationCleanup" }), {
      code: "CLEANUP_OUTPUT_INVALID",
    });
  });

  await t.test(
    "settings changes during inference do not change validation eligibility",
    async () => {
      for (const customAtStart of ["", "Repeat the text twice"]) {
        setCustomPrompt(customAtStart);
        window.electronAPI.processLocalReasoning = async () => {
          setCustomPrompt(customAtStart ? "" : "Repeat the text twice");
          return { success: true, text: DUPLICATE };
        };
        if (customAtStart) assert.equal(await process(), DUPLICATE);
        else await assert.rejects(process(), { code: "CLEANUP_OUTPUT_INVALID" });
      }
    }
  );

  await t.test(
    "Cloud, Anthropic, enterprise, Gemini and Custom providers share validation",
    async () => {
      setCustomPrompt("");
      window.electronAPI.cloudReason = async () => ({ success: true, text: DUPLICATE });
      window.electronAPI.processAnthropicReasoning = async () => ({
        success: true,
        text: DUPLICATE,
      });
      window.electronAPI.processEnterpriseReasoning = async () => ({
        success: true,
        text: DUPLICATE,
      });
      window.electronAPI.getGeminiKey = async () => "synthetic-key";
      const originalFetch = globalThis.fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: DUPLICATE }, finish_reason: "stop" }],
            candidates: [{ content: { parts: [{ text: DUPLICATE }] }, finishReason: "STOP" }],
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      for (const config of [
        { provider: "openwhispr" },
        { provider: "anthropic" },
        { provider: "bedrock" },
        { provider: "gemini" },
        {
          provider: "custom",
          baseUrl: "https://cleanup.example.test/v1/chat/completions",
          customApiKey: "synthetic-key",
        },
      ]) {
        await assert.rejects(process(config), { code: "CLEANUP_OUTPUT_INVALID" }, config.provider);
      }
    }
  );

  await t.test("history retry keeps the raw row and reports rejected cleanup", async () => {
    setCustomPrompt("");
    useSettingsStore.setState({
      cleanupMode: "local",
      cleanupProvider: "local",
      cleanupModel: "test-model",
      useCleanupModel: true,
      snippets: [],
    });
    window.electronAPI.processLocalReasoning = async () => ({ success: true, text: DUPLICATE });
    window.electronAPI.updateTranscriptionText = async () =>
      assert.fail("rejected cleanup must not overwrite the row");
    // The part of Re-transcribe and Re-run cleanup after speech-to-text
    // (services/historyRerun.ts), which ControlPanel runs for both.
    const { rerunAfterSpeechToText } = await vite.ssrLoadModule("/services/historyRerun.ts");
    const { providerErrorToastProps } = await vite.ssrLoadModule("/utils/describeProviderError.ts");
    const reported = [];
    const outcome = await rerunAfterSpeechToText(
      {
        id: 123,
        rawText: RAW,
        routeKind: null,
        currentText: RAW,
        stt: { provider: "local", model: "base", ms: null },
        targetApp: null,
        runId: null,
      },
      {
        cleanupFailed: (error) => reported.push(providerErrorToastProps(error, (key) => key)),
        styleNotApplied: () => assert.fail("no style was involved"),
      }
    );
    assert.deepEqual(outcome, { status: "unchanged", text: RAW });
    assert.ok(
      reported.some(
        (toast) => toast.description === "hooks.audioRecording.errorDescriptions.cleanupDuplicated"
      ),
      JSON.stringify(reported)
    );
  });
});

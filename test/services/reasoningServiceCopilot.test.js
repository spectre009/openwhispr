const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// GitHub Copilot serves text-only scopes. processText is also the selection-edit
// and assistant-command path (dictationAgent), so the refusal must happen at
// dispatch, before anything crosses IPC, not only by hiding the tab.

const UNSUPPORTED = "providerErrors.copilot.unsupportedRequest";

async function loadService(t, { authState = "signedIn", reply = "Hello world." } = {}) {
  const calls = { reasoning: [], llama: 0, authStatus: 0 };
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "copilot",
      cleanupModel: "claude-haiku-5.5",
    },
    window: {
      electronAPI: {
        processCopilotReasoning: async (text, model, agentName, config) => {
          calls.reasoning.push({ text, model, agentName, config });
          return { success: true, text: reply };
        },
        getCopilotAuthStatus: async () => {
          calls.authStatus += 1;
          return { configured: true, state: authState, login: "octocat" };
        },
        llamaServerStart: async () => {
          calls.llama += 1;
          return { success: false, error: "local must never be reached" };
        },
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-copilot-dispatch-test-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  return { service, calls, vite };
}

const refusedFor = (reason) => (error) => {
  assert.equal(error.code, "PROVIDER_BAD_REQUEST");
  assert.equal(error.messageKey, UNSUPPORTED);
  assert.equal(error.settingsTarget, "llms");
  assert.equal(error.reason, reason);
  return true;
};

test("processText refuses Copilot for chat, the assistant and screenshots", async (t) => {
  const { service, calls } = await loadService(t);
  const base = { provider: "copilot", systemPrompt: "Do the thing." };

  for (const scope of ["chatIntelligence", "dictationAgent", "dictationAgentVision"]) {
    await assert.rejects(
      service.processText("hi", "claude-haiku-5.5", null, { ...base, inferenceScope: scope }),
      refusedFor("scope"),
      scope
    );
  }
  await assert.rejects(
    service.processText("hi", "claude-haiku-5.5", null, {
      ...base,
      inferenceScope: "dictationCleanup",
      requiresAgent: true,
    }),
    refusedFor("agent")
  );
  await assert.rejects(
    service.processText("hi", "claude-haiku-5.5", null, {
      ...base,
      inferenceScope: "noteFormatting",
      screenContext: { data: "aGk=", mediaType: "image/png" },
    }),
    refusedFor("image")
  );
  assert.equal(calls.reasoning.length, 0, "nothing reached main");
});

test("processText sends the three text scopes to main with their deadlines", async (t) => {
  const { service, calls } = await loadService(t);

  const formatted = await service.processText("raw notes", "gpt-6-luna", null, {
    provider: "copilot",
    inferenceScope: "noteFormatting",
    systemPrompt: "Format these notes.",
    requireCompleteOutput: true,
  });
  assert.equal(formatted, "Hello world.");
  await service.processText("hola", "gpt-6-luna", null, {
    provider: "copilot",
    inferenceScope: "dictationTranslation",
    systemPrompt: "Translate to English.",
  });

  const [note, translation] = calls.reasoning;
  assert.equal(note.model, "gpt-6-luna");
  assert.equal(note.text, "raw notes", "an explicit prompt sends the text as-is");
  assert.equal(note.config.systemPrompt, "Format these notes.");
  assert.equal(note.config.inferenceScope, "noteFormatting");
  assert.equal(note.config.requireCompleteOutput, true);
  assert.equal(note.config.timeoutMs, 600_000, "note formatting gets the long deadline");
  assert.equal(translation.config.inferenceScope, "dictationTranslation");
  assert.equal(translation.config.timeoutMs, 30_000);
});

test("implicit cleanup (no scope, no provider) dispatches to Copilot with the cleanup prompt", async (t) => {
  const { service, calls } = await loadService(t, { reply: "Hello world." });

  const cleaned = await service.processText("hello world", "claude-haiku-5.5");

  assert.equal(cleaned, "Hello world.");
  assert.equal(calls.reasoning.length, 1);
  const [call] = calls.reasoning;
  assert.equal(call.config.inferenceScope, "dictationCleanup");
  assert.ok(call.config.systemPrompt.length > 0, "the cleanup system prompt is supplied");
  assert.notEqual(call.text, "hello world", "the transcript goes in the cleanup wrapper");
  assert.ok(call.text.includes("hello world"));
});

test("a failure from main comes back as the classified error", async (t) => {
  const { service } = await loadService(t);
  globalThis.window.electronAPI.processCopilotReasoning = async () => ({
    success: false,
    error: "You're not signed in to GitHub Copilot.",
    code: "API_KEY_MISSING",
    messageKey: "providerErrors.copilot.notSignedIn",
    settingsTarget: "llms",
  });

  await assert.rejects(
    service.processText("hi", "claude-haiku-5.5", null, {
      provider: "copilot",
      inferenceScope: "noteFormatting",
      systemPrompt: "s",
    }),
    { code: "API_KEY_MISSING", messageKey: "providerErrors.copilot.notSignedIn" }
  );
});

test("Copilot cleanup is available exactly when main reports a sign-in", async (t) => {
  const { service, calls } = await loadService(t);
  const availableWhen = async (state) => {
    globalThis.window.electronAPI.getCopilotAuthStatus = async () => {
      calls.authStatus += 1;
      return { configured: true, state, login: "" };
    };
    return service.isAvailable();
  };

  assert.equal(await availableWhen("signedIn"), true);
  assert.equal(await availableWhen("signedOut"), false);
  assert.equal(await availableWhen("waiting"), false);
  assert.equal(await availableWhen("error"), false);
  assert.equal(calls.authStatus, 4, "main is asked every time; no key is consulted");
});

test("streaming fails closed for Copilot and never starts the local model", async (t) => {
  const { service, calls, vite } = await loadService(t);
  const messages = [{ role: "user", content: "hi" }];

  await assert.rejects(
    service
      .processTextStreaming(messages, "claude-haiku-5.5", "copilot", { systemPrompt: "s" })
      .next(),
    refusedFor("chat")
  );
  await assert.rejects(
    service
      .processTextStreamingAI(messages, "claude-haiku-5.5", "copilot", { systemPrompt: "s" })
      .next(),
    refusedFor("chat")
  );

  const { getAIModel } = await vite.ssrLoadModule("/services/ai/providers.ts");
  await assert.rejects(getAIModel("copilot", "claude-haiku-5.5", ""), refusedFor("chat"));
  assert.equal(calls.llama, 0);
  assert.equal(calls.reasoning.length, 0);
});

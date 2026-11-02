const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// processText records "Last recorded use" at the provider call, once, after
// its retries: before any check of the reply (a repeated transcript still
// counts as the connection working), with the feature that sent it (Styles
// apart from Cleanup), mapped to stage A's descriptor ids. A cancel records
// nothing, and the outcome options never reach a provider. Synthetic text only.

const PROMPT_TEXT = "please send the quarterly report to the whole team today";

async function load(t, electronAPI) {
  const recorded = [];
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", uiLanguage: "en", isSignedIn: "true" },
    window: {
      electronAPI: {
        recordConnectionOutcome: (outcome) => recorded.push(outcome),
        ...electronAPI,
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-connection-outcome-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  const targets = await vite.ssrLoadModule("/helpers/connectionOutcomeTargets.js");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  t.after(() => service.destroy());
  // Reports are fire and forget: give them their microtasks (a custom endpoint's dynamic import).
  const settle = async (count = 0) => {
    for (let i = 0; i < 200 && recorded.length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  return { service, recorded, targets, useSettingsStore, settle };
}

function mockFetch(t, behavior) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return behavior(...args);
  };
  return calls;
}

test("Cloud cleanup: OK at the provider call, even when the reply check rejects it", async (t) => {
  const sent = [];
  let reply = "Cleaned.";
  const { service, recorded, settle } = await load(t, {
    cloudReason: async (text, opts) => {
      sent.push(opts);
      return { success: true, text: reply, model: "cloud" };
    },
  });
  await service.processText(PROMPT_TEXT, "", null, {
    provider: "openwhispr",
    inferenceScope: "dictationCleanup",
  });
  await settle();
  assert.equal(recorded.length, 1);
  const [first] = recorded;
  assert.deepEqual(
    { ...first, startedAt: typeof first.startedAt },
    {
      descriptorId: "cloud",
      slot: null,
      feature: "cleanup",
      ok: true,
      code: "OK",
      startedAt: "number",
    }
  );

  // The provider answered: a repeated transcript is the reply's problem.
  reply = `${PROMPT_TEXT}\n\n${PROMPT_TEXT}`;
  await assert.rejects(
    service.processText(PROMPT_TEXT, "", null, {
      provider: "openwhispr",
      inferenceScope: "dictationCleanup",
    }),
    (error) => error.code === "CLEANUP_OUTPUT_INVALID"
  );
  await settle();
  assert.equal(recorded.length, 2);
  assert.equal(recorded[1].ok, true, "recorded before the validator, as the connection working");

  // A cancel says nothing.
  const cancelling = await load(t, {
    cloudReason: async () => ({ success: false, error: "Cancelled", code: "REASON_CANCELLED" }),
  });
  await assert.rejects(
    cancelling.service.processText(PROMPT_TEXT, "", null, {
      provider: "openwhispr",
      inferenceScope: "dictationCleanup",
    })
  );
  await cancelling.settle();
  assert.deepEqual(cancelling.recorded, []);
  for (const opts of sent) {
    assert.equal(opts.connectionFeature, undefined);
    assert.equal(opts.connectionScope, undefined);
  }
});

test("Styles count as Styles, and a provider's failure is recorded with its code", async (t) => {
  const configs = [];
  let answer = { success: true, text: "Styled." };
  const { service, recorded, settle } = await load(t, {
    processAnthropicReasoning: async (_text, _model, _agent, config) => {
      configs.push(config);
      return answer;
    },
  });
  await service.processText("hello", "claude-sonnet-4-5", null, {
    provider: "anthropic",
    inferenceScope: "dictationCleanup",
    systemPrompt: "Restyle it.",
    connectionFeature: "styles",
  });
  await settle();
  assert.equal(recorded[0].descriptorId, "provider:anthropic");
  assert.equal(recorded[0].feature, "styles", "not Cleanup's");
  assert.equal(configs[0].connectionFeature, undefined, "never crosses IPC to a provider");

  answer = {
    success: false,
    error: "Anthropic rejected your API key.",
    code: "PROVIDER_AUTH_FAILED",
    messageKey: "providerErrors.authFailed",
  };
  await assert.rejects(
    service.processText("hello", "claude-sonnet-4-5", null, {
      provider: "anthropic",
      inferenceScope: "dictationTranslation",
      systemPrompt: "Translate it.",
    })
  );
  await settle();
  assert.deepEqual(
    { feature: recorded[1].feature, ok: recorded[1].ok, code: recorded[1].code },
    { feature: "translation", ok: false, code: "PROVIDER_AUTH_FAILED" }
  );
});

test("a self-hosted server and a feature's own endpoint record on their stage A ids", async (t) => {
  const { service, recorded, targets, useSettingsStore, settle } = await load(t, {});
  // The self-hosted server rejects the key: no retry, one record.
  const calls = mockFetch(t, async () => new Response('{"error":"bad key"}', { status: 401 }));
  await assert.rejects(
    service.processText("clean this up", "some-model", null, {
      lanUrl: "http://127.0.0.1:11434/v1",
      inferenceScope: "dictationCleanup",
    })
  );
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(recorded.length, 1);
  assert.equal(
    recorded[0].descriptorId,
    targets.endpointDescriptorId(
      "selfHosted",
      targets.endpointCheckRoute("http://127.0.0.1:11434/v1", true),
      null
    )
  );
  assert.equal(recorded[0].code, "PROVIDER_AUTH_FAILED");

  // The screen context model's own endpoint and key: its own slot, the assistant's feature.
  const base = "https://vision.example.com/v1";
  useSettingsStore.setState({
    dictationAgentVisionCloudBaseUrl: base,
    dictationAgentVisionCustomApiKey: "vision-key",
  });
  globalThis.fetch = async (url) =>
    String(url).endsWith("/models")
      ? new Response("{}", { status: 404 })
      : new Response(JSON.stringify({ output_text: "Done." }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  await service.processText("what's on screen", "vision-model", null, {
    provider: "custom",
    baseUrl: base,
    customApiKey: "vision-key",
    systemPrompt: "Answer.",
    inferenceScope: "dictationAgent",
    connectionScope: "dictationAgentVision",
  });
  await settle(2);
  assert.equal(recorded.length, 2);
  const vision = recorded.at(-1);
  assert.equal(vision.feature, "assistant");
  assert.equal(vision.slot, "DICTATION_AGENT_VISION_CUSTOM_API_KEY");
  assert.equal(
    vision.descriptorId,
    targets.endpointDescriptorId(
      "endpoint",
      targets.endpointCheckRoute(base, false),
      "DICTATION_AGENT_VISION_CUSTOM_API_KEY"
    )
  );
  assert.ok(!JSON.stringify(recorded).includes("vision-key"), "never a key");
  assert.ok(!JSON.stringify(recorded).includes("vision.example.com"), "never a URL");
});

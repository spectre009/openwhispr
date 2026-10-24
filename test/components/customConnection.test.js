const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The custom connection's pure rules (config/customConnection.js): which
// endpoints it takes and the URL each capability derives from them, which
// features use it (from the real "Used by" routes, inherited URLs and the key
// slot each request reads included), and how a deployment is classified.

const lib = require("../../src/config/customConnection.js");

const ok = (raw) => {
  const result = lib.validateEndpoint(raw);
  assert.equal(result.ok, true, `${raw}: ${result.error}`);
  return result;
};
const refused = (raw, error) => {
  const result = lib.validateEndpoint(raw);
  assert.equal(result.ok, false, raw);
  assert.equal(result.error, error, raw);
  assert.equal(result.languageBase, "", raw);
  assert.equal(result.speechBase, "", raw);
  return result;
};

test("an Azure resource endpoint, on every Azure host, with or without /openai[/v1]", () => {
  for (const host of [
    "littlebuddy-foundry-eus2.openai.azure.com",
    "lb.cognitiveservices.azure.com",
    "lb.services.ai.azure.com",
  ]) {
    for (const suffix of ["", "/", "/openai", "/openai/", "/openai/v1", "/openai/v1/", "//"]) {
      const result = ok(`https://${host}${suffix}`);
      assert.equal(result.kind, "azure");
      assert.equal(result.origin, `https://${host}`);
      assert.equal(result.languageBase, `https://${host}/openai/v1`);
      assert.equal(result.speechBase, `https://${host}`);
      assert.equal(lib.canonicalEndpoint(result), `https://${host}`);
    }
  }
  // Scheme-less input reads as https; the host's case doesn't matter.
  assert.equal(
    ok("LB.OpenAI.Azure.com/openai/v1").languageBase,
    "https://lb.openai.azure.com/openai/v1"
  );
});

test("any other Azure path is refused, not rewritten", () => {
  for (const raw of [
    "https://lb.services.ai.azure.com/api/projects/little-buddy",
    "https://lb.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview",
    "https://lb.openai.azure.com/openai/v1/chat/completions",
    "https://lb.openai.azure.com/openai/v2",
    "https://lb.openai.azure.com/?api-version=2024-10-21",
    "https://user:pass@lb.openai.azure.com/",
  ]) {
    const result = refused(raw, "azureResourceOnly");
    assert.equal(result.kind, "azure", raw);
  }
  refused("http://lb.openai.azure.com/", "httpsRequired");
});

test("an OpenAI-compatible base keeps its path, without trailing slashes or an operation", () => {
  const cases = [
    ["https://gw.example.test/v1", "https://gw.example.test/v1"],
    ["https://gw.example.test/v1///", "https://gw.example.test/v1"],
    ["https://gw.example.test/team/a/v1/", "https://gw.example.test/team/a/v1"],
    ["https://gw.example.test", "https://gw.example.test"],
    ["https://gw.example.test/v1/chat/completions", "https://gw.example.test/v1"],
    ["https://gw.example.test/v1/audio/transcriptions/", "https://gw.example.test/v1"],
    ["gw.example.test/v1", "https://gw.example.test/v1"],
  ];
  for (const [raw, base] of cases) {
    const result = ok(raw);
    assert.equal(result.kind, "openai-compatible", raw);
    assert.equal(result.languageBase, base, raw);
    assert.equal(result.speechBase, base, raw);
    assert.equal(lib.canonicalEndpoint(result), base, raw);
  }
  refused("https://gw.example.test/v1?key=abc", "baseUrlOnly");
  refused("https://me:secret@gw.example.test/v1", "baseUrlOnly");
  refused("https://gw.example.test/v1#x", "baseUrlOnly");
});

test("plain http only reaches private hosts, as isSecureHttpEndpoint allows", async () => {
  const { isSecureHttpEndpoint, isAzureOpenAIEndpoint } =
    await import("../../src/utils/urlUtils.ts");
  const hosts = [
    "localhost:11434",
    "127.0.0.1:8000",
    "10.0.0.7",
    "192.168.1.126:8178",
    "172.20.1.1",
    "100.64.0.9",
    "169.254.1.1",
    "box.local",
    "gpu.tail1234.ts.net",
    "[::1]:8000",
    "[fe80::1]",
    "[fd00::5]",
    "gw.example.test",
    "10.example.com",
    "127.example.com",
    "8.8.8.8",
  ];
  for (const host of hosts) {
    const url = `http://${host}/v1`;
    assert.equal(lib.validateEndpoint(url).ok, isSecureHttpEndpoint(url), url);
    if (!isSecureHttpEndpoint(url)) assert.equal(lib.validateEndpoint(url).error, "httpsRequired");
  }
  // The Azure hosts mirror isAzureOpenAIEndpoint.
  for (const url of [
    "https://a.openai.azure.com",
    "https://a.cognitiveservices.azure.com",
    "https://a.services.ai.azure.com",
    "https://a.azure.com",
    "https://openai.azure.com.example.test",
    "https://api.openai.com",
  ]) {
    assert.equal(lib.validateEndpoint(url).kind === "azure", isAzureOpenAIEndpoint(url), url);
  }
});

test("nothing that isn't an http(s) URL", () => {
  refused("", "required");
  refused("   ", "required");
  refused(undefined, "required");
  refused("ftp://gw.example.test/v1", "invalidUrl");
  refused("https://exa mple/v1", "invalidUrl");
  assert.equal(lib.endpointBase("ftp://x/y"), "");
  assert.equal(
    lib.endpointBase("https://GW.example.test/v1/models?x=1"),
    "https://gw.example.test/v1"
  );
});

test("a deployment is speech-to-text when it transcribes, a language model otherwise", () => {
  for (const name of [
    "gpt-4o-transcribe",
    "gpt-4o-mini-transcribe",
    "whisper",
    "whisper-1",
    "Whisper-Large",
  ]) {
    assert.equal(lib.classifyDeployment(name), "speech", name);
  }
  for (const name of [
    "gpt-5-mini",
    "gpt-4.1-mini",
    "text-embedding-3-small",
    "my-whisperer-chat",
    "",
  ]) {
    assert.equal(lib.classifyDeployment(name), "language", name);
  }
  assert.deepEqual(
    lib.mergeConnectionModels({ language: ["gpt-5-mini"], speech: [] }, [
      { name: "gpt-5-mini", capability: "language" },
      { name: " gpt-4.1-mini ", capability: "language" },
      { name: "gpt-4o-transcribe", capability: "speech" },
      { name: "", capability: "speech" },
    ]),
    { language: ["gpt-5-mini", "gpt-4.1-mini"], speech: ["gpt-4o-transcribe"] }
  );
});

test("the stored setting reads back only when well formed", () => {
  const good = {
    name: " Little Buddy ",
    endpoint: "https://lb.openai.azure.com",
    models: { language: ["a", "a", 3], speech: [] },
  };
  assert.deepEqual(lib.normalizeCustomConnection(good), {
    name: "Little Buddy",
    endpoint: "https://lb.openai.azure.com",
    models: { language: ["a"], speech: [] },
  });
  for (const raw of [
    null,
    "null",
    "",
    "{",
    "[]",
    JSON.stringify({ name: "", endpoint: "https://x", models: { language: [], speech: [] } }),
    JSON.stringify({ name: "x", endpoint: 5, models: { language: [], speech: [] } }),
    JSON.stringify({ name: "x", endpoint: "https://x" }),
    JSON.stringify({ name: "x", endpoint: "https://x", models: { language: "a", speech: [] } }),
  ]) {
    assert.equal(lib.parseCustomConnection(raw), null, String(raw));
  }
  assert.deepEqual(lib.parseCustomConnection(JSON.stringify(good)).models.language, ["a"]);
});

test("moving the endpoint: language models take the new v1 base, speech the origin", () => {
  const next = lib.validateEndpoint("https://new.openai.azure.com/");
  assert.equal(
    lib.rewrittenEndpointUrl("https://old.openai.azure.com/openai/v1", "language", next),
    "https://new.openai.azure.com/openai/v1"
  );
  assert.equal(
    lib.rewrittenEndpointUrl("https://old.openai.azure.com/", "speech", next),
    "https://new.openai.azure.com"
  );
  // A pinned deployment URL keeps its deployment and api-version on the new resource.
  assert.equal(
    lib.rewrittenEndpointUrl(
      "https://old.openai.azure.com/openai/deployments/stt/audio/transcriptions?api-version=2025-03-01-preview",
      "speech",
      next
    ),
    "https://new.openai.azure.com/openai/deployments/stt/audio/transcriptions?api-version=2025-03-01-preview"
  );
  const generic = lib.validateEndpoint("https://gw2.example.test/v1");
  assert.equal(
    lib.rewrittenEndpointUrl("https://gw.example.test/v1", "speech", generic),
    "https://gw2.example.test/v1"
  );
  assert.equal(lib.rewrittenEndpointUrl("x", "language", lib.validateEndpoint("")), "");
});

test("only the fixed key slots are accepted", () => {
  assert.equal(Object.keys(lib.CUSTOM_CONNECTION_SLOTS).length, 7);
  for (const slot of Object.keys(lib.CUSTOM_CONNECTION_SLOTS)) {
    assert.equal(lib.isCustomConnectionSlot(slot), true, slot);
  }
  for (const slot of [
    "OPENAI_API_KEY",
    "CUSTOM_CONNECTION_API_KEY",
    "GITHUB_COPILOT_TOKEN",
    "toString",
    "__proto__",
    "",
    null,
    42,
  ]) {
    assert.equal(lib.isCustomConnectionSlot(slot), false, String(slot));
  }
});

// ── Used by, from the real routes ────────────────────────────────────────────

const AZURE = "https://littlebuddy-foundry-eus2.openai.azure.com";
const KEYS = {
  customTranscriptionApiKey: "stt-SECRET-1111",
  cleanupCustomApiKey: "cleanup-SECRET-2222",
  chatAgentCustomApiKey: "chat-SECRET-3333",
  noteFormattingCustomApiKey: "",
  translationCustomApiKey: "",
};

// Recognition and File Transcription (inherited) on Little Buddy, Chat on its
// v1 API, Cleanup on another server; everything else off the custom provider.
const BASE = {
  isSignedIn: true,
  enterpriseSetupMode: "auto",
  enterpriseTranscriptionSetupMode: "auto",
  transcriptionMode: "providers",
  useLocalWhisper: false,
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "custom",
  cloudTranscriptionModel: "gpt-4o-transcribe",
  cloudTranscriptionBaseUrl: `${AZURE}/`,
  meetingTranscriptionMode: "local",
  meetingLocalTranscriptionProvider: "whisper",
  meetingWhisperModel: "base",
  uploadTranscriptionMode: "providers",
  uploadCloudTranscriptionMode: "byok",
  uploadCloudTranscriptionProvider: "",
  uploadCloudTranscriptionModel: "",
  uploadCloudTranscriptionBaseUrl: "",
  useCleanupModel: true,
  cleanupMode: "providers",
  cleanupCloudMode: "byok",
  cleanupProvider: "custom",
  cleanupModel: "local-gpt",
  cleanupCloudBaseUrl: "https://cleanup.example.test/v1",
  cleanupRemoteUrl: "",
  useDictationAgent: true,
  dictationAgentMode: "providers",
  dictationAgentCloudMode: "byok",
  dictationAgentProvider: "groq",
  dictationAgentModel: "openai/gpt-oss-120b",
  dictationAgentCloudBaseUrl: "",
  useDictationAgentVisionModel: false,
  useDictationTranslation: true,
  translationMode: "providers",
  translationCloudMode: "byok",
  translationProvider: "groq",
  translationModel: "llama-3.3-70b-versatile",
  translationCloudBaseUrl: "",
  translationRemoteUrl: "",
  noteFormattingMode: "providers",
  noteFormattingCloudMode: "byok",
  noteFormattingProvider: "anthropic",
  noteFormattingModel: "claude-sonnet-4-5",
  noteFormattingCloudBaseUrl: "",
  noteFormattingRemoteUrl: "",
  chatAgentMode: "providers",
  chatAgentCloudMode: "byok",
  chatAgentProvider: "custom",
  chatAgentModel: "gpt-5-mini",
  chatAgentCloudBaseUrl: `${AZURE}/openai/v1`,
  chatAgentRemoteUrl: "",
  ...KEYS,
};

async function loadRoutes(t) {
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-custom-connection-" });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const usage = await vite.ssrLoadModule("/components/settings/connectionUsage.ts");
  const connection = await vite.ssrLoadModule("/config/customConnection.js");
  const defaults = store.useSettingsStore.getState();
  const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };
  return (overrides = {}, endpoint = AZURE) => {
    const settings = { ...defaults, ...BASE, ...overrides };
    const usages = usage.computeConnectionUsage({
      settings,
      policy: UNMANAGED,
      cloudDisabled: false,
      stylesInUse: false,
    });
    const uses = connection.featuresUsingConnection(
      usages,
      { name: "Little Buddy", endpoint, models: { language: [], speech: [] } },
      settings
    );
    return { usages, uses };
  };
}

const summary = (uses) =>
  uses.map((use) => [use.feature, use.model, use.slot, use.urlField, use.capability]);

test("Used by follows each feature's real URL and key slot", { timeout: 60000 }, async (t) => {
  const compute = await loadRoutes(t);

  await t.test("on Azure, every feature on the resource's host, inherited ones included", () => {
    const { uses } = compute();
    assert.deepEqual(summary(uses), [
      [
        "recognition",
        "gpt-4o-transcribe",
        "CUSTOM_TRANSCRIPTION_API_KEY",
        "cloudTranscriptionBaseUrl",
        "speech",
      ],
      ["chat", "gpt-5-mini", "CHAT_AGENT_CUSTOM_API_KEY", "chatAgentCloudBaseUrl", "language"],
      [
        "fileTranscription",
        "gpt-4o-transcribe",
        "CUSTOM_TRANSCRIPTION_API_KEY",
        "cloudTranscriptionBaseUrl",
        "speech",
      ],
    ]);
    assert.equal(uses.find((use) => use.feature === "fileTranscription").usage.kind, "inherited");
    // File Transcription's own URL, once set, is the field it reads.
    const own = compute({ uploadCloudTranscriptionBaseUrl: `${AZURE}/openai` }).uses;
    assert.equal(
      own.find((use) => use.feature === "fileTranscription").urlField,
      "uploadCloudTranscriptionBaseUrl"
    );
  });

  await t.test("Note Formatting borrowing Cleanup's endpoint reads Cleanup's field and key", () => {
    const onCleanup = {
      cleanupCloudBaseUrl: `${AZURE}/openai/v1`,
      noteFormattingProvider: "",
      noteFormattingModel: "",
    };
    let nf = compute(onCleanup).uses.find((use) => use.feature === "noteFormatting");
    assert.deepEqual(
      [nf.slot, nf.urlField, nf.model, nf.usage.kind],
      ["CUSTOM_CLEANUP_API_KEY", "cleanupCloudBaseUrl", "local-gpt", "inherited"]
    );
    // Its own key wins over the borrowed one.
    nf = compute({ ...onCleanup, noteFormattingCustomApiKey: "nf-SECRET-4444" }).uses.find(
      (use) => use.feature === "noteFormatting"
    );
    assert.equal(nf.slot, "NOTE_FORMATTING_CUSTOM_API_KEY");
    assert.equal(nf.urlField, "cleanupCloudBaseUrl");
    // Its own URL: its own field and key slot.
    nf = compute({
      noteFormattingProvider: "custom",
      noteFormattingModel: "gpt-4.1-mini",
      noteFormattingCloudBaseUrl: `${AZURE}/openai/v1`,
    }).uses.find((use) => use.feature === "noteFormatting");
    assert.deepEqual(
      [nf.slot, nf.urlField],
      ["NOTE_FORMATTING_CUSTOM_API_KEY", "noteFormattingCloudBaseUrl"]
    );
  });

  await t.test("a scope with no key of its own on Cleanup's URL sends Cleanup's key", () => {
    const { uses } = compute({
      cleanupCloudBaseUrl: `${AZURE}/openai/v1`,
      translationProvider: "custom",
      translationModel: "gpt-4.1-mini",
      translationCloudBaseUrl: `${AZURE}/openai/v1`,
    });
    const translation = uses.find((use) => use.feature === "translation");
    assert.equal(translation.slot, "CUSTOM_CLEANUP_API_KEY");
    assert.equal(translation.urlField, "translationCloudBaseUrl");
  });

  await t.test("on a generic host, only the same base path counts", () => {
    const overrides = {
      cloudTranscriptionProvider: "groq",
      chatAgentCloudBaseUrl: "https://gw.example.test/v1/",
      translationProvider: "custom",
      translationModel: "other-model",
      translationCloudBaseUrl: "https://gw.example.test/other/v1",
    };
    const { uses } = compute(overrides, "https://gw.example.test/v1");
    assert.deepEqual(
      uses.map((use) => use.feature),
      ["chat"]
    );
    assert.deepEqual(
      compute(overrides, "https://gw.example.test/other/v1").uses.map((use) => use.feature),
      ["translation"]
    );
  });

  await t.test("untagged and unrelated custom endpoints never join", () => {
    // A custom pick with no URL, and one on another host.
    const { usages, uses } = compute({ chatAgentCloudBaseUrl: "" });
    assert.ok(
      usages.some((usage) => usage.feature === "chat" && usage.connection.type === "custom")
    );
    assert.equal(
      uses.find((use) => use.feature === "chat"),
      undefined,
      "no URL, no match"
    );
    assert.equal(
      uses.find((use) => use.feature === "cleanup"),
      undefined,
      "another host"
    );
    // A custom usage that doesn't say where its URL comes from is never matched.
    const stripped = usages.map(({ customEndpoint: _ignored, ...usage }) => usage);
    assert.deepEqual(lib.featuresUsingConnection(stripped, { endpoint: AZURE }, { ...BASE }), []);
    // No connection, or one that can't be used: nothing.
    assert.deepEqual(lib.featuresUsingConnection(usages, null, BASE), []);
    assert.deepEqual(
      lib.featuresUsingConnection(usages, { endpoint: `${AZURE}/api/projects/x` }, BASE),
      []
    );
  });

  await t.test("no key reaches the result", () => {
    const text = JSON.stringify(compute().uses);
    for (const secret of Object.values(KEYS).filter(Boolean)) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
  });
});

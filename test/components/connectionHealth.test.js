const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Connection checks on Settings › AI Connections, the renderer's pure half
// (components/settings/connectionHealth.ts): descriptors built from names only
// (route, slot, models, generation; never a key) for every saved connection
// the page lists, policy-forbidden ones not probed; results read as pill
// states and combined per card (Corti's two halves); a result about another
// generation ignored; the Settings menu's dot only from active usages' own
// failures; and the model pickers' advisory metadata, which never makes an
// option unavailable.

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };
const AZURE = "https://littlebuddy-foundry-eus2.openai.azure.com";
const SECRETS = {
  groqApiKey: "gsk_SECRET-groq-1",
  geminiApiKey: "AIzaSECRET-gemini-2",
  openrouterApiKey: "sk-or-SECRET-3",
  cortiApiKey: "corti-SECRET-4",
  cortiClientId: "corti-id-SECRET-5",
  cortiClientSecret: "corti-secret-SECRET-6",
  azureSpeechApiKey: "azspeech-SECRET-7",
  customConnectionApiKey: "conn-SECRET-8",
  customTranscriptionApiKey: "conn-SECRET-8",
  noteFormattingCustomApiKey: "nf-SECRET-9",
  tinfoilApiKey: "tinfoil-SECRET-10",
};

async function load(t) {
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-connection-health-" });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const usage = await vite.ssrLoadModule("/components/settings/connectionUsage.ts");
  const custom = await vite.ssrLoadModule("/config/customConnection.js");
  const health = await vite.ssrLoadModule("/components/settings/connectionHealth.ts");
  const options = await vite.ssrLoadModule("/components/settings/modelPicker/options.ts");
  const stt = await vite.ssrLoadModule("/components/settings/modelPicker/sttOptions.ts");
  const targets = await vite.ssrLoadModule("/helpers/connectionOutcomeTargets.js");
  return { ...store, ...usage, ...custom, ...health, options, stt, targets };
}

function setup(lib, overrides = {}, { policy = UNMANAGED, copilotSignedIn = true } = {}) {
  const settings = {
    ...lib.useSettingsStore.getState(),
    ...SECRETS,
    isSignedIn: true,
    useCleanupModel: true,
    cleanupMode: "providers",
    cleanupProvider: "groq",
    cleanupModel: "llama-3.3-70b-versatile",
    useDictationTranslation: true,
    translationMode: "providers",
    translationProvider: "copilot",
    translationModel: "gpt-5-mini",
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionModel: "gpt-4o-transcribe",
    cloudTranscriptionBaseUrl: `${AZURE}/`,
    meetingTranscriptionMode: "local",
    uploadTranscriptionMode: "providers",
    uploadCloudTranscriptionMode: "byok",
    uploadCloudTranscriptionProvider: "azure-speech",
    uploadCloudTranscriptionModel: "MAI-Transcribe-2",
    azureSpeechEndpoint: "https://littlebuddy-speech.cognitiveservices.azure.com",
    noteFormattingMode: "providers",
    noteFormattingProvider: "custom",
    noteFormattingModel: "my-model",
    noteFormattingCloudBaseUrl: "https://gateway.example.test/v1/chat/completions",
    chatAgentMode: "self-hosted",
    chatAgentModel: "qwen3:8b",
    chatAgentRemoteUrl: "192.168.1.20:11434/v1",
    dictationAgentMode: "openwhispr",
    customConnection: {
      name: "Little Buddy",
      endpoint: AZURE,
      models: { language: [], speech: ["gpt-4o-transcribe"] },
    },
    ...overrides,
  };
  const usages = lib.computeConnectionUsage({
    settings,
    policy,
    cloudDisabled: false,
    stylesInUse: false,
  });
  const connectionUses = lib.featuresUsingConnection(usages, settings.customConnection, settings);
  const plan = lib.buildCheckPlan({
    settings,
    usages,
    policy,
    cloudDisabled: false,
    copilotSignedIn,
    connection: settings.customConnection,
    connectionUses,
  });
  return { settings, usages, plan };
}

const byOwner = (plan, owner) => plan.targets.filter((item) => item.owner === owner);
const descriptorOf = (plan, id) =>
  plan.targets.find((item) => item.descriptor.id === id)?.descriptor;
const result = (descriptor, fields) => ({
  reachable: true,
  credentials: "accepted",
  models: {},
  proof: "key",
  code: "OK",
  checkedAt: 1000,
  generation: descriptor.generation,
  ...fields,
});

test("connection checks, the renderer's model", { timeout: 60000 }, async (t) => {
  const lib = await load(t);

  await t.test("descriptors: names only, one per thing the page lists", () => {
    const { plan } = setup(lib);
    const text = JSON.stringify(plan);
    for (const secret of Object.values(SECRETS)) {
      assert.ok(!text.includes(secret), `${secret} in a descriptor`);
    }
    const groq = descriptorOf(plan, "provider:groq");
    assert.deepEqual(
      { kind: groq.kind, route: groq.route, slot: groq.slot, models: groq.models },
      {
        kind: "groq",
        route: "https://api.groq.com/openai/v1",
        slot: "GROQ_API_KEY",
        models: ["llama-3.3-70b-versatile"],
      }
    );
    // Saved but unused: checked too, with no models to compare.
    assert.deepEqual(descriptorOf(plan, "provider:gemini").models, []);
    assert.equal(descriptorOf(plan, "provider:openrouter").route, "https://openrouter.ai/api/v1");
    assert.equal(descriptorOf(plan, "provider:tinfoil").slot, "TINFOIL_API_KEY");
    // Corti: two halves on one card.
    assert.deepEqual(
      byOwner(plan, "corti").map((item) => [
        item.descriptor.kind,
        item.part,
        item.descriptor.route,
      ]),
      [
        ["corti-llm", "llm", "https://ai.eu.corti.app/v1"],
        ["corti-stt", "stt", "https://auth.us.corti.app/realms/base"],
      ]
    );
    assert.equal(descriptorOf(plan, "corti:stt").slot, "CORTI_CLIENT_CREDENTIALS");
    const speech = descriptorOf(plan, "provider:azure-speech");
    assert.equal(speech.route, "https://littlebuddy-speech.cognitiveservices.azure.com");
    assert.deepEqual(speech.models, ["MAI-Transcribe-2"]);
    // Copilot while signed in; Cloud while on and signed in (checked here, not by main).
    assert.deepEqual(descriptorOf(plan, "copilot").models, ["gpt-5-mini"]);
    assert.equal(descriptorOf(plan, "cloud").kind, "cloud");
    // The custom connection: its canonical endpoint and its own key.
    const custom = descriptorOf(plan, "custom");
    assert.deepEqual(
      { route: custom.route, slot: custom.slot, models: custom.models },
      { route: AZURE, slot: "CUSTOM_CONNECTION_API_KEY", models: ["gpt-4o-transcribe"] }
    );
    // The endpoint rows: a feature's custom endpoint with its own slot, a self-hosted server.
    const [nf] = byOwner(plan, "endpoint:noteFormatting");
    assert.deepEqual(
      { kind: nf.descriptor.kind, route: nf.descriptor.route, slot: nf.descriptor.slot },
      {
        kind: "endpoint",
        route: "https://gateway.example.test/v1",
        slot: "NOTE_FORMATTING_CUSTOM_API_KEY",
      }
    );
    assert.deepEqual(nf.secretFields, ["noteFormattingCustomApiKey"]);
    const [chat] = byOwner(plan, "endpoint:chat");
    assert.deepEqual(
      { kind: chat.descriptor.kind, route: chat.descriptor.route, slot: chat.descriptor.slot },
      { kind: "selfHosted", route: "http://192.168.1.20:11434/v1", slot: null }
    );
    // Recognition is on the connection: its row moved to the card.
    assert.deepEqual(byOwner(plan, "endpoint:recognition"), []);
    // A feature on the connection's endpoint with another key isn't vouched for by its check.
    const otherKey = setup(lib, { customTranscriptionApiKey: "another-SECRET" });
    assert.deepEqual(descriptorOf(otherKey.plan, "custom").models, []);
    assert.deepEqual(
      byOwner(otherKey.plan, "custom")[0].uses.map((use) => use.feature),
      [],
      "matched by the same key, never by host alone"
    );
  });

  await t.test("generations follow route, slot and models; nothing else", () => {
    const first = descriptorOf(setup(lib).plan, "provider:groq").generation;
    assert.equal(descriptorOf(setup(lib).plan, "provider:groq").generation, first, "stable");
    const otherModel = setup(lib, { cleanupModel: "llama-3.1-8b-instant" });
    assert.notEqual(descriptorOf(otherModel.plan, "provider:groq").generation, first);
    const tenant = setup(lib, { cortiTenant: "acme" });
    assert.notEqual(
      descriptorOf(tenant.plan, "corti:stt").generation,
      descriptorOf(setup(lib).plan, "corti:stt").generation,
      "a tenant edit"
    );
    // A key change isn't in the generation: main fences that by its credential generation.
    const newKey = setup(lib, { groqApiKey: "gsk_SECRET-other" });
    assert.equal(descriptorOf(newKey.plan, "provider:groq").generation, first);
  });

  await t.test("not probed: policy-forbidden, managed, incomplete or invalid", () => {
    const policy = {
      status: "managed",
      appVersion: "1.10.3",
      policy: {
        version: 1,
        transcription: { allowedModes: ["providers", "local"], allowedByokProviders: ["openai"] },
        llm: {
          allowedModes: ["providers", "local"],
          allowedByokProviders: ["openai"],
          allowedEnterpriseProviders: [],
        },
        features: { agentEnabled: true, webSearchEnabled: true, screenContextEnabled: true },
        sharing: { externalLinkSharing: "allowed" },
        dataRetention: {
          audioRetentionMaxDays: null,
          localHistoryMode: "user_choice",
          cloudBackupAllowed: true,
        },
        minAppVersion: null,
      },
    };
    const { plan } = setup(lib, {}, { policy });
    assert.equal(descriptorOf(plan, "provider:groq"), undefined, "not probed");
    assert.equal(plan.skipped.groq, "managed");
    assert.equal(plan.skipped.copilot, "managed");
    const noEndpoint = setup(lib, { azureSpeechEndpoint: "" });
    assert.equal(noEndpoint.plan.skipped["azure-speech"], "endpointNeeded");
    const incomplete = setup(lib, { cortiApiKey: "", cortiClientSecret: "" });
    assert.equal(incomplete.plan.skipped.corti, "incomplete");
    const signedOut = setup(lib, {}, { copilotSignedIn: false });
    assert.equal(descriptorOf(signedOut.plan, "copilot"), undefined);
    const badUrl = setup(lib, { noteFormattingCloudBaseUrl: "http://public.example.com/v1" });
    assert.equal(badUrl.plan.skipped["endpoint:noteFormatting"], "invalidEndpoint");
  });

  await t.test("states, a card's worst half, and only the current generation", () => {
    const { plan } = setup(lib);
    const groq = descriptorOf(plan, "provider:groq");
    const states = [
      [{}, "ok"],
      [{ credentials: "rejected", code: "PROVIDER_AUTH_FAILED" }, "rejected"],
      [{ reachable: false, credentials: "unknown", code: "PROVIDER_TIMEOUT" }, "unreachable"],
      [{ credentials: "unknown", code: "PROVIDER_RATE_LIMITED" }, "rateLimited"],
      [{ code: "CHECK_LIMIT_REACHED" }, "limitReached"],
      [{ credentials: "rejected", code: "CHECK_MANAGEMENT_KEY" }, "managementKey"],
      [{ credentials: "unknown", code: "PROVIDER_ACCESS_DENIED" }, "accessDenied"],
      [{ models: { x: "missing" } }, "modelMissing"],
      [{ models: { x: "unknown" } }, "ok"],
      [
        { credentials: "unknown", code: "CHECK_NOT_VERIFIABLE", proof: "reachability" },
        "notVerifiable",
      ],
      [{ proof: "identity" }, "signedIn"],
      [{ proof: "service" }, "service"],
      [{ code: "API_KEY_MISSING", reachable: false, credentials: "unknown" }, "notChecked"],
    ];
    for (const [fields, state] of states) {
      assert.equal(lib.stateOf(result(groq, fields)), state, JSON.stringify(fields));
    }
    const [llm, sttHalf] = byOwner(plan, "corti").map((item) => item.descriptor);
    const corti = lib.ownerHealth(
      "corti",
      plan,
      {
        [llm.id]: result(llm, {}),
        [sttHalf.id]: result(sttHalf, { credentials: "rejected", code: "PROVIDER_AUTH_FAILED" }),
      },
      {}
    );
    assert.equal(corti.state, "rejected");
    assert.equal(corti.tone, "danger");
    // A result about another generation isn't shown; a pending check keeps the current one.
    const stale = lib.ownerHealth(
      "groq",
      plan,
      { [groq.id]: { ...result(groq, {}), generation: "old" } },
      {}
    );
    assert.equal(stale.state, "unchecked");
    const checking = lib.ownerHealth(
      "groq",
      plan,
      { [groq.id]: result(groq, { credentials: "rejected", code: "PROVIDER_AUTH_FAILED" }) },
      { [groq.id]: groq.generation }
    );
    assert.equal(checking.state, "rejected", "the previous result stays");
    assert.equal(checking.checking, true);
  });

  await t.test("the menu dot: active usages' own failures only", () => {
    const { plan } = setup(lib);
    const groq = descriptorOf(plan, "provider:groq");
    const gemini = descriptorOf(plan, "provider:gemini");
    const custom = descriptorOf(plan, "custom");
    const rejected = { credentials: "rejected", code: "PROVIDER_AUTH_FAILED" };
    assert.equal(lib.connectionsFlag(plan, {}), null);
    assert.equal(
      lib.connectionsFlag(plan, { [gemini.id]: result(gemini, rejected) }),
      null,
      "unused"
    );
    assert.equal(lib.connectionsFlag(plan, { [groq.id]: result(groq, rejected) }), "danger");
    assert.equal(
      lib.connectionsFlag(plan, {
        [groq.id]: result(groq, { credentials: "unknown", code: "PROVIDER_RATE_LIMITED" }),
      }),
      "warning"
    );
    assert.equal(
      lib.connectionsFlag(plan, {
        [custom.id]: result(custom, { models: { "gpt-4o-transcribe": "missing" } }),
      }),
      "danger",
      "a used model missing"
    );
    // A missing model only an off feature uses flags nothing.
    const off = setup(lib, { useCleanupModel: false, translationProvider: "openai" });
    const offGroq = descriptorOf(off.plan, "provider:groq");
    assert.deepEqual(offGroq.models, [], "an off feature's model isn't compared");
    assert.equal(
      lib.connectionsFlag(off.plan, {
        [offGroq.id]: result(offGroq, { models: { "llama-3.3-70b-versatile": "missing" } }),
      }),
      null
    );
    // The summary: red for a used connection's failure, amber otherwise.
    assert.equal(
      lib.summarizeHealth(plan, { [groq.id]: result(groq, rejected) }, {}).tone,
      "danger"
    );
    assert.equal(
      lib.summarizeHealth(plan, { [gemini.id]: result(gemini, rejected) }, {}).tone,
      "warning"
    );
  });

  await t.test("picker advice is metadata: an available option stays available", () => {
    const { plan } = setup(lib);
    const gemini = descriptorOf(plan, "provider:gemini");
    const groq = descriptorOf(plan, "provider:groq");
    const health = lib.pickerHealthMap(plan, {
      [gemini.id]: result(gemini, { credentials: "rejected", code: "PROVIDER_AUTH_FAILED" }),
      [groq.id]: result(groq, { models: { "llama-3.3-70b-versatile": "missing" } }),
    });
    assert.deepEqual(Object.keys(health).sort(), ["gemini", "groq"]);
    const option = (provider, model, available = true) => ({
      id: `provider:${provider}:${model}`,
      label: { text: model },
      icon: provider,
      available,
      mode: "providers",
      cloudMode: "byok",
      provider,
      model,
    });
    const advice = lib.options.llmOptionAdvice(option("gemini", "gemini-2.5-flash"), health);
    assert.equal(advice.tone, "danger");
    assert.equal(advice.reasonKey, "modelPicker.health.rejected");
    assert.deepEqual(advice.params, { provider: "Google Gemini" });
    assert.deepEqual(advice.link, {
      kind: "settings",
      destination: "connections#connections.gemini",
      labelKey: "modelPicker.health.fix",
    });
    // Only the missing model's option on Groq; never an unavailable option's.
    assert.equal(
      lib.options.llmOptionAdvice(option("groq", "llama-3.3-70b-versatile"), health).reasonKey,
      "modelPicker.health.modelMissing"
    );
    assert.equal(lib.options.llmOptionAdvice(option("groq", "llama-3.1-8b-instant"), health), null);
    assert.equal(
      lib.options.llmOptionAdvice(
        option("gemini", "gemini-2.5-flash", { reasonKey: "modelPicker.reasons.noKey" }),
        health
      ),
      null
    );
    const sttAdvice = lib.stt.sttOptionAdvice(
      { ...option("gemini", "gemini-2.5-flash"), cloudMode: undefined },
      health
    );
    assert.equal(sttAdvice.reasonKey, "modelPicker.health.rejected");
  });

  await t.test("last recorded use: requests land on the ids the cards read", () => {
    const { settings, plan } = setup(lib);
    const outcome = (feature, ok, code, at) => ({ feature, ok, code, at });
    // A live dictation on the connection's endpoint records on Recognition's
    // own endpoint id, which the connection's card reads.
    const dictation = lib.targets.transcriptionOutcomeTag(
      { transport: "http-batch", provider: "custom" },
      settings,
      "recognition"
    );
    assert.equal(dictation.slot, "CUSTOM_TRANSCRIPTION_API_KEY");
    const [custom] = byOwner(plan, "custom");
    assert.ok(custom.outcomeIds.includes(dictation.descriptorId), custom.outcomeIds.join());
    // Note formatting's own endpoint: the request's id is its row's descriptor.
    const nf = lib.targets.llmOutcomeTarget({
      provider: "custom",
      baseUrl: settings.noteFormattingCloudBaseUrl,
      slot: lib.llmCustomEndpoint("noteFormatting", settings).slot,
    });
    assert.equal(nf.id, byOwner(plan, "endpoint:noteFormatting")[0].descriptor.id);
    // The self-hosted chat server.
    const chat = lib.targets.llmOutcomeTarget({
      provider: "lan",
      lanUrl: settings.chatAgentRemoteUrl,
    });
    assert.equal(chat.id, byOwner(plan, "endpoint:chat")[0].descriptor.id);

    const outcomes = {
      [dictation.descriptorId]: {
        last: outcome("recognition", true, "OK", 3000),
        lastFailure: outcome("recognition", false, "PROVIDER_TIMEOUT", 2000),
      },
      "corti:llm": { last: outcome("cleanup", true, "OK", 1000), lastFailure: null },
      "corti:stt": {
        last: outcome("recognition", false, "PROVIDER_AUTH_FAILED", 1500),
        lastFailure: outcome("recognition", false, "PROVIDER_AUTH_FAILED", 1500),
      },
      "provider:nowhere": { last: outcome("chat", true, "OK", 9000), lastFailure: null },
    };
    assert.deepEqual(lib.ownerLastUse("custom", plan, outcomes), outcomes[dictation.descriptorId]);
    // Corti's card: the newest of its two halves, and the newest failure.
    assert.deepEqual(lib.ownerLastUse("corti", plan, outcomes), {
      last: outcomes["corti:stt"].last,
      lastFailure: outcomes["corti:stt"].lastFailure,
    });
    // Nothing recorded: no line.
    assert.equal(lib.ownerLastUse("groq", plan, outcomes), null);
    assert.equal(lib.ownerLastUse("gemini", plan, {}), null);
    // A feature whose slot holds another key isn't the connection's use.
    const otherKey = setup(lib, { customTranscriptionApiKey: "another-SECRET" });
    assert.ok(!byOwner(otherKey.plan, "custom")[0].outcomeIds.includes(dictation.descriptorId));
    assert.equal(lib.ownerLastUse("custom", otherKey.plan, outcomes), null);
    assert.ok(!JSON.stringify(custom.outcomeIds).includes("azure"), "hashes, never a URL");
  });
});

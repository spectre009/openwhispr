const nodeTest = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The speech-to-text picker's options (settings/modelPicker/sttOptions.ts), per
// surface (Recognition, Live Recording, File Transcription) × policy × Cloud
// switch × sign-in × saved keys × downloaded models × the surface's streaming
// rule: what policy and the surface rule out is hidden, as the old mode cards
// and provider tabs hid it; what the user can fix is listed unavailable with
// its reason and a link; the button and the inherited fields say what really
// runs, including when it can't.

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };

const managedPolicy = (transcription) => ({
  status: "managed",
  appVersion: "1.10.3",
  policy: {
    version: 1,
    transcription: { allowedEnterpriseProviders: [], ...transcription },
    llm: { allowedModes: ["providers"], allowedByokProviders: ["openai"] },
    features: { agentEnabled: true, webSearchEnabled: true, screenContextEnabled: true },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    minAppVersion: null,
  },
});

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
  "azure-speech": true,
};

const DOWNLOADED = [
  { id: "base", engine: "whisper", size: "142 MB" },
  { id: "parakeet-tdt-0.6b-v3", engine: "sherpa", size: "680 MB" },
  { id: "nemotron-speech-streaming-en-0.6b", engine: "sherpa" },
  { id: "cohere-transcribe-03-2026", engine: "sherpa", size: "2.7 GB" },
  { id: "orukeet-v0.1.0", engine: "sherpa" },
];

const FOUNDRY = "https://contoso-foundry.cognitiveservices.azure.com/openai/v1";

const subtests = [];
const test = (name, fn) => subtests.push([name, fn]);

let stt;

async function load(t) {
  if (stt) return stt;
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-stt-picker-options-" });
  stt = await vite.ssrLoadModule("/components/settings/modelPicker/sttOptions.ts");
  return stt;
}

function context(overrides = {}) {
  const { current, ...rest } = overrides;
  return {
    policy: UNMANAGED,
    cloudDisabled: false,
    isSignedIn: true,
    keys: ALL_KEYS,
    localModels: DOWNLOADED,
    ...rest,
    current: {
      mode: "providers",
      cloudProvider: "openai",
      cloudModel: "gpt-4o-transcribe",
      cloudBaseUrl: "https://api.openai.com/v1",
      localProvider: "whisper",
      localModel: "base",
      remoteUrl: "",
      remoteModel: "",
      ...current,
    },
  };
}

const groupIds = (groups) => groups.map((group) => group.id);
const options = (groups) => groups.flatMap((group) => group.options);
const find = (groups, id) => options(groups).find((option) => option.id === id);
const groupOptions = (groups, id) =>
  (groups.find((group) => group.id === id)?.options ?? []).map((option) => option.id);

test("a full setup offers every connection the surface can run, in order", async (t) => {
  const { buildSttPickerOptions } = await load(t);
  const dictation = buildSttPickerOptions("dictation", context());
  assert.deepEqual(groupIds(dictation), [
    "cloud",
    "provider:openai",
    "provider:groq",
    "provider:xai",
    "provider:mistral",
    "provider:gemini",
    "provider:corti",
    "provider:tinfoil",
    "provider:deepgram",
    "provider:assemblyai",
    "provider:azure-speech",
    "custom",
    "local",
    "selfHosted",
  ]);
  assert.ok(
    options(dictation).every((option) => option.available === true),
    "everything on Recognition is pickable"
  );
  assert.deepEqual(groupOptions(dictation, "provider:gemini"), [
    "provider:gemini:gemini-3.5-transcribe",
    "provider:gemini:gemini-3.5-transcribe-live",
  ]);

  // Live recording streams: only the providers main can stream notes with, only
  // their streaming models, no custom endpoint; self-hosted as "not yet".
  const live = buildSttPickerOptions("liveRecording", context());
  assert.deepEqual(groupIds(live), [
    "cloud",
    "provider:openai",
    "provider:corti",
    "provider:tinfoil",
    "provider:deepgram",
    "provider:assemblyai",
    "local",
    "selfHosted",
  ]);
  assert.deepEqual(groupOptions(live, "provider:openai"), [
    "provider:openai:gpt-4o-mini-transcribe",
    "provider:openai:gpt-4o-transcribe",
  ]);
  assert.deepEqual(find(live, "selfHosted").available, {
    reasonKey: "modelPicker.stt.reasons.selfHostedLiveRecording",
  });
  // Every downloaded local engine runs live recording (decoded on this computer).
  assert.deepEqual(
    groupOptions(live, "local"),
    groupOptions(dictation, "local"),
    "local models aren't filtered for live recording"
  );

  // Uploads batch: the live-only providers are hidden.
  const upload = buildSttPickerOptions("fileTranscription", context());
  assert.deepEqual(groupIds(upload), [
    "cloud",
    "provider:openai",
    "provider:groq",
    "provider:xai",
    "provider:mistral",
    "provider:gemini",
    "provider:corti",
    "provider:tinfoil",
    "provider:azure-speech",
    "custom",
    "local",
    "selfHosted",
  ]);
});

test("policy hides modes and providers as the mode cards and provider tabs did", async (t) => {
  const { buildSttPickerOptions } = await load(t);
  const policy = managedPolicy({
    allowedModes: ["providers", "local"],
    allowedByokProviders: ["openai", "groq"],
  });
  const dictation = buildSttPickerOptions("dictation", context({ policy }));
  assert.deepEqual(groupIds(dictation), ["provider:openai", "provider:groq", "local"]);
  const live = buildSttPickerOptions("liveRecording", context({ policy }));
  assert.deepEqual(groupIds(live), ["provider:openai", "local"], "Groq can't stream");

  // Enterprise: offered on Recognition and uploads only, and only when policy names Azure.
  const enterprise = managedPolicy({
    allowedModes: ["providers", "enterprise", "self-hosted"],
    allowedByokProviders: ["custom"],
    allowedEnterpriseProviders: ["azure"],
  });
  for (const surface of ["dictation", "fileTranscription"]) {
    const groups = buildSttPickerOptions(surface, context({ policy: enterprise }));
    assert.deepEqual(groupIds(groups), ["custom", "selfHosted", "enterprise"], surface);
    assert.equal(find(groups, "enterprise").available, true);
  }
  assert.deepEqual(
    groupIds(buildSttPickerOptions("liveRecording", context({ policy: enterprise }))),
    ["selfHosted"],
    "live recording: no enterprise lane, no custom endpoint, self-hosted as 'not yet'"
  );
  const noAzure = managedPolicy({
    allowedModes: ["providers", "enterprise"],
    allowedByokProviders: ["openai"],
  });
  assert.deepEqual(groupIds(buildSttPickerOptions("dictation", context({ policy: noAzure }))), [
    "provider:openai",
  ]);
  // Unmanaged users never see the enterprise mode (it can't resolve without an org).
  assert.equal(find(buildSttPickerOptions("dictation", context()), "enterprise"), undefined);

  // A managed deployment the surface can use offers it (#2989): uploads with a batch one,
  // live recording with a realtime one, even without a managed policy; Recognition only
  // under a policy that offers it, as its mode cards did.
  const available = context({ managedAvailable: true });
  assert.equal(
    find(buildSttPickerOptions("fileTranscription", available), "enterprise").available,
    true
  );
  assert.equal(
    find(buildSttPickerOptions("liveRecording", available), "enterprise").available,
    true
  );
  assert.deepEqual(groupIds(buildSttPickerOptions("liveRecording", available)).slice(-2), [
    "selfHosted",
    "enterprise",
  ]);
  assert.equal(find(buildSttPickerOptions("dictation", available), "enterprise"), undefined);
  assert.deepEqual(
    groupIds(
      buildSttPickerOptions(
        "liveRecording",
        context({ policy: enterprise, managedAvailable: true })
      )
    ),
    ["selfHosted", "enterprise"],
    "live recording's enterprise lane follows the realtime deployment and the policy's providers"
  );

  // A policy still loading offers nothing yet.
  const loading = { status: "loading", policy: null, appVersion: "1.10.3" };
  assert.deepEqual(buildSttPickerOptions("dictation", context({ policy: loading })), []);
});

test("Cloud off and signed out are listed with their reason and link", async (t) => {
  const { buildSttPickerOptions } = await load(t);
  for (const surface of ["dictation", "liveRecording", "fileTranscription"]) {
    const off = find(buildSttPickerOptions(surface, context({ cloudDisabled: true })), "cloud");
    assert.deepEqual(off.available, {
      reasonKey: "modelPicker.reasons.cloudOff",
      link: {
        kind: "settings",
        destination: "privacyData#privacy.cloud",
        labelKey: "modelPicker.links.openPrivacy",
      },
    });
    const signedOut = buildSttPickerOptions(surface, context({ isSignedIn: false }));
    assert.deepEqual(find(signedOut, "cloud").available, {
      reasonKey: "modelPicker.reasons.signedOut",
      link: { kind: "signIn", labelKey: "modelPicker.links.signIn" },
    });
    assert.deepEqual(signedOut[0].meta, { key: "connections.status.notSignedIn" });
  }
});

test("a provider without saved credentials is one entry linking to its key", async (t) => {
  const { buildSttPickerOptions, sttKeyPresence } = await load(t);
  const groups = buildSttPickerOptions("dictation", context({ keys: { groq: true } }));
  assert.deepEqual(groupIds(groups).slice(0, 4), [
    "cloud",
    "provider:groq",
    "custom",
    "provider:openai",
  ]);
  assert.deepEqual(groupOptions(groups, "provider:openai"), ["provider:openai:addKey"]);
  assert.deepEqual(find(groups, "provider:openai:addKey").available, {
    reasonKey: "modelPicker.reasons.noKey",
    link: {
      kind: "settings",
      destination: "connections#connections.openai",
      labelKey: "modelPicker.links.addKey",
    },
  });
  assert.equal(
    find(groups, "provider:deepgram:addKey").available.link.destination,
    "connections#connections.deepgram"
  );
  assert.equal(find(groups, "custom").available, true, "the custom endpoint's key is optional");

  // Presence only; Corti's speech-to-text needs both client credentials.
  const presence = sttKeyPresence({
    openaiApiKey: "sk-1",
    groqApiKey: "  ",
    cortiClientId: "id",
    cortiClientSecret: "",
  });
  assert.equal(presence.openai, true);
  assert.equal(presence.groq, false, "blank isn't a key");
  assert.equal(presence.corti, false);
  assert.equal(sttKeyPresence({ cortiClientId: "id", cortiClientSecret: "secret" }).corti, true);
  assert.ok(
    Object.values(presence).every((value) => typeof value === "boolean"),
    "never a key"
  );
});

test("Azure Speech: Recognition and uploads only, available with its key and a valid endpoint", async (t) => {
  const { buildSttPickerOptions, sttKeyPresence, sttSelectionIssue } = await load(t);
  const setUp = {
    reasonKey: "modelPicker.stt.reasons.needsEndpointAndKey",
    link: {
      kind: "settings",
      destination: "connections#connections.azureSpeech",
      labelKey: "modelPicker.links.setUpConnection",
    },
  };
  const ready = { ...ALL_KEYS, "azure-speech": true };
  for (const surface of ["dictation", "fileTranscription"]) {
    const groups = buildSttPickerOptions(surface, context({ keys: ready }));
    assert.deepEqual(groupOptions(groups, "provider:azure-speech"), [
      "provider:azure-speech:MAI-Transcribe-2",
    ]);
    assert.equal(find(groups, "provider:azure-speech:MAI-Transcribe-2").available, true);
    const missing = buildSttPickerOptions(
      surface,
      context({ keys: { ...ALL_KEYS, "azure-speech": false } })
    );
    assert.deepEqual(find(missing, "provider:azure-speech:addKey").available, setUp, surface);
  }
  // Not a streaming model: Live Recording never lists it.
  assert.equal(
    groupIds(buildSttPickerOptions("liveRecording", context({ keys: ready }))).includes(
      "provider:azure-speech"
    ),
    false
  );
  // A selection without the connection warns with the same reason and link.
  assert.deepEqual(
    sttSelectionIssue(
      "dictation",
      context({
        keys: { ...ALL_KEYS, "azure-speech": false },
        current: { cloudProvider: "azure-speech", cloudModel: "MAI-Transcribe-2" },
      })
    ),
    setUp
  );

  // Presence needs both: the key and a Speech resource's https origin.
  const key = { azureSpeechApiKey: "k" };
  const presence = (endpoint) =>
    sttKeyPresence({ ...key, azureSpeechEndpoint: endpoint })["azure-speech"];
  assert.equal(presence("https://res.cognitiveservices.azure.com"), true);
  assert.equal(presence("https://westus2.api.cognitive.microsoft.com/"), true);
  assert.equal(presence(""), false);
  assert.equal(presence("https://res.openai.azure.com"), false);
  assert.equal(presence("https://res.cognitiveservices.azure.com/speechtotext"), false);
  assert.equal(
    sttKeyPresence({ azureSpeechEndpoint: "https://res.cognitiveservices.azure.com" })[
      "azure-speech"
    ],
    false,
    "an endpoint without its key"
  );

  // An organization allowlist that doesn't name it hides it.
  const policy = managedPolicy({ allowedModes: ["providers"], allowedByokProviders: ["openai"] });
  assert.equal(
    find(
      buildSttPickerOptions("dictation", context({ policy, keys: ready })),
      "provider:azure-speech:MAI-Transcribe-2"
    ),
    undefined
  );
});

test("local lists downloaded models only, named and grouped by organization", async (t) => {
  const { buildSttPickerOptions } = await load(t);
  const groups = buildSttPickerOptions("dictation", context());
  assert.deepEqual(groupOptions(groups, "local"), [
    "local:orukeet-v0.1.0",
    "local:base",
    "local:parakeet-tdt-0.6b-v3",
    "local:nemotron-speech-streaming-en-0.6b",
    "local:cohere-transcribe-03-2026",
    "local:download",
  ]);
  const whisper = find(groups, "local:base");
  assert.deepEqual(
    [whisper.label.text, whisper.sub.text, whisper.provider, whisper.icon],
    ["Whisper Base", "Whisper · 142 MB", "whisper", "whisper"]
  );
  const parakeet = find(groups, "local:parakeet-tdt-0.6b-v3");
  assert.deepEqual(
    [parakeet.label.text, parakeet.sub.text, parakeet.provider, parakeet.icon],
    ["Parakeet TDT 0.6B", "NVIDIA · 680 MB", "nvidia", "nvidia"]
  );
  // Cohere transcribes one language at a time: its entry says so.
  const cohere = find(groups, "local:cohere-transcribe-03-2026");
  assert.deepEqual(cohere.sub, {
    key: "modelPicker.stt.local.cohereSubSized",
    params: { size: "2.7 GB" },
  });
  assert.equal(cohere.provider, "cohere");
  assert.deepEqual(find(groups, "local:download").link, {
    kind: "settings",
    destination: "connections#connections.localModels",
    labelKey: "modelPicker.links.openLocalModels",
  });
  assert.deepEqual(find(groups, "local:download").label, { key: "modelPicker.local.downloadMore" });

  // Nothing downloaded (or not read yet): only the download link.
  for (const localModels of [[], null]) {
    const none = buildSttPickerOptions("dictation", context({ localModels }));
    assert.deepEqual(groupOptions(none, "local"), ["local:download"]);
    assert.deepEqual(find(none, "local:download").label, { key: "modelPicker.local.download" });
  }

  // sherpa-onnx can't run on this Mac: its models stay listed, unavailable.
  const old = buildSttPickerOptions(
    "dictation",
    context({ sherpa: { supported: false, minimumMacOSVersion: "15.5" } })
  );
  assert.equal(find(old, "local:base").available, true);
  assert.deepEqual(find(old, "local:parakeet-tdt-0.6b-v3").available, {
    reasonKey: "modelPicker.stt.reasons.requiresMacOS",
    reasonParams: { version: "15.5" },
  });
  assert.deepEqual(
    find(
      buildSttPickerOptions("dictation", context({ sherpa: { supported: false } })),
      "local:orukeet-v0.1.0"
    ).available,
    { reasonKey: "modelPicker.stt.reasons.localUnavailable" }
  );
});

test("the custom endpoint: configure, the stored one, and the remembered one", async (t) => {
  const { buildSttPickerOptions, isCustomTranscriptionUrl } = await load(t);
  // Not on the endpoint: one "Custom endpoint…" entry that opens the fields.
  let custom = buildSttPickerOptions("dictation", context()).find((g) => g.id === "custom");
  assert.deepEqual(
    custom.options.map((o) => [o.id, o.action]),
    [["custom", "configureCustom"]]
  );
  assert.deepEqual(custom.options[0].label, { key: "modelPicker.custom.label" });

  // On it: the entry shows its model and host.
  const stored = context({
    current: { cloudProvider: "custom", cloudModel: "gpt-4o-transcribe", cloudBaseUrl: FOUNDRY },
  });
  custom = buildSttPickerOptions("dictation", stored).find((g) => g.id === "custom");
  assert.deepEqual(custom.options[0].label, { text: "gpt-4o-transcribe" });
  assert.deepEqual(custom.options[0].sub, { text: "contoso-foundry.cognitiveservices.azure.com" });

  // Away from it, with its URL still set and its model remembered: one pick back.
  const away = context({
    rememberedCustomModel: "gpt-4o-transcribe",
    current: {
      cloudProvider: "openai",
      cloudModel: "gpt-4o-mini-transcribe",
      cloudBaseUrl: FOUNDRY,
    },
  });
  custom = buildSttPickerOptions("dictation", away).find((g) => g.id === "custom");
  assert.deepEqual(
    custom.options.map((o) => [o.id, o.model, o.action]),
    [
      ["custom:remembered", "gpt-4o-transcribe", undefined],
      ["custom", "", "configureCustom"],
    ]
  );
  // Without a custom URL (the OpenAI default, another provider's) there's nothing to go back to.
  for (const cloudBaseUrl of ["https://api.openai.com/v1", "https://api.groq.com/openai/v1", ""]) {
    const groups = buildSttPickerOptions(
      "dictation",
      context({ rememberedCustomModel: "x", current: { cloudBaseUrl } })
    );
    assert.equal(find(groups, "custom:remembered"), undefined, cloudBaseUrl);
    assert.equal(isCustomTranscriptionUrl(cloudBaseUrl), false, cloudBaseUrl);
  }
  assert.equal(isCustomTranscriptionUrl(FOUNDRY), true);
  // Policy without "custom": no endpoint entries at all.
  const noCustom = managedPolicy({ allowedModes: ["providers"], allowedByokProviders: ["openai"] });
  assert.equal(
    buildSttPickerOptions("dictation", { ...away, policy: noCustom }).find(
      (g) => g.id === "custom"
    ),
    undefined
  );
});

test("what the inherited view warns about: the result can't run here, and where it's fixed", async (t) => {
  const { sttSelectionIssue, sttSelectionWarning } = await load(t);
  const localModelsLink = {
    kind: "settings",
    destination: "connections#connections.localModels",
    labelKey: "modelPicker.links.openLocalModels",
  };
  // The user's Live Recording: local Whisper with no model anywhere, only Parakeet and
  // Nemotron on disk. It runs Whisper's default, which isn't there either.
  const sherpaOnly = [
    { id: "parakeet-tdt-0.6b-v3", engine: "sherpa" },
    { id: "nemotron-speech-streaming-en-0.6b", engine: "sherpa" },
  ];
  const whisperNone = context({
    localModels: sherpaOnly,
    current: { mode: "local", localProvider: "whisper", localModel: "" },
  });
  assert.deepEqual(sttSelectionIssue("liveRecording", whisperNone), {
    reasonKey: "modelPicker.stt.reasons.noLocalModel",
    reasonParams: { engine: "Whisper" },
    link: localModelsLink,
  });
  assert.deepEqual(sttSelectionWarning("liveRecording", whisperNone), {
    key: "modelPicker.stt.reasons.noLocalModel",
    params: { engine: "Whisper" },
  });
  // Whisper's default on disk: it runs.
  assert.equal(
    sttSelectionIssue("liveRecording", {
      ...whisperNone,
      localModels: [...sherpaOnly, { id: "base", engine: "whisper" }],
    }),
    undefined
  );
  // A named model gone while others of the engine remain.
  assert.deepEqual(
    sttSelectionIssue("fileTranscription", {
      ...whisperNone,
      localModels: [...sherpaOnly, { id: "base", engine: "whisper" }],
      current: { ...whisperNone.current, localModel: "small" },
    }),
    { reasonKey: "modelPicker.stt.reasons.notDownloaded", link: localModelsLink }
  );
  // A Parakeet model id never counts for Whisper.
  assert.equal(
    sttSelectionIssue(
      "liveRecording",
      context({
        localModels: sherpaOnly,
        current: { mode: "local", localProvider: "nvidia", localModel: "" },
      })
    ),
    undefined,
    "NVIDIA's default (Parakeet TDT) is on disk"
  );
  // Live recording borrowing Recognition's custom endpoint: it can't stream; the fix is the picker.
  assert.deepEqual(
    sttSelectionIssue(
      "liveRecording",
      context({ current: { cloudProvider: "custom", cloudModel: "gpt-4o-transcribe" } })
    ),
    { reasonKey: "modelPicker.stt.reasons.needsStreaming" }
  );
  // No key: links to the provider's card.
  assert.deepEqual(
    sttSelectionIssue(
      "fileTranscription",
      context({ keys: {}, current: { cloudProvider: "groq", cloudModel: "whisper-large-v3" } })
    ).link.destination,
    "connections#connections.groq"
  );
});

test("the button names what runs, and why it can't when it can't", async (t) => {
  const { describeSttSelection, selectedSttOptionId } = await load(t);
  const describe = (surface, overrides) => describeSttSelection(surface, context(overrides));

  const custom = describe("dictation", {
    current: { cloudProvider: "custom", cloudModel: "gpt-4o-transcribe", cloudBaseUrl: FOUNDRY },
  });
  assert.deepEqual(custom, {
    icon: "custom",
    title: { text: "gpt-4o-transcribe" },
    sub: {
      key: "modelPicker.trigger.custom",
      params: { host: "contoso-foundry.cognitiveservices.azure.com" },
    },
    warning: undefined,
  });
  // Live recording borrowing that endpoint can't stream it.
  assert.deepEqual(
    describe("liveRecording", {
      current: { cloudProvider: "custom", cloudModel: "gpt-4o-transcribe" },
    }).warning,
    { key: "modelPicker.stt.reasons.needsStreaming" }
  );
  assert.deepEqual(
    describe("liveRecording", {
      current: { cloudProvider: "openai", cloudModel: "gpt-transcribe" },
    }).warning,
    { key: "modelPicker.stt.reasons.needsStreaming" },
    "a batch-only model of a streaming provider"
  );
  assert.equal(
    describe("liveRecording", { current: { cloudProvider: "deepgram", cloudModel: "nova-3" } })
      .warning,
    undefined
  );
  assert.deepEqual(
    describe("fileTranscription", { current: { cloudProvider: "deepgram", cloudModel: "nova-3" } })
      .warning,
    { key: "modelPicker.stt.reasons.liveOnly" }
  );
  assert.deepEqual(
    describe("dictation", {
      keys: {},
      current: { cloudProvider: "groq", cloudModel: "whisper-large-v3" },
    }),
    {
      icon: "groq",
      title: { text: "Whisper Large v3" },
      sub: { key: "modelPicker.trigger.apiKey", params: { provider: "Groq" } },
      warning: { key: "modelPicker.reasons.noKey" },
    }
  );
  // Local: the model's name; a model no longer on disk says so (once the list is read).
  const local = { mode: "local", localProvider: "nvidia", localModel: "parakeet-tdt-0.6b-v3" };
  assert.deepEqual(describe("dictation", { current: local }).title, { text: "Parakeet TDT 0.6B" });
  assert.equal(describe("dictation", { current: local }).warning, undefined);
  assert.deepEqual(
    describe("dictation", {
      localModels: [{ id: "nemotron-speech-streaming-en-0.6b", engine: "sherpa" }],
      current: local,
    }).warning,
    { key: "modelPicker.stt.reasons.notDownloaded" },
    "the engine has other models on disk"
  );
  assert.deepEqual(
    describe("dictation", { localModels: [], current: local }).warning,
    { key: "modelPicker.stt.reasons.noLocalModel", params: { engine: "NVIDIA" } },
    "nothing of this engine on disk"
  );
  assert.equal(describe("dictation", { localModels: null, current: local }).warning, undefined);
  // Self-hosted with no model: the server's default.
  assert.deepEqual(
    describe("fileTranscription", {
      current: { mode: "self-hosted", remoteUrl: "http://192.168.1.21:8178", remoteModel: "" },
    }).title,
    { key: "modelPicker.stt.trigger.serverDefault" }
  );
  assert.deepEqual(describe("liveRecording", { current: { mode: "self-hosted" } }).warning, {
    key: "modelPicker.stt.reasons.selfHostedLiveRecording",
  });
  assert.deepEqual(
    describe("dictation", { cloudDisabled: true, current: { mode: "openwhispr" } }).warning,
    {
      key: "modelPicker.reasons.cloudOff",
    }
  );
  assert.deepEqual(describe("dictation", { current: { mode: null } }).title, {
    key: "common.managedByOrg",
  });

  for (const [current, id] of [
    [{ mode: "openwhispr" }, "cloud"],
    [{ mode: "self-hosted" }, "selfHosted"],
    [{ mode: "enterprise" }, "enterprise"],
    [{ mode: "local", localModel: "base" }, "local:base"],
    [{ mode: "providers", cloudProvider: "custom" }, "custom"],
    [
      { mode: "providers", cloudProvider: "groq", cloudModel: "whisper-large-v3" },
      "provider:groq:whisper-large-v3",
    ],
  ]) {
    assert.equal(selectedSttOptionId(context({ current }).current), id);
  }
});

test("the mode shown is the mode cards' (usePolicyModeOptions)", async (t) => {
  const { sttEffectiveMode, sttVisibleModes } = await load(t);
  const base = { policy: UNMANAGED, cloudDisabled: false, isSignedIn: true };
  assert.equal(
    sttEffectiveMode("dictation", "openwhispr", { ...base, isSignedIn: false }),
    "openwhispr"
  );
  assert.equal(sttEffectiveMode("liveRecording", "self-hosted", base), "self-hosted");
  const policy = managedPolicy({
    allowedModes: ["openwhispr", "providers", "local"],
    allowedByokProviders: ["openai"],
  });
  assert.equal(sttEffectiveMode("dictation", "openwhispr", { ...base, policy }), "openwhispr");
  // Signed out: the Cloud card is disabled, so a managed policy shows the first card it allows.
  assert.equal(
    sttEffectiveMode("dictation", "openwhispr", { ...base, policy, isSignedIn: false }),
    "providers"
  );
  assert.equal(sttEffectiveMode("dictation", "self-hosted", { ...base, policy }), "openwhispr");
  // With the Cloud switch off, Cloud leaves the cards unless it's the stored mode.
  assert.deepEqual(
    sttVisibleModes("dictation", "local", { ...base, cloudDisabled: true }).map((m) => m.id),
    ["providers", "local", "self-hosted"]
  );
  assert.deepEqual(
    sttVisibleModes("liveRecording", "openwhispr", { ...base, cloudDisabled: true }).map((m) => [
      m.id,
      m.disabled,
    ]),
    [
      ["openwhispr", true],
      ["providers", false],
      ["local", false],
      ["self-hosted", true],
    ]
  );
});

test("inherited fields: one per borrowed value, nothing for Recognition or a surface's own", async (t) => {
  const { sttInheritedFields } = await load(t);
  const settings = {
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionModel: "gpt-4o-transcribe",
    cloudTranscriptionBaseUrl: FOUNDRY,
    localTranscriptionProvider: "nvidia",
    whisperModel: "base",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    cohereModel: "",
    remoteTranscriptionUrl: "",
    meetingTranscriptionMode: "providers",
    meetingCloudTranscriptionProvider: "",
    meetingCloudTranscriptionModel: "",
    meetingCloudTranscriptionBaseUrl: "",
    meetingCloudTranscriptionMode: "",
    meetingLocalTranscriptionProvider: "nvidia",
    meetingWhisperModel: "",
    meetingParakeetModel: "",
    meetingCohereModel: "",
    meetingRemoteTranscriptionUrl: "",
    uploadTranscriptionMode: "providers",
    uploadCloudTranscriptionProvider: "custom",
    uploadCloudTranscriptionModel: "whisper-1",
    uploadCloudTranscriptionBaseUrl: "",
    uploadCloudTranscriptionMode: "byok",
    uploadLocalTranscriptionProvider: "cohere",
    uploadWhisperModel: "",
    uploadParakeetModel: "",
    uploadCohereModel: "",
    uploadRemoteTranscriptionUrl: "",
    uploadRemoteTranscriptionModel: "",
  };
  const rows = (fields) => fields?.map((field) => [field.field, field.source]) ?? null;
  assert.equal(sttInheritedFields("dictation", settings, "providers"), null);
  assert.deepEqual(rows(sttInheritedFields("liveRecording", settings, "providers")), [
    ["provider", "inherited"],
    ["endpoint", "inherited"],
    ["model", "inherited"],
  ]);
  // Uploads on their own custom model but Recognition's endpoint URL.
  assert.deepEqual(rows(sttInheritedFields("fileTranscription", settings, "providers")), [
    ["provider", "own"],
    ["endpoint", "inherited"],
    ["model", "own"],
  ]);
  assert.equal(
    sttInheritedFields(
      "fileTranscription",
      { ...settings, uploadCloudTranscriptionBaseUrl: FOUNDRY },
      "providers"
    ),
    null,
    "all its own"
  );
  // Local: the engine (the surface's own) first, then the model: live recording
  // borrows Recognition's Parakeet model; uploads have no Cohere model anywhere.
  const liveLocal = sttInheritedFields("liveRecording", settings, "local");
  assert.deepEqual(rows(liveLocal), [
    ["engine", "own"],
    ["model", "inherited"],
  ]);
  assert.deepEqual(liveLocal[0].value, {
    key: "modelPicker.stt.inherit.localEngine",
    params: { engine: "NVIDIA" },
  });
  assert.deepEqual(liveLocal[1].value, { text: "Parakeet TDT 0.6B" });
  const uploadLocal = sttInheritedFields("fileTranscription", settings, "local");
  assert.deepEqual(rows(uploadLocal), [
    ["engine", "own"],
    ["model", "default"],
  ]);
  assert.deepEqual(uploadLocal[1].value, {
    key: "modelPicker.stt.inherit.defaultModel",
    params: { model: "Cohere Transcribe 2B" },
  });
  // The user's Live Recording: local Whisper, no model of its own or on Recognition.
  const whisperNone = sttInheritedFields(
    "liveRecording",
    { ...settings, meetingLocalTranscriptionProvider: "whisper", whisperModel: "" },
    "local"
  );
  assert.deepEqual(
    whisperNone.map((field) => [field.field, field.source, field.value]),
    [
      [
        "engine",
        "own",
        { key: "modelPicker.stt.inherit.localEngine", params: { engine: "Whisper" } },
      ],
      [
        "model",
        "default",
        { key: "modelPicker.stt.inherit.defaultModel", params: { model: "Whisper Base" } },
      ],
    ]
  );
  // Its own model: nothing inherited, no rows.
  assert.equal(
    sttInheritedFields(
      "liveRecording",
      { ...settings, meetingParakeetModel: "orukeet-v0.1.0" },
      "local"
    ),
    null
  );
  for (const mode of ["openwhispr", "self-hosted", null]) {
    assert.equal(sttInheritedFields("liveRecording", settings, mode), null, String(mode));
  }
});

nodeTest("the speech-to-text picker's options", async (t) => {
  await load(t);
  for (const [name, fn] of subtests) await t.test(name, fn);
});

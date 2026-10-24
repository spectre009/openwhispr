const nodeTest = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The custom connection in the model pickers (settings/modelPicker/connectionOptions.ts,
// options.ts, sttOptions.ts): a group named after it wherever a custom endpoint is offered
// (every language-model scope that offers one, Recognition and File Transcription; never
// Live Recording), listing its remembered models and those its features run, without
// repeats, then "Enter a deployment name…"; an OpenAI-compatible connection also lists its
// /models, Azure never does; speech-to-text's one custom key makes its entries unavailable
// while another feature would keep sending it elsewhere, unless main says it already is the
// connection's; and a feature on the connection (inherited ones included) shows as its entry,
// with "<model> · Little Buddy · Azure OpenAI" on the button.

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };

const policyWith = ({ llm, transcription }) => ({
  status: "managed",
  appVersion: "1.10.3",
  policy: {
    version: 1,
    transcription: { allowedEnterpriseProviders: [], ...transcription },
    llm: { allowedEnterpriseProviders: [], ...llm },
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

const ALLOWS_CUSTOM = policyWith({
  llm: { allowedModes: ["providers"], allowedByokProviders: ["groq", "custom"] },
  transcription: { allowedModes: ["providers"], allowedByokProviders: ["openai", "custom"] },
});
const NO_CUSTOM = policyWith({
  llm: { allowedModes: ["providers"], allowedByokProviders: ["groq"] },
  transcription: { allowedModes: ["providers"], allowedByokProviders: ["openai"] },
});
const NO_PROVIDERS = policyWith({
  llm: { allowedModes: ["local"], allowedByokProviders: [] },
  transcription: { allowedModes: ["local"], allowedByokProviders: [] },
});

const SCOPES = [
  "dictationCleanup",
  "dictationAgent",
  "dictationAgentVision",
  "dictationTranslation",
  "noteFormatting",
  "chatIntelligence",
];
const SURFACES = ["dictation", "liveRecording", "fileTranscription"];

const LB_ORIGIN = "https://littlebuddy-foundry-eus2.openai.azure.com";
const LB_LANGUAGE = `${LB_ORIGIN}/openai/v1`;
const LB = {
  name: "Little Buddy",
  endpoint: LB_ORIGIN,
  models: { language: ["gpt-4.1-mini"], speech: ["gpt-4o-transcribe"] },
};
const COMPATIBLE = {
  name: "Home LLM",
  endpoint: "https://llm.example.com/v1",
  models: { language: ["gpt-4.1-mini"], speech: [] },
};
const FOUNDRY = "https://contoso-foundry.cognitiveservices.azure.com/openai/v1";
const ORUKEET_SERVER = "http://192.168.1.20:8178";

// Who runs what on Little Buddy ("Used by"), as featuresUsingConnection reports it.
const USES = [
  { feature: "recognition", model: "gpt-4o-transcribe", capability: "speech" },
  { feature: "fileTranscription", model: "gpt-4o-mini-transcribe", capability: "speech" },
  { feature: "chat", model: "gpt-5-mini", capability: "language" },
  { feature: "noteFormatting", model: "gpt-5-mini", capability: "language" },
  { feature: "assistant", model: "gpt-4.1-mini", capability: "language" },
];

const subtests = [];
const test = (name, fn) => subtests.push([name, fn]);

let env;

async function load(t) {
  if (env) return env;
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-model-picker-connection-",
  });
  const load = (path) => vite.ssrLoadModule(path);
  env = {
    options: await load("/components/settings/modelPicker/options.ts"),
    stt: await load("/components/settings/modelPicker/sttOptions.ts"),
    connection: await load("/components/settings/modelPicker/connectionOptions.ts"),
    usage: await load("/components/settings/connectionUsage.ts"),
    store: await load("/stores/settingsStore.ts"),
  };
  return env;
}

const ids = (group) => group?.options.map((option) => option.id);
const groupIds = (groups) => groups.map((group) => group.id);
const findGroup = (groups, id) => groups.find((group) => group.id === id);
const title = (feature) => env.usage.USAGE_FEATURE_TITLE_KEYS[feature];

function llmConnection(connection = LB, { hasKey = true, uses = USES, catalog } = {}) {
  const base = env.connection.pickerConnection(connection, {
    capability: "language",
    hasKey,
    uses,
  });
  return catalog ? { ...base, catalog } : base;
}

function llmContext(scope, overrides = {}) {
  return {
    policy: UNMANAGED,
    cloudDisabled: false,
    isSignedIn: true,
    allowedModes: scope === "dictationAgentVision" ? ["providers"] : undefined,
    keys: { openai: true, groq: true },
    copilot: { signedIn: true, login: "octocat", models: [] },
    localModels: [],
    current: { mode: "providers", provider: "groq", model: "openai/gpt-oss-120b" },
    managedDeployment: null,
    connection: llmConnection(),
    ...overrides,
  };
}

function sttConnection(
  sharedKey = { matches: true, conflict: null },
  { hasKey = true, uses = USES } = {}
) {
  return {
    ...env.connection.pickerConnection(LB, { capability: "speech", hasKey, uses }),
    sharedKey,
  };
}

function sttContext(overrides = {}) {
  const { current, ...rest } = overrides;
  return {
    policy: UNMANAGED,
    cloudDisabled: false,
    isSignedIn: true,
    keys: { openai: true, groq: true },
    localModels: [],
    connection: sttConnection(),
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

test("language models: the group is offered with a connection, where a custom endpoint is", async (t) => {
  await load(t);
  const { buildModelPickerOptions } = env.options;
  for (const scope of SCOPES) {
    const groups = buildModelPickerOptions(scope, llmContext(scope));
    const order = groupIds(groups);
    assert.ok(order.includes("connection"), `${scope}: offered`);
    assert.ok(order.includes("custom"), `${scope}: as the custom endpoint is`);
    // Before the API-key providers, after Copilot.
    const at = order.indexOf("connection");
    assert.ok(at < order.findIndex((id) => id.startsWith("provider:")), `${scope}: ${order}`);
    if (order.includes("copilot")) assert.ok(order.indexOf("copilot") < at, scope);

    assert.equal(
      findGroup(buildModelPickerOptions(scope, llmContext(scope, { connection: null })), "connection"),
      undefined,
      `${scope}: no connection, no group`
    );
    for (const [name, policy] of [
      ["custom not allowed", NO_CUSTOM],
      ["providers not allowed", NO_PROVIDERS],
    ]) {
      const hidden = buildModelPickerOptions(scope, llmContext(scope, { policy }));
      assert.equal(findGroup(hidden, "connection"), undefined, `${scope}: ${name}`);
      assert.equal(findGroup(hidden, "custom"), undefined, `${scope}: ${name} (as today)`);
    }
    assert.ok(
      findGroup(buildModelPickerOptions(scope, llmContext(scope, { policy: ALLOWS_CUSTOM })), "connection"),
      `${scope}: a policy that allows custom`
    );
  }
  // A scope restricted to modes without a custom endpoint gets no group (the Screen
  // Context Model offers API-key providers, custom included, so it has one above).
  const localOnly = buildModelPickerOptions(
    "dictationAgentVision",
    llmContext("dictationAgentVision", { allowedModes: ["local"] })
  );
  assert.equal(findGroup(localOnly, "connection"), undefined);
  assert.equal(findGroup(localOnly, "custom"), undefined);
});

test("language models: remembered models, then those in use, once each, then Enter a deployment name…", async (t) => {
  await load(t);
  const { buildModelPickerOptions } = env.options;
  const connection = llmConnection({
    ...LB,
    models: { language: ["gpt-4.1-mini", "gpt-5-mini"], speech: ["gpt-4o-transcribe"] },
  });
  const group = findGroup(
    buildModelPickerOptions("dictationAgent", llmContext("dictationAgent", { connection })),
    "connection"
  );
  assert.deepEqual(ids(group), [
    "connection:model:gpt-4.1-mini",
    "connection:model:gpt-5-mini",
    "connection:enter",
  ]);
  assert.deepEqual(group.title, { text: "Little Buddy" });
  assert.deepEqual(group.badge, { text: { key: "connections.custom.kinds.azure" }, tone: "accent" });
  const [mini, five, enter] = group.options;
  assert.deepEqual(
    [mini.mode, mini.cloudMode, mini.provider, mini.model, mini.action, mini.available],
    ["providers", "byok", "custom", "gpt-4.1-mini", "useConnection", true]
  );
  // Who else runs it; the feature itself isn't named.
  assert.equal(mini.sub, undefined, "the Voice Assistant's own model");
  assert.deepEqual(five.sub, {
    key: "modelPicker.connection.usedByMore",
    paramKeys: { feature: title("chat") },
  });
  assert.deepEqual(
    [enter.label, enter.action, enter.model, enter.available],
    [{ key: "modelPicker.connection.enterDeployment" }, "enterConnectionModel", "", true]
  );

  // In use but not remembered yet: listed after the remembered ones. Speech models aren't.
  const used = findGroup(
    buildModelPickerOptions("chatIntelligence", llmContext("chatIntelligence")),
    "connection"
  );
  assert.deepEqual(ids(used), [
    "connection:model:gpt-4.1-mini",
    "connection:model:gpt-5-mini",
    "connection:enter",
  ]);
  assert.deepEqual(used.options[0].sub, {
    key: "modelPicker.connection.usedBy",
    paramKeys: { feature: title("assistant") },
  });
  assert.deepEqual(used.options[1].sub, {
    key: "modelPicker.connection.usedBy",
    paramKeys: { feature: title("noteFormatting") },
  });

  // The feature's own model on the connection is listed even before "Used by" is read.
  const own = findGroup(
    buildModelPickerOptions(
      "dictationTranslation",
      llmContext("dictationTranslation", {
        connection: llmConnection(LB, { uses: [] }),
        current: {
          mode: "providers",
          provider: "custom",
          model: "gpt-4.1-nano",
          cloudBaseUrl: LB_LANGUAGE,
        },
      })
    ),
    "connection"
  );
  assert.deepEqual(ids(own), [
    "connection:model:gpt-4.1-mini",
    "connection:model:gpt-4.1-nano",
    "connection:enter",
  ]);
});

test("language models: Azure never lists the /models catalog; an OpenAI-compatible connection does", async (t) => {
  await load(t);
  const { buildModelPickerOptions } = env.options;
  const catalog = { status: "ready", models: ["sora", "claude-opus-5.5", "gpt-4.1-mini"] };
  const azure = findGroup(
    buildModelPickerOptions(
      "dictationCleanup",
      llmContext("dictationCleanup", { connection: llmConnection(LB, { uses: [], catalog }) })
    ),
    "connection"
  );
  assert.deepEqual(ids(azure), ["connection:model:gpt-4.1-mini", "connection:enter"]);

  const compatible = findGroup(
    buildModelPickerOptions(
      "dictationCleanup",
      llmContext("dictationCleanup", {
        connection: llmConnection(COMPATIBLE, { uses: [], catalog }),
      })
    ),
    "connection"
  );
  assert.deepEqual(ids(compatible), [
    "connection:model:gpt-4.1-mini",
    "connection:model:sora",
    "connection:model:claude-opus-5.5",
    "connection:enter",
  ]);
  assert.deepEqual(compatible.badge, {
    text: { key: "connections.custom.kinds.openaiCompatible" },
    tone: "muted",
  });
  assert.deepEqual(compatible.options.at(-1).label, { key: "modelPicker.connection.enterModel" });
});

test("a connection without a key lists its entries unavailable, with a link to its card", async (t) => {
  await load(t);
  const noKey = {
    reasonKey: "modelPicker.reasons.noKey",
    link: {
      kind: "settings",
      destination: "connections#connections.custom",
      labelKey: "modelPicker.links.addKey",
    },
  };
  const llm = findGroup(
    env.options.buildModelPickerOptions(
      "chatIntelligence",
      llmContext("chatIntelligence", { connection: llmConnection(LB, { hasKey: false }) })
    ),
    "connection"
  );
  for (const option of llm.options) assert.deepEqual(option.available, noKey, option.id);
  const stt = findGroup(
    env.stt.buildSttPickerOptions(
      "dictation",
      sttContext({ connection: sttConnection(undefined, { hasKey: false }) })
    ),
    "connection"
  );
  for (const option of stt.options) assert.deepEqual(option.available, noKey, option.id);
});

test("language models: a feature on the connection selects its entry and names it on the button", async (t) => {
  await load(t);
  const { selectedOptionId, describePickerSelection } = env.options;
  const connection = llmConnection();
  // Same Azure host, whatever the path: the connection.
  for (const cloudBaseUrl of [LB_LANGUAGE, `${LB_ORIGIN}/openai/v1/`, `${LB_ORIGIN}/openai`]) {
    const current = { mode: "providers", provider: "custom", model: "gpt-5-mini", cloudBaseUrl };
    assert.equal(selectedOptionId(current, connection), "connection:model:gpt-5-mini");
    assert.deepEqual(
      describePickerSelection("chatIntelligence", llmContext("chatIntelligence", { current })),
      {
        icon: "connection",
        title: { text: "gpt-5-mini" },
        sub: { key: "modelPicker.connection.trigger.azure", params: { name: "Little Buddy" } },
      }
    );
  }
  // Another endpoint, or no connection: the custom endpoint, as before.
  const elsewhere = {
    mode: "providers",
    provider: "custom",
    model: "gpt-5-mini",
    cloudBaseUrl: FOUNDRY,
  };
  assert.equal(selectedOptionId(elsewhere, connection), "custom");
  assert.equal(selectedOptionId({ ...elsewhere, cloudBaseUrl: LB_LANGUAGE }), "custom");
  assert.deepEqual(
    describePickerSelection("chatIntelligence", llmContext("chatIntelligence", { current: elsewhere }))
      .sub,
    {
      key: "modelPicker.trigger.custom",
      params: { host: "contoso-foundry.cognitiveservices.azure.com" },
    }
  );
  // An OpenAI-compatible connection matches its base, not just its host.
  const compatible = llmConnection(COMPATIBLE, { uses: [] });
  const onBase = {
    mode: "providers",
    provider: "custom",
    model: "m",
    cloudBaseUrl: "https://llm.example.com/v1/",
  };
  assert.equal(selectedOptionId(onBase, compatible), "connection:model:m");
  assert.equal(
    selectedOptionId({ ...onBase, cloudBaseUrl: "https://llm.example.com/v2" }, compatible),
    "custom"
  );
  assert.deepEqual(
    describePickerSelection(
      "dictationCleanup",
      llmContext("dictationCleanup", { connection: compatible, current: onBase })
    ).sub,
    { key: "modelPicker.connection.trigger.compatible", params: { name: "Home LLM" } }
  );

  // Note formatting inheriting Cleanup's endpoint on the connection shows it too.
  const { store } = env;
  const settings = {
    ...store.useSettingsStore.getState(),
    cleanupMode: "providers",
    cleanupProvider: "custom",
    cleanupModel: "gpt-4.1-mini",
    cleanupCloudBaseUrl: LB_LANGUAGE,
    noteFormattingMode: "providers",
    noteFormattingProvider: "",
    noteFormattingModel: "",
    noteFormattingCloudBaseUrl: "",
  };
  const resolved = store.selectResolvedLLMConfig(settings, "noteFormatting");
  const inherited = {
    mode: resolved.mode,
    provider: resolved.provider,
    model: resolved.model,
    cloudBaseUrl: resolved.cloudBaseUrl,
  };
  assert.equal(selectedOptionId(inherited, connection), "connection:model:gpt-4.1-mini");
});

test("speech-to-text: Recognition and File Transcription get the group, Live Recording never", async (t) => {
  await load(t);
  const { buildSttPickerOptions } = env.stt;
  for (const surface of SURFACES) {
    const groups = buildSttPickerOptions(surface, sttContext());
    const group = findGroup(groups, "connection");
    if (surface === "liveRecording") {
      assert.equal(group, undefined, "no custom lane, no connection");
      continue;
    }
    assert.equal(groupIds(groups).indexOf("connection"), 1, `${surface}: right after Cloud`);
    assert.equal(
      findGroup(buildSttPickerOptions(surface, sttContext({ connection: null })), "connection"),
      undefined,
      `${surface}: no connection, no group`
    );
    for (const policy of [NO_CUSTOM, NO_PROVIDERS]) {
      const hidden = buildSttPickerOptions(surface, sttContext({ policy }));
      assert.equal(findGroup(hidden, "connection"), undefined, surface);
      assert.equal(findGroup(hidden, "custom"), undefined, `${surface}: as today`);
    }
    assert.ok(
      findGroup(buildSttPickerOptions(surface, sttContext({ policy: ALLOWS_CUSTOM })), "connection")
    );
  }
});

test("speech-to-text: speech models, remembered then in use, once each, then Enter a deployment name…", async (t) => {
  await load(t);
  const group = findGroup(env.stt.buildSttPickerOptions("dictation", sttContext()), "connection");
  assert.deepEqual(ids(group), [
    "connection:model:gpt-4o-transcribe",
    "connection:model:gpt-4o-mini-transcribe",
    "connection:enter",
  ]);
  const [own, mini, enter] = group.options;
  assert.deepEqual(
    [own.mode, own.provider, own.model, own.action, own.available, own.sub],
    ["providers", "custom", "gpt-4o-transcribe", "useConnection", true, undefined]
  );
  assert.deepEqual(mini.sub, {
    key: "modelPicker.connection.usedBy",
    paramKeys: { feature: title("fileTranscription") },
  });
  assert.deepEqual(
    [enter.label, enter.action],
    [{ key: "modelPicker.connection.enterDeployment" }, "enterConnectionModel"]
  );
});

test("speech-to-text's one key: available when it matches or nothing else sends it; else why not", async (t) => {
  await load(t);
  const { buildSttPickerOptions, sttPickAvailability } = env.stt;
  const entries = (sharedKey) =>
    findGroup(
      buildSttPickerOptions("fileTranscription", sttContext({ connection: sttConnection(sharedKey) })),
      "connection"
    ).options;
  // Main says the shared key already is the connection's: nothing else changes.
  for (const option of entries({ matches: true, conflict: "recognition" })) {
    assert.equal(option.available, true, option.id);
  }
  // Another key, but nothing else sends it (or main couldn't say yet): the pick replaces it.
  for (const matches of [false, null]) {
    for (const option of entries({ matches, conflict: null })) {
      assert.equal(option.available, true, `${matches}: ${option.id}`);
    }
  }
  // Another key that Recognition still sends elsewhere: listed, unavailable, with the reason.
  const reason = {
    reasonKey: "modelPicker.connection.reasons.sharedKey",
    reasonParamKeys: { feature: title("recognition") },
  };
  for (const matches of [false, null]) {
    for (const option of entries({ matches, conflict: "recognition" })) {
      assert.deepEqual(option.available, reason, `${matches}: ${option.id}`);
    }
  }
  // The adapter revalidates with the same rule.
  assert.deepEqual(
    sttPickAvailability(
      "fileTranscription",
      { mode: "providers", provider: "custom", model: "gpt-4o-transcribe", action: "useConnection" },
      sttContext({ connection: sttConnection({ matches: false, conflict: "recognition" }) })
    ),
    reason
  );
});

test("what else sends the shared key: other surfaces' custom endpoints and an authenticating Orukeet server", async (t) => {
  await load(t);
  const { sttSharedKeyConflict } = env.connection;
  const base = {
    ...env.store.useSettingsStore.getState(),
    transcriptionMode: "providers",
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionModel: "gpt-4o-transcribe",
    cloudTranscriptionBaseUrl: FOUNDRY,
    remoteTranscriptionUrl: "",
    remoteTranscriptionModel: "",
    uploadTranscriptionMode: "providers",
    uploadUseLocalWhisper: false,
    uploadCloudTranscriptionMode: "byok",
    uploadCloudTranscriptionProvider: "custom",
    uploadCloudTranscriptionModel: "gpt-4o-transcribe",
    uploadCloudTranscriptionBaseUrl: FOUNDRY,
    uploadRemoteTranscriptionUrl: "",
    uploadRemoteTranscriptionModel: "",
    meetingCloudTranscriptionProvider: "",
    meetingCloudTranscriptionBaseUrl: "",
  };
  const conflict = (surface, overrides = {}) =>
    sttSharedKeyConflict(surface, { ...base, ...overrides }, UNMANAGED, LB);

  // Both on another resource, each with its own URL: the other one keeps sending the key there.
  assert.equal(conflict("dictation"), "fileTranscription");
  assert.equal(conflict("fileTranscription"), "recognition");
  // File Transcription borrowing Recognition's URL moves with it; the reverse doesn't.
  assert.equal(conflict("dictation", { uploadCloudTranscriptionBaseUrl: "" }), null);
  assert.equal(conflict("fileTranscription", { uploadCloudTranscriptionBaseUrl: "" }), "recognition");
  // Already on the connection: no conflict.
  assert.equal(conflict("fileTranscription", { cloudTranscriptionBaseUrl: LB_ORIGIN }), null);
  assert.equal(
    conflict("dictation", {
      uploadCloudTranscriptionBaseUrl: `${LB_ORIGIN}/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview`,
    }),
    null
  );
  // Not on a custom endpoint at all.
  assert.equal(
    conflict("dictation", {
      uploadTranscriptionMode: "local",
      uploadUseLocalWhisper: true,
    }),
    null
  );
  assert.equal(conflict("fileTranscription", { cloudTranscriptionProvider: "openai" }), null);
  // A self-hosted Orukeet server on Recognition authenticates with the shared key.
  const orukeet = {
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: ORUKEET_SERVER,
    remoteTranscriptionModel: "orukeet-v0.1.0",
    uploadCloudTranscriptionBaseUrl: LB_ORIGIN,
  };
  assert.equal(conflict("fileTranscription", orukeet), "recognition");
  assert.equal(
    conflict("fileTranscription", { ...orukeet, remoteTranscriptionModel: "large-v3" }),
    null,
    "a self-hosted server that doesn't take the key"
  );
  // Live Recording has no custom lane.
  assert.equal(conflict("liveRecording"), null);
});

test("speech-to-text: the URL a pick writes keeps a pasted operation URL on the connection only", async (t) => {
  await load(t);
  const { connectionSpeechUrl } = env.connection;
  const op = (deployment) =>
    `${LB_ORIGIN}/openai/deployments/${deployment}/audio/transcriptions?api-version=2025-03-01-preview`;
  assert.equal(connectionSpeechUrl(FOUNDRY, "gpt-4o-transcribe", LB), LB_ORIGIN);
  assert.equal(connectionSpeechUrl("", "gpt-4o-transcribe", LB), LB_ORIGIN);
  assert.equal(connectionSpeechUrl(`${LB_ORIGIN}/openai/v1`, "gpt-4o-transcribe", LB), LB_ORIGIN);
  assert.equal(
    connectionSpeechUrl(op("gpt-4o-transcribe"), "gpt-4o-transcribe", LB),
    op("gpt-4o-transcribe")
  );
  assert.equal(
    connectionSpeechUrl(op("gpt-4o-transcribe"), "gpt-4o-mini-transcribe", LB),
    LB_ORIGIN,
    "a pinned deployment would win over the model picked"
  );
  assert.equal(
    connectionSpeechUrl(
      "https://contoso.openai.azure.com/openai/deployments/x/audio/transcriptions",
      "x",
      LB
    ),
    LB_ORIGIN,
    "another resource's operation URL isn't moved over"
  );
  assert.equal(
    connectionSpeechUrl("https://llm.example.com/v1/audio/transcriptions", "m", COMPATIBLE),
    "https://llm.example.com/v1"
  );
});

test("speech-to-text: a surface on the connection, its own or inherited, selects its entry", async (t) => {
  await load(t);
  const { selectedSttOptionId, describeSttSelection, sttCurrentFrom, sttInheritedFields } = env.stt;
  const connection = sttConnection();
  const onLb = { cloudProvider: "custom", cloudModel: "gpt-4o-transcribe", cloudBaseUrl: LB_ORIGIN };
  const ctx = sttContext({ current: onLb });
  assert.equal(
    selectedSttOptionId(ctx.current, connection),
    "connection:model:gpt-4o-transcribe"
  );
  assert.deepEqual(describeSttSelection("dictation", ctx), {
    icon: "connection",
    title: { text: "gpt-4o-transcribe" },
    sub: { key: "modelPicker.connection.trigger.azure", params: { name: "Little Buddy" } },
    warning: undefined,
  });
  assert.equal(selectedSttOptionId({ ...ctx.current, cloudBaseUrl: FOUNDRY }, connection), "custom");
  assert.equal(selectedSttOptionId(ctx.current, null), "custom");

  // File Transcription borrowing Recognition's endpoint, model and provider.
  const settings = {
    ...env.store.useSettingsStore.getState(),
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionModel: "gpt-4o-transcribe",
    cloudTranscriptionBaseUrl: LB_ORIGIN,
    uploadTranscriptionMode: "providers",
    uploadCloudTranscriptionMode: "byok",
    uploadCloudTranscriptionProvider: "",
    uploadCloudTranscriptionModel: "",
    uploadCloudTranscriptionBaseUrl: "",
  };
  const inherited = {
    ...sttContext(),
    current: { mode: "providers", ...sttCurrentFrom("fileTranscription", settings) },
  };
  assert.equal(
    selectedSttOptionId(inherited.current, connection),
    "connection:model:gpt-4o-transcribe"
  );
  assert.deepEqual(describeSttSelection("fileTranscription", inherited).sub, {
    key: "modelPicker.connection.trigger.azure",
    params: { name: "Little Buddy" },
  });
  // The inherited rows stay as they are.
  assert.deepEqual(
    sttInheritedFields("fileTranscription", settings, "providers").map((field) => [
      field.field,
      field.source,
    ]),
    [
      ["provider", "inherited"],
      ["endpoint", "inherited"],
      ["model", "inherited"],
    ]
  );
});

nodeTest("the custom connection in the model pickers", async (t) => {
  await load(t);
  for (const [name, fn] of subtests) await t.test(name, fn);
});

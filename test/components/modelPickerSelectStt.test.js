const nodeTest = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The speech-to-text selection adapter (settings/modelPicker/selectStt.ts). For
// every surface (Recognition, Live Recording, File Transcription) and every
// kind of pick, from several starting setups and policies, the store and its
// persisted copy end up exactly as the old editors' handlers left them — the
// mode cards (TranscriptionSection, MeetingTranscriptionPanel,
// UploadTranscriptionPanel), then the provider tab's model list, the custom
// endpoint's model field and the local model cards (TranscriptionModelPicker)
// — and every route a recording resolves is the same: dictation's batch route
// and streaming provider (resolveTranscriptionRoute, resolveStreamingProviderName,
// the local flag and the startup pre-warm prefs main stops and starts servers
// from), live recording's resolved settings and session options
// (selectResolvedMeetingTranscription → resolveMeetingTranscriptionOptions),
// uploads' resolved settings and route (selectResolvedUploadTranscription →
// resolveFileTranscriptionRoute), and each context's policy gate. Side effects:
// Cloud while signed out asks to sign in and writes nothing; a pick that became
// invalid is refused; Recognition's toast fires only on a mode change; nothing
// is written by building the menu, showing inherited values or browsing.

const SURFACES = ["dictation", "liveRecording", "fileTranscription"];
const CONTEXT = { dictation: "dictation", liveRecording: "meeting", fileTranscription: "upload" };
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

const MANAGED = managedPolicy({
  allowedModes: ["providers", "local", "self-hosted", "enterprise"],
  allowedByokProviders: ["openai", "groq", "deepgram", "custom", "corti"],
  allowedEnterpriseProviders: ["azure"],
});

// Every model the local picks below use is on disk.
const DOWNLOADED = [
  { id: "base", engine: "whisper" },
  { id: "small", engine: "whisper" },
  { id: "parakeet-tdt-0.6b-v3", engine: "sherpa" },
  { id: "nemotron-speech-streaming-en-0.6b", engine: "sherpa" },
  { id: "cohere-transcribe-03-2026", engine: "sherpa" },
  { id: "orukeet-v0.1.0", engine: "sherpa" },
];

const KEYS = {
  openaiApiKey: "sk-test",
  groqApiKey: "gsk-test",
  xaiApiKey: "xai-test",
  mistralApiKey: "mistral-test",
  geminiApiKey: "gemini-test",
  cortiClientId: "corti-id",
  cortiClientSecret: "corti-secret",
  tinfoilApiKey: "tf-test",
  deepgramApiKey: "dg-test",
  assemblyaiApiKey: "aai-test",
  customTranscriptionApiKey: "sk-custom-test",
};

const FOUNDRY = "https://contoso-foundry.cognitiveservices.azure.com/openai/v1";

/** Every speech-to-text store key a pick could touch (the snapshot compares them all). */
const STT_KEYS = [
  "transcriptionMode",
  "useLocalWhisper",
  "cloudTranscriptionMode",
  "cloudTranscriptionProvider",
  "cloudTranscriptionModel",
  "cloudTranscriptionBaseUrl",
  "localTranscriptionProvider",
  "whisperModel",
  "parakeetModel",
  "cohereModel",
  "remoteTranscriptionType",
  "remoteTranscriptionUrl",
  "remoteTranscriptionModel",
  "meetingTranscriptionMode",
  "meetingUseLocalWhisper",
  "meetingCloudTranscriptionMode",
  "meetingCloudTranscriptionProvider",
  "meetingCloudTranscriptionModel",
  "meetingCloudTranscriptionBaseUrl",
  "meetingLocalTranscriptionProvider",
  "meetingWhisperModel",
  "meetingParakeetModel",
  "meetingCohereModel",
  "meetingRemoteTranscriptionType",
  "meetingRemoteTranscriptionUrl",
  "uploadTranscriptionMode",
  "uploadUseLocalWhisper",
  "uploadCloudTranscriptionMode",
  "uploadCloudTranscriptionProvider",
  "uploadCloudTranscriptionModel",
  "uploadCloudTranscriptionBaseUrl",
  "uploadLocalTranscriptionProvider",
  "uploadWhisperModel",
  "uploadParakeetModel",
  "uploadCohereModel",
  "uploadRemoteTranscriptionUrl",
  "uploadRemoteTranscriptionModel",
  "transcriptionModelByProvider",
  "enterpriseTranscriptionSetupMode",
  "enterpriseSetupMode",
  "customTranscriptionApiKey",
  "cortiEnvironment",
  "cortiTenant",
  "showTranscriptionPreview",
  "preferredLanguage",
  "isSignedIn",
];

// Cases run as subtests of one test, which owns the browser globals and Vite.
const subtests = [];
const test = (name, fn) => subtests.push([name, fn]);

let env;

async function load(t) {
  if (env) return env;
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-stt-picker-adapter-" });
  const load = (path) => vite.ssrLoadModule(path);
  env = {
    storage,
    store: await load("/stores/settingsStore.ts"),
    registry: await load("/models/ModelRegistry.ts"),
    rules: await load("/stores/policyRules.ts"),
    cloudModes: await load("/utils/openWhisprCloudModes.ts"),
    organizations: await load("/helpers/localASROrganization.ts"),
    route: await load("/helpers/transcriptionRoute.ts"),
    streaming: await load("/helpers/dictationStreamingRouting.js"),
    meeting: await load("/helpers/meetingTranscriptionRouting.js"),
    file: await load("/services/fileTranscription.ts"),
    stt: await load("/components/settings/modelPicker/sttOptions.ts"),
    adapter: await load("/components/settings/modelPicker/selectStt.ts"),
  };
  return env;
}

const state = () => env.store.useSettingsStore.getState();

/** A fresh store and an empty persisted copy, so the snapshot sees only this run's writes. */
function reset(start) {
  env.storage.clear();
  env.store.useSettingsStore.setState(start);
}

function fixtures() {
  const base = { isSignedIn: true, enterpriseTranscriptionSetupMode: "auto", ...KEYS };
  // The user's setup: Recognition and uploads on an Azure AI Foundry custom endpoint,
  // live recording in "providers" mode inheriting Recognition's provider, Parakeet and
  // Nemotron on disk.
  const daily = {
    ...base,
    preferredLanguage: "en",
    transcriptionMode: "providers",
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionModel: "gpt-4o-transcribe",
    cloudTranscriptionBaseUrl: FOUNDRY,
    localTranscriptionProvider: "nvidia",
    whisperModel: "base",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    cohereModel: "cohere-transcribe-03-2026",
    remoteTranscriptionUrl: "",
    remoteTranscriptionModel: "",
    meetingTranscriptionMode: "providers",
    meetingUseLocalWhisper: false,
    meetingCloudTranscriptionMode: "byok",
    meetingCloudTranscriptionProvider: "",
    meetingCloudTranscriptionModel: "",
    meetingCloudTranscriptionBaseUrl: "",
    meetingLocalTranscriptionProvider: "nvidia",
    meetingWhisperModel: "",
    meetingParakeetModel: "",
    meetingCohereModel: "",
    meetingRemoteTranscriptionUrl: "",
    uploadTranscriptionMode: "providers",
    uploadUseLocalWhisper: false,
    uploadCloudTranscriptionMode: "byok",
    uploadCloudTranscriptionProvider: "custom",
    uploadCloudTranscriptionModel: "gpt-4o-transcribe",
    uploadCloudTranscriptionBaseUrl: FOUNDRY,
    uploadLocalTranscriptionProvider: "whisper",
    uploadWhisperModel: "",
    uploadParakeetModel: "",
    uploadCohereModel: "",
    uploadRemoteTranscriptionUrl: "",
    uploadRemoteTranscriptionModel: "",
    transcriptionModelByProvider: { "dictation:openai": "gpt-4o-mini-transcribe" },
  };
  // Everything on this computer; live recording borrows Recognition's Parakeet model.
  const local = {
    ...daily,
    transcriptionMode: "local",
    useLocalWhisper: true,
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-transcribe",
    cloudTranscriptionBaseUrl: "https://api.openai.com/v1",
    localTranscriptionProvider: "nvidia",
    parakeetModel: "nemotron-speech-streaming-en-0.6b",
    meetingTranscriptionMode: "local",
    meetingUseLocalWhisper: true,
    uploadTranscriptionMode: "local",
    uploadUseLocalWhisper: true,
    uploadLocalTranscriptionProvider: "cohere",
    uploadCohereModel: "cohere-transcribe-03-2026",
    uploadCloudTranscriptionProvider: "",
    uploadCloudTranscriptionModel: "",
    uploadCloudTranscriptionBaseUrl: "",
    transcriptionModelByProvider: {},
  };
  // Recognition on Deepgram (live-only), live recording and uploads on OpenWhispr
  // Cloud with nothing of their own (uploads fall back to OpenAI, never Deepgram).
  const cloud = {
    ...daily,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "deepgram",
    cloudTranscriptionModel: "nova-3",
    cloudTranscriptionBaseUrl: "https://api.openai.com/v1",
    localTranscriptionProvider: "whisper",
    meetingTranscriptionMode: "openwhispr",
    meetingCloudTranscriptionMode: "openwhispr",
    meetingLocalTranscriptionProvider: "whisper",
    uploadTranscriptionMode: "openwhispr",
    uploadCloudTranscriptionMode: "",
    uploadCloudTranscriptionProvider: "",
    uploadCloudTranscriptionModel: "",
    uploadCloudTranscriptionBaseUrl: "",
    remoteTranscriptionUrl: "http://192.168.1.20:8178",
    remoteTranscriptionModel: "large-v3",
    uploadRemoteTranscriptionUrl: "http://192.168.1.21:8178",
    transcriptionModelByProvider: { "upload:groq": "whisper-large-v3" },
  };
  return { daily, local, cloud };
}

// ── The old editors' handlers, as they were before the picker ─────────────────

/** The mode cards each surface had (TranscriptionSection / MeetingTranscriptionPanel / UploadTranscriptionPanel). */
function oldModeCards(surface, policy, isSignedIn) {
  const cards = [
    { id: "openwhispr", disabled: !isSignedIn },
    { id: "providers" },
    { id: "local" },
    { id: "self-hosted", ...(surface === "liveRecording" ? { disabled: true } : {}) },
  ];
  if (surface !== "liveRecording" && env.rules.isEnterpriseTranscriptionOfferable(policy)) {
    cards.push({ id: "enterprise" });
  }
  return cards;
}

function oldCatalog(surface) {
  if (surface === "liveRecording") {
    return {
      byokProviders: env.registry.getMeetingStreamingTranscriptionProviders().map((p) => p.id),
    };
  }
  return {
    byokProviders: env.store.TRANSCRIPTION_POLICY_PROVIDER_IDS,
    enterpriseProviders: env.store.TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS,
  };
}

const STORED_MODE = {
  dictation: "transcriptionMode",
  liveRecording: "meetingTranscriptionMode",
  fileTranscription: "uploadTranscriptionMode",
};

/** usePolicyModeOptions' effectiveMode (Cloud switch on), re-derived from policyRules. */
function oldEffectiveMode(surface, policy) {
  const s = state();
  const selected = s[STORED_MODE[surface]];
  const cards = oldModeCards(surface, policy, s.isSignedIn);
  const switched = env.cloudModes.applyCloudSwitchToModeOptions(cards, false, selected, {
    badge: "",
    description: "",
  });
  const modes = env.rules.filterModeOptionsByPolicy(
    switched,
    "transcription",
    policy,
    oldCatalog(surface)
  );
  const visible = modes.some((option) => option.id === selected && !option.disabled);
  if (policy.status === "idle" || policy.status === "unmanaged" || visible) return selected;
  return env.rules.reconcilePolicyModeSelection(
    cards,
    "transcription",
    policy,
    selected,
    oldCatalog(surface)
  );
}

const OLD = {
  calls: { signIn: 0, toasts: [] },
  modeCard(surface, mode, policy) {
    const s = state();
    if (!env.rules.isModeAllowedByPolicy(policy, "transcription", mode)) return;
    if (surface === "liveRecording" && mode === "self-hosted") return;
    if (mode === "openwhispr" && !s.isSignedIn) {
      OLD.calls.signIn += 1;
      return;
    }
    if (mode === oldEffectiveMode(surface, policy)) return;
    if (surface === "dictation") {
      s.setTranscriptionMode(mode);
      s.setUseLocalWhisper(mode === "local");
      s.updateTranscriptionSettings({ useLocalWhisper: mode === "local" });
      s.setCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
      if (mode === "enterprise") s.setEnterpriseTranscriptionSetupMode("managed");
      OLD.calls.toasts.push(mode);
    } else if (surface === "liveRecording") {
      s.setMeetingTranscriptionMode(mode);
      s.setMeetingUseLocalWhisper(mode === "local");
      s.setMeetingCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
    } else {
      s.setUploadTranscriptionMode(mode);
      s.setUploadUseLocalWhisper(mode === "local");
      s.setUploadCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
      if (mode === "enterprise") s.setEnterpriseTranscriptionSetupMode("managed");
    }
  },
  /** The provider tab browsed, then a model clicked (or the custom model field typed into). */
  cloudModel(surface, provider, model) {
    const s = state();
    const selectedCloudProvider = {
      dictation: s.cloudTranscriptionProvider,
      liveRecording: s.meetingCloudTranscriptionProvider,
      fileTranscription: s.uploadCloudTranscriptionProvider,
    }[surface];
    if (provider !== selectedCloudProvider) {
      s.switchCloudTranscriptionProvider(CONTEXT[surface], provider);
    }
    const next = state();
    ({
      dictation: next.setCloudTranscriptionModel,
      liveRecording: next.setMeetingCloudTranscriptionModel,
      fileTranscription: next.setUploadCloudTranscriptionModel,
    })[surface](model);
  },
  /** A downloaded model's card clicked (handleWhisperModelSelect / handleParakeetModelSelect). */
  localModel(surface, modelId, engine) {
    const s = state();
    const scoped = {
      dictation: ["localTranscriptionProvider", "whisperModel", "parakeetModel", "cohereModel"],
      liveRecording: [
        "meetingLocalTranscriptionProvider",
        "meetingWhisperModel",
        "meetingParakeetModel",
        "meetingCohereModel",
      ],
      fileTranscription: [
        "uploadLocalTranscriptionProvider",
        "uploadWhisperModel",
        "uploadParakeetModel",
        "uploadCohereModel",
      ],
    }[surface];
    const [providerKey, whisperKey, parakeetKey, cohereKey] = scoped;
    const selectedLocalModel =
      s[providerKey] === "nvidia"
        ? s[parakeetKey]
        : s[providerKey] === "cohere"
          ? s[cohereKey]
          : s[whisperKey];
    // LocalModelCard: a click on the selected (or a not-downloaded) model does nothing.
    if (modelId === selectedLocalModel) return;
    const setter = (key) => state()[`set${key[0].toUpperCase()}${key.slice(1)}`];
    const provider =
      engine === "whisper"
        ? "whisper"
        : env.organizations.getASRModelOrganization(modelId) === "cohere"
          ? "cohere"
          : "nvidia";
    setter(providerKey)(provider);
    if (provider === "nvidia") setter(parakeetKey)(modelId);
    else if (provider === "cohere") setter(cohereKey)(modelId);
    else setter(whisperKey)(modelId);
  },
};

// ── The picker side ───────────────────────────────────────────────────────────

function pickerContext(surface, policy, overrides = {}) {
  const raw = state();
  const ctx = { policy, cloudDisabled: false, isSignedIn: raw.isSignedIn };
  const mode = env.stt.sttEffectiveMode(surface, raw[STORED_MODE[surface]], ctx);
  return {
    ...ctx,
    keys: env.stt.sttKeyPresence(raw),
    localModels: DOWNLOADED,
    rememberedCustomModel: raw.transcriptionModelByProvider?.[`${CONTEXT[surface]}:custom`] ?? "",
    current: {
      mode,
      ...env.stt.sttCurrentFrom(surface, env.store.selectPolicyEffectiveSettings(raw, policy)),
    },
    ...overrides,
  };
}

function commit(surface, pick, { policy = UNMANAGED, context = {}, deps = {} } = {}) {
  const calls = { signIn: 0, modes: [] };
  const ctx = pickerContext(surface, policy, context);
  const result = env.adapter.commitSttSelection(surface, pick, {
    context: ctx,
    effectiveMode: ctx.current.mode,
    store: env.store.useSettingsStore.getState,
    requestSignIn: () => {
      calls.signIn += 1;
    },
    onModeChange: (mode) => calls.modes.push(mode),
    ...deps,
  });
  return { result, calls };
}

// ── What a recording runs on ──────────────────────────────────────────────────

function attempt(fn) {
  try {
    return fn();
  } catch (error) {
    return { threw: error.message };
  }
}

/** Every speech-to-text store key, its persisted copy, and every route a recording resolves. */
function snapshot(policy = UNMANAGED) {
  const { store, registry, route, streaming, meeting, file, rules } = env;
  const raw = state();
  const effective = store.selectPolicyEffectiveSettings(raw, policy);
  const providers = registry.getTranscriptionProviders();
  const keys = Object.fromEntries(STT_KEYS.map((key) => [key, raw[key]]));
  const persisted = Object.fromEntries(
    STT_KEYS.filter((key) => env.storage.getItem(key) !== null).map((key) => [
      key,
      env.storage.getItem(key),
    ])
  );

  const localModel = (provider, models) =>
    provider === "nvidia"
      ? models.parakeetModel
      : provider === "cohere"
        ? models.cohereModel
        : models.whisperModel;
  const meetingResolved = store.selectResolvedMeetingTranscription(effective);
  const uploadResolved = store.selectResolvedUploadTranscription(effective);
  const routes = {
    dictation: {
      // audioManager: local first, then the batch route (resolveBatchRoute forces the local flag off).
      local: effective.useLocalWhisper,
      route: route.resolveTranscriptionRoute({ settings: effective, policy, providers }),
      batch: route.resolveTranscriptionRoute({
        settings: { ...effective, useLocalWhisper: false },
        policy,
        providers,
      }),
      streamingProvider: streaming.resolveStreamingProviderName({
        settings: effective,
        context: "dictation",
        sttConfig: null,
        language: "auto",
      }),
      // useSettings' syncStartupPreferences: main stops and pre-warms local servers from these.
      startup: {
        useLocalWhisper: raw.useLocalWhisper,
        localTranscriptionProvider: raw.localTranscriptionProvider,
        model: localModel(raw.localTranscriptionProvider, raw) || undefined,
      },
      allowed: rules.isTranscriptionContextAllowed(policy, effective, "dictation"),
    },
    liveRecording: {
      resolved: meetingResolved,
      session: attempt(() =>
        meeting.resolveMeetingTranscriptionOptions({
          transcriptionMode: meetingResolved.transcriptionMode,
          language: "en",
          localProvider: meetingResolved.localTranscriptionProvider,
          whisperModel: meetingResolved.whisperModel,
          parakeetModel: meetingResolved.parakeetModel,
          cohereModel: meetingResolved.cohereModel,
          selectedProvider: meetingResolved.cloudTranscriptionProvider,
          selectedModel: meetingResolved.cloudTranscriptionModel,
          byokProviders: registry.getMeetingStreamingTranscriptionProviders(),
          managedProviders: [],
          cortiEnvironment: raw.cortiEnvironment,
          cortiTenant: raw.cortiTenant,
          keyterms: [],
        })
      ),
      allowed: rules.isTranscriptionContextAllowed(policy, effective, "meeting"),
    },
    fileTranscription: {
      resolved: uploadResolved,
      isOpenWhisprCloud:
        raw.isSignedIn &&
        uploadResolved.cloudTranscriptionMode === "openwhispr" &&
        !uploadResolved.useLocalWhisper,
      route: file.resolveFileTranscriptionRoute({
        ...uploadResolved,
        cortiEnvironment: raw.cortiEnvironment,
        cortiTenant: raw.cortiTenant,
        language: "en",
      }),
      allowed: rules.isTranscriptionContextAllowed(policy, effective, "upload"),
    },
  };
  return { keys, persisted, routes };
}

// ── Each kind of pick, as the old editor made it and as the picker makes it ──

const cloudKind = (provider, model, surfaces) => ({
  name: `${provider} · ${model}`,
  surfaces,
  old: (surface, policy) => {
    OLD.modeCard(surface, "providers", policy);
    OLD.cloudModel(surface, provider, model);
  },
  pick: { mode: "providers", provider, model },
});

const localKind = (id, engine) => ({
  name: `local ${id}`,
  surfaces: SURFACES,
  old: (surface, policy) => {
    OLD.modeCard(surface, "local", policy);
    OLD.localModel(surface, id, engine);
  },
  pick: () => ({
    mode: "local",
    provider: env.stt.localSttProvider({ id, engine }),
    model: id,
  }),
});

const ALL = SURFACES;
const NOT_LIVE = ["dictation", "fileTranscription"];
const NOT_UPLOAD = ["dictation", "liveRecording"];

const KINDS = [
  {
    name: "OpenWhispr Cloud",
    surfaces: ALL,
    old: (surface, policy) => OLD.modeCard(surface, "openwhispr", policy),
    pick: { mode: "openwhispr", provider: "", model: "" },
  },
  cloudKind("openai", "gpt-4o-transcribe", ALL),
  cloudKind("openai", "gpt-4o-mini-transcribe", ALL),
  cloudKind("openai", "gpt-transcribe", NOT_LIVE),
  cloudKind("groq", "whisper-large-v3-turbo", NOT_LIVE),
  cloudKind("xai", "grok-stt", NOT_LIVE),
  cloudKind("mistral", "voxtral-mini-latest", NOT_LIVE),
  cloudKind("gemini", "gemini-3.5-transcribe", NOT_LIVE),
  cloudKind("gemini", "gemini-3.5-transcribe-live", ["dictation"]),
  cloudKind("corti", "corti-transcribe", ALL),
  cloudKind("tinfoil", "voxtral-mini-4b-realtime", ALL),
  cloudKind("deepgram", "nova-3", NOT_UPLOAD),
  cloudKind("assemblyai", "universal-streaming-english", NOT_UPLOAD),
  {
    // The model typed into the custom endpoint's fields commits (as the Custom tab's model field did).
    name: "a custom endpoint's model",
    surfaces: NOT_LIVE,
    old: (surface, policy) => {
      OLD.modeCard(surface, "providers", policy);
      OLD.cloudModel(surface, "custom", "my-deployment");
    },
    pick: { mode: "providers", provider: "custom", model: "my-deployment" },
  },
  localKind("base", "whisper"),
  localKind("small", "whisper"),
  localKind("parakeet-tdt-0.6b-v3", "sherpa"),
  localKind("nemotron-speech-streaming-en-0.6b", "sherpa"),
  localKind("cohere-transcribe-03-2026", "sherpa"),
  localKind("orukeet-v0.1.0", "sherpa"),
  {
    name: "a self-hosted server",
    surfaces: NOT_LIVE,
    old: (surface, policy) => OLD.modeCard(surface, "self-hosted", policy),
    pick: { mode: "self-hosted", provider: "", model: "", action: "configureSelfHosted" },
  },
  {
    name: "enterprise",
    surfaces: NOT_LIVE,
    old: (surface, policy) => OLD.modeCard(surface, "enterprise", policy),
    pick: { mode: "enterprise", provider: "", model: "" },
  },
];

test("every pick leaves the store, its persisted copy and every route as the old editors did", async (t) => {
  await load(t);
  const starts = fixtures();
  let compared = 0;
  const perSurface = { dictation: 0, liveRecording: 0, fileTranscription: 0 };
  let persistedWrites = 0;
  for (const [policyName, policy] of [
    ["unmanaged", UNMANAGED],
    ["managed", MANAGED],
  ]) {
    for (const [startName, start] of Object.entries(starts)) {
      for (const surface of SURFACES) {
        for (const kind of KINDS) {
          if (!kind.surfaces.includes(surface)) continue;
          reset(start);
          const pick = typeof kind.pick === "function" ? kind.pick() : kind.pick;
          const offered = env.stt.sttPickAvailability(
            surface,
            pick,
            pickerContext(surface, policy)
          );
          // Policy (or the surface) hides it, as it hid the old mode card or provider tab.
          if (offered === null) continue;
          const label = `${policyName}, ${startName}, ${surface}: ${kind.name}`;
          assert.equal(offered, true, `${label} is pickable`);

          reset(start);
          OLD.calls.toasts = [];
          kind.old(surface, policy);
          const before = snapshot(policy);
          const oldToasts = [...OLD.calls.toasts];

          reset(start);
          const { result, calls } = commit(surface, pick, { policy });
          assert.equal(result.status, "committed", label);
          assert.deepEqual(snapshot(policy), before, label);
          // Recognition toasted each mode switch; the other surfaces had no toast.
          if (surface === "dictation") assert.deepEqual(calls.modes, oldToasts, label);
          compared += 1;
          perSurface[surface] += 1;
          persistedWrites += Object.keys(before.persisted).length;
        }
      }
    }
  }
  assert.ok(compared >= 180, `${compared} comparisons`);
  for (const surface of SURFACES) {
    assert.ok(perSurface[surface] >= 40, `${surface}: ${perSurface[surface]} comparisons`);
  }
  assert.ok(persistedWrites > 0, "the persisted copy is compared too");
  console.log(`stt adapter equivalence: ${compared} comparisons ${JSON.stringify(perSurface)}`);
});

test("the custom endpoint's entry browses, or gives the mode back to an endpoint already set", async (t) => {
  await load(t);
  const { daily, local } = fixtures();
  const entry = { mode: "providers", provider: "custom", model: "", action: "configureCustom" };

  // Already on the endpoint in providers mode: it only shows the fields.
  reset(daily);
  let before = snapshot();
  assert.equal(commit("dictation", entry).result.status, "browse");
  assert.deepEqual(snapshot(), before);

  // Another provider stored: browse; the pick happens on a model in the fields.
  reset(local);
  before = snapshot();
  for (const surface of ["dictation", "fileTranscription"]) {
    assert.equal(commit(surface, entry).result.status, "browse", surface);
  }
  assert.deepEqual(snapshot(), before, "browsing writes nothing");

  // The endpoint stored under another mode (Local): the entry is the old "Cloud
  // providers" card, which switched the mode and kept the endpoint.
  for (const surface of ["dictation", "fileTranscription"]) {
    const start = {
      ...daily,
      transcriptionMode: "local",
      useLocalWhisper: true,
      uploadTranscriptionMode: "local",
      uploadUseLocalWhisper: true,
    };
    reset(start);
    OLD.calls.toasts = [];
    OLD.modeCard(surface, "providers", UNMANAGED);
    const expected = snapshot();
    reset(start);
    const { result, calls } = commit(surface, { ...entry, model: "gpt-4o-transcribe" });
    assert.equal(result.status, "committed", surface);
    assert.deepEqual(snapshot(), expected, surface);
    assert.deepEqual(calls.modes, ["providers"], surface);
  }
});

test("away and back: the remembered custom endpoint restores Recognition and uploads as typing it did", async (t) => {
  await load(t);
  const { daily } = fixtures();
  for (const surface of ["dictation", "fileTranscription"]) {
    const away = { mode: "providers", provider: "openai", model: "gpt-4o-mini-transcribe" };

    reset(daily);
    OLD.modeCard(surface, "providers", UNMANAGED);
    OLD.cloudModel(surface, "openai", away.model);
    // The old way back: the Custom tab, then the model typed into its field.
    OLD.cloudModel(surface, "custom", "gpt-4o-transcribe");
    const expected = snapshot();

    reset(daily);
    commit(surface, away);
    const ctx = pickerContext(surface, UNMANAGED);
    const custom = env.stt
      .buildSttPickerOptions(surface, ctx)
      .find((group) => group.id === "custom").options;
    assert.deepEqual(
      custom.map((option) => option.id),
      ["custom:remembered", "custom"],
      surface
    );
    const back = custom[0];
    assert.equal(back.model, "gpt-4o-transcribe", surface);
    assert.equal(back.sub.text, "contoso-foundry.cognitiveservices.azure.com", surface);
    const { result } = commit(surface, back);
    assert.equal(result.status, "committed", surface);
    assert.deepEqual(snapshot(), expected, surface);
    // The endpoint, model and route are the original ones again.
    const original = (() => {
      reset(daily);
      return snapshot();
    })();
    assert.deepEqual(expected.routes, original.routes, `${surface}: same route as before`);
  }
});

test("Cloud while signed out asks to sign in and writes nothing; Cloud off is refused", async (t) => {
  await load(t);
  const { daily } = fixtures();
  for (const surface of SURFACES) {
    reset({ ...daily, isSignedIn: false });
    const before = snapshot();
    const signedOut = commit(surface, { mode: "openwhispr", provider: "", model: "" });
    assert.equal(signedOut.result.status, "signIn", surface);
    assert.equal(signedOut.calls.signIn, 1, surface);
    assert.deepEqual(signedOut.calls.modes, []);
    assert.deepEqual(snapshot(), before, `${surface}: nothing written`);

    const off = commit(
      surface,
      { mode: "openwhispr", provider: "", model: "" },
      { context: { cloudDisabled: true } }
    );
    assert.equal(off.result.status, "refused", surface);
    assert.equal(off.result.reason.reasonKey, "modelPicker.reasons.cloudOff");
    assert.equal(off.calls.signIn, 0, "no sign-in while Cloud is off");
    assert.deepEqual(snapshot(), before);
  }
});

test("a pick that became invalid by commit time, or the surface can't run, is refused", async (t) => {
  await load(t);
  const { daily } = fixtures();
  const refused = (label, surface, pick, options, reasonKey) => {
    reset(daily);
    const before = snapshot(options.policy);
    const { result, calls } = commit(surface, pick, options);
    assert.equal(result.status, "refused", label);
    assert.equal(result.reason?.reasonKey ?? null, reasonKey, label);
    assert.deepEqual(calls.modes, [], label);
    assert.deepEqual(snapshot(options.policy), before, `${label}: nothing written`);
  };
  const groq = { mode: "providers", provider: "groq", model: "whisper-large-v3-turbo" };
  refused(
    "the key was removed",
    "dictation",
    groq,
    { context: { keys: {} } },
    "modelPicker.reasons.noKey"
  );
  refused(
    "Corti needs both client credentials",
    "dictation",
    { mode: "providers", provider: "corti", model: "corti-transcribe" },
    { context: { keys: { corti: false } } },
    "modelPicker.reasons.noKey"
  );
  refused(
    "policy now forbids the provider",
    "dictation",
    { mode: "providers", provider: "xai", model: "grok-stt" },
    { policy: MANAGED },
    null
  );
  refused(
    "policy now forbids the mode",
    "dictation",
    { mode: "openwhispr", provider: "", model: "" },
    { policy: MANAGED },
    null
  );
  refused(
    "the local model was deleted",
    "dictation",
    { mode: "local", provider: "nvidia", model: "parakeet-tdt-0.6b-v3" },
    { context: { localModels: [] } },
    null
  );
  refused(
    "sherpa-onnx can't run on this Mac",
    "dictation",
    { mode: "local", provider: "nvidia", model: "parakeet-tdt-0.6b-v3" },
    { context: { sherpa: { supported: false, minimumMacOSVersion: "15.5" } } },
    "modelPicker.stt.reasons.requiresMacOS"
  );
  refused(
    "a local model under the wrong engine",
    "dictation",
    { mode: "local", provider: "whisper", model: "parakeet-tdt-0.6b-v3" },
    {},
    null
  );
  refused("live recording can't batch Groq", "liveRecording", groq, {}, null);
  refused(
    "live recording needs OpenAI's streaming models",
    "liveRecording",
    { mode: "providers", provider: "openai", model: "gpt-transcribe" },
    {},
    null
  );
  refused(
    "live recording has no custom endpoint",
    "liveRecording",
    { mode: "providers", provider: "custom", model: "my-deployment" },
    {},
    null
  );
  refused(
    "live recording's self-hosted server isn't there yet",
    "liveRecording",
    { mode: "self-hosted", provider: "", model: "" },
    {},
    "modelPicker.stt.reasons.selfHostedLiveRecording"
  );
  refused(
    "uploads can't use a live-only provider",
    "fileTranscription",
    { mode: "providers", provider: "deepgram", model: "nova-3" },
    {},
    null
  );
  refused(
    "enterprise needs a managed policy",
    "dictation",
    { mode: "enterprise", provider: "", model: "" },
    {},
    null
  );
  refused(
    "live recording has no enterprise lane",
    "liveRecording",
    { mode: "enterprise", provider: "", model: "" },
    { policy: MANAGED },
    null
  );
});

test("Recognition's toast fires on a mode change only; a selected local model isn't rewritten", async (t) => {
  await load(t);
  const { daily, local } = fixtures();
  reset(daily);
  const toLocal = commit("dictation", {
    mode: "local",
    provider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
  });
  assert.deepEqual(toLocal.calls.modes, ["local"]);
  const sameMode = commit("dictation", { mode: "local", provider: "whisper", model: "base" });
  assert.deepEqual(sameMode.calls.modes, []);
  assert.equal(sameMode.result.modeChanged, false);
  assert.equal(state().localTranscriptionProvider, "whisper");

  // The selected model: nothing written (the card ignored the click).
  reset(local);
  env.storage.clear();
  const again = commit("dictation", {
    mode: "local",
    provider: "nvidia",
    model: "nemotron-speech-streaming-en-0.6b",
  });
  assert.equal(again.result.status, "committed");
  assert.deepEqual(again.calls.modes, []);
  assert.deepEqual(
    STT_KEYS.filter((key) => env.storage.getItem(key) !== null),
    [],
    "nothing persisted"
  );
});

test("live recording and uploads keep inheriting until a pick overrides them", async (t) => {
  await load(t);
  const { daily, local, cloud } = fixtures();
  const { stt, store } = env;

  for (const [name, start, surface, expected] of [
    [
      "live recording on Recognition's endpoint",
      daily,
      "liveRecording",
      [
        ["provider", "inherited"],
        ["endpoint", "inherited"],
        ["model", "inherited"],
      ],
    ],
    [
      "live recording on Recognition's Nemotron",
      local,
      "liveRecording",
      [
        ["engine", "own"],
        ["model", "inherited"],
      ],
    ],
    [
      "live recording on local Whisper with no model anywhere",
      { ...local, meetingLocalTranscriptionProvider: "whisper", whisperModel: "" },
      "liveRecording",
      [
        ["engine", "own"],
        ["model", "default"],
      ],
    ],
    [
      "uploads after a live-only Recognition provider",
      { ...cloud, uploadTranscriptionMode: "providers", uploadCloudTranscriptionMode: "byok" },
      "fileTranscription",
      [
        ["provider", "default"],
        ["model", "default"],
      ],
    ],
  ]) {
    reset(start);
    const before = snapshot();
    const ctx = pickerContext(surface, UNMANAGED);
    stt.buildSttPickerOptions(surface, ctx);
    stt.describeSttSelection(surface, ctx);
    const fields = stt.sttInheritedFields(
      surface,
      store.selectPolicyEffectiveSettings(state(), UNMANAGED),
      ctx.current.mode
    );
    assert.deepEqual(
      fields.map((field) => [field.field, field.source]),
      expected,
      name
    );
    assert.deepEqual(snapshot(), before, `${name}: showing it wrote nothing`);
  }

  // Live recording borrows Recognition's endpoint, which can't stream: the button says so.
  reset(daily);
  assert.deepEqual(
    stt.describeSttSelection("liveRecording", pickerContext("liveRecording", UNMANAGED)).warning,
    {
      key: "modelPicker.stt.reasons.needsStreaming",
    }
  );
  // A Recognition change still reaches the inherited surfaces.
  commit("dictation", { mode: "providers", provider: "groq", model: "whisper-large-v3-turbo" });
  assert.equal(
    store.selectResolvedMeetingTranscription(state()).cloudTranscriptionProvider,
    "groq"
  );
  assert.equal(state().meetingCloudTranscriptionProvider, "", "still inherited");
  // An explicit pick is live recording's own.
  commit("liveRecording", { mode: "providers", provider: "deepgram", model: "nova-3" });
  assert.equal(state().meetingCloudTranscriptionProvider, "deepgram");
  assert.equal(state().meetingCloudTranscriptionModel, "nova-3");
  assert.equal(state().cloudTranscriptionProvider, "groq", "Recognition untouched");
  assert.equal(
    stt.sttInheritedFields("liveRecording", state(), "providers"),
    null,
    "nothing inherited any more"
  );
});

test("dictation's local servers follow the pick as they followed the old writes", async (t) => {
  await load(t);
  const { daily } = fixtures();
  reset(daily);
  commit("dictation", { mode: "local", provider: "cohere", model: "cohere-transcribe-03-2026" });
  assert.deepEqual(snapshot().routes.dictation.startup, {
    useLocalWhisper: true,
    localTranscriptionProvider: "cohere",
    model: "cohere-transcribe-03-2026",
  });
  assert.equal(snapshot().routes.dictation.route.transport, "local");
  commit("dictation", { mode: "providers", provider: "openai", model: "gpt-4o-transcribe" });
  assert.equal(
    snapshot().routes.dictation.startup.useLocalWhisper,
    false,
    "main stops local servers"
  );
  assert.equal(snapshot().routes.dictation.streamingProvider, "openai-realtime");
});

nodeTest("the speech-to-text selection adapter", async (t) => {
  await load(t);
  for (const [name, fn] of subtests) await t.test(name, fn);
});

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
// is written by building the menu, showing inherited values or browsing. A pick
// on the custom connection (Recognition, File Transcription) leaves exactly what
// a hand-entered custom endpoint with the same URL, model and key leaves: main
// copies the key into the one speech-to-text slot first (awaited, read back),
// and a refused copy, or the shared-key rule, writes nothing.

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
  openrouterApiKey: "sk-or-test",
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
    window: { dispatchEvent: () => true },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-stt-picker-adapter-",
    // ModelPicker's provider icons import assets through the "@" alias.
    resolveAlias: { "@": require("node:path").resolve(__dirname, "../../src") },
    // A key read back from main clears the request service's key cache.
    mockModules: {
      "/services/ReasoningService": "export default { clearApiKeyCache() {} };",
    },
  });
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
    connection: await load("/components/settings/modelPicker/connectionOptions.ts"),
    pick: await load("/components/settings/modelPicker/connectionPick.ts"),
    hints: await load("/utils/sttHintFields.js"),
    hintTarget: await load("/utils/dictionaryHints.ts"),
    picker: await load("/components/settings/modelPicker/ModelPicker.tsx"),
    icons: await load("/utils/providerIcons.ts"),
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

// ── The old editors' handlers, as upstream v1.11.0 has them (#2989 included) ─────

/**
 * The mode cards each surface had (TranscriptionSection / MeetingTranscriptionPanel /
 * UploadTranscriptionPanel). No managed deployment resolves in these fixtures, so Live
 * Recording offers no enterprise card and File Transcription only a policy's.
 */
function oldModeCards(surface, policy, isSignedIn, managedAvailable = false) {
  if (surface === "liveRecording") {
    return [
      { id: "openwhispr", disabled: !isSignedIn },
      { id: "providers" },
      { id: "local" },
      ...(managedAvailable ? [{ id: "enterprise" }] : []),
      { id: "self-hosted", disabled: true },
    ];
  }
  const cards = [
    { id: "openwhispr", disabled: !isSignedIn },
    { id: "providers" },
    { id: "local" },
    { id: "self-hosted" },
  ];
  if (
    env.rules.isEnterpriseTranscriptionOfferable(policy) ||
    (surface === "fileTranscription" && managedAvailable)
  ) {
    cards.push({ id: "enterprise" });
  }
  return cards;
}

function oldCatalog(surface) {
  if (surface === "liveRecording") {
    return {
      byokProviders: env.registry.getMeetingStreamingTranscriptionProviders().map((p) => p.id),
      enterpriseProviders: env.store.TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS,
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
    // Only the explicit enterprise controls change the shared setup mode; the surface's
    // own mode stays as the user left it (#2989).
    if (mode === "enterprise") {
      if (surface === "dictation" && s.enterpriseTranscriptionSetupMode === "managed") return;
      s.setEnterpriseTranscriptionSetupMode("managed");
      if (surface === "dictation") OLD.calls.toasts.push(mode);
      return;
    }
    if (mode === oldEffectiveMode(surface, policy)) return;
    if (surface === "dictation") {
      s.setTranscriptionMode(mode);
      s.setUseLocalWhisper(mode === "local");
      s.updateTranscriptionSettings({ useLocalWhisper: mode === "local" });
      s.setCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
      OLD.calls.toasts.push(mode);
    } else if (surface === "liveRecording") {
      s.setMeetingTranscriptionMode(mode);
      s.setMeetingUseLocalWhisper(mode === "local");
      s.setMeetingCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
    } else {
      s.setUploadTranscriptionMode(mode);
      s.setUploadUseLocalWhisper(mode === "local");
      s.setUploadCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
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
  // OpenRouter brokers batch transcription only (#2105); Nova-3 through it is upload-only.
  cloudKind("openrouter", "mistralai/voxtral-mini-transcribe-3-0", NOT_LIVE),
  cloudKind("openrouter", "elevenlabs/scribe-v2", NOT_LIVE),
  cloudKind("openrouter", "deepgram/nova-3", ["fileTranscription"]),
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

test("OpenRouter: its speech models per surface, an unlisted id kept as itself, no dictionary sent", async (t) => {
  await load(t);
  const { daily } = fixtures();
  const group = (surface, policy = UNMANAGED) =>
    env.stt
      .buildSttPickerOptions(surface, pickerContext(surface, policy))
      .find((entry) => entry.id === "provider:openrouter") ?? null;
  const shipped = env.registry.getTranscriptionProvider("openrouter").models.map((m) => m.id);
  assert.ok(shipped.includes("deepgram/nova-3"), "the bundled catalog carries OpenRouter's list");

  reset(daily);
  // Uploads list every benchmarked model; Recognition leaves out the upload-only Nova-3,
  // which gets no dictionary through OpenRouter; live recording streams, which OpenRouter can't.
  assert.deepEqual(
    group("fileTranscription").options.map((option) => option.model),
    shipped
  );
  assert.deepEqual(
    group("dictation").options.map((option) => option.model),
    shipped.filter((id) => id !== "deepgram/nova-3")
  );
  assert.equal(group("liveRecording"), null);
  // A policy that doesn't name it hides it.
  assert.equal(group("dictation", MANAGED), null);
  // Each model names its vendor, for PickerIcon to draw that vendor's mark (or OpenRouter's).
  const icons = Object.fromEntries(
    group("fileTranscription").options.map((option) => [option.model, option.icon])
  );
  assert.equal(icons["mistralai/voxtral-mini-transcribe-3-0"], "openrouter:mistralai");
  assert.equal(icons["nvidia/nemotron-3.5-transcribe"], "openrouter:nvidia");
  assert.equal(icons["deepgram/nova-3"], "openrouter:deepgram");
  assert.equal(icons["elevenlabs/scribe-v2"], "openrouter:elevenlabs");
  // PickerIcon draws the vendor's mark, or OpenRouter's for a vendor without one.
  const { PickerIcon } = env.picker;
  assert.equal(
    PickerIcon({ icon: "openrouter:mistralai" }).props.src,
    env.icons.getProviderIcon("mistral")
  );
  assert.equal(PickerIcon({ icon: "openrouter:elevenlabs" }).props.provider, "openrouter");

  // Without its key, the group says where to add one.
  reset({ ...daily, openrouterApiKey: "" });
  const missing = group("dictation").options;
  assert.equal(missing.length, 1);
  assert.equal(missing[0].available.reasonKey, "modelPicker.reasons.noKey");

  // An id outside the shortlist (acceptsUnlistedTranscriptionModel) stays the selection,
  // shown first, and opening the menu writes nothing.
  const unlisted = {
    ...daily,
    cloudTranscriptionProvider: "openrouter",
    cloudTranscriptionModel: "openai/whisper-1",
  };
  reset(unlisted);
  const before = snapshot();
  const ctx = pickerContext("dictation", UNMANAGED);
  const first = group("dictation").options[0];
  assert.equal(first.model, "openai/whisper-1");
  assert.equal(first.available, true);
  assert.equal(env.stt.selectedSttOptionId(ctx.current), "provider:openrouter:openai/whisper-1");
  assert.equal(env.stt.describeSttSelection("dictation", ctx).title.text, "openai/whisper-1");
  assert.deepEqual(snapshot(), before);
  // Recognition never keeps the upload-only model through that pass-through.
  reset({ ...unlisted, cloudTranscriptionModel: "deepgram/nova-3" });
  assert.equal(
    env.stt.sttPickAvailability(
      "dictation",
      { mode: "providers", provider: "openrouter", model: "deepgram/nova-3" },
      pickerContext("dictation", UNMANAGED)
    ),
    null
  );

  // The request goes to OpenRouter with its own key, and carries no dictionary: OpenRouter
  // drops `prompt`, so live dictation and Re-transcribe send none, script bias included.
  reset({ ...unlisted, cloudTranscriptionModel: "mistralai/voxtral-mini-transcribe-3-0" });
  const route = env.route.resolveTranscriptionRoute({
    settings: state(),
    policy: UNMANAGED,
    providers: env.registry.getTranscriptionProviders(),
  });
  assert.equal(route.transport, "http-batch");
  assert.equal(route.provider, "openrouter");
  assert.deepEqual(route.auth, { scheme: "bearer", keyRef: "openrouter" });
  assert.equal(new URL(route.endpoint).hostname, "openrouter.ai");
  const target = env.hintTarget.resolveHintTarget({
    engine: "byok",
    provider: "openrouter",
    endpoint: route.endpoint,
    model: route.model,
  });
  assert.equal(target.channel, "none");
  const fields = env.hints.buildSttHintFields(
    {
      route: "openai-compatible",
      provider: "openrouter",
      endpoint: route.endpoint,
      model: route.model,
    },
    { words: ["Kusto", "OpenWhispr"], chineseScriptPreference: "simplified" }
  );
  assert.equal(fields.prompt, null);
  assert.deepEqual(fields.keywords, []);
  assert.equal(fields.echo, null);
  assert.ok(fields.entries.length > 0);
  assert.ok(fields.entries.every((entry) => entry.coverage === "notSent"));
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

// ── The custom connection ─────────────────────────────────────────────────────

const LB_ORIGIN = "https://littlebuddy-foundry-eus2.openai.azure.com";
const LB = {
  name: "Little Buddy",
  endpoint: LB_ORIGIN,
  models: { language: ["gpt-5-mini"], speech: ["gpt-4o-transcribe"] },
};
// Stands in for the connection's key; it only ever moves main → store here.
const LB_KEY = "lb-test-key";
const LB_OPERATION = `${LB_ORIGIN}/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview`;
const NOTHING_ELSE = { matches: null, conflict: null };

/** Main, as the custom-connection IPCs and the shared key's getter see them. */
function installMain({ fail = false, hold = false, compare } = {}) {
  const main = { value: "", calls: [], events: [], release: () => {} };
  globalThis.window.electronAPI = {
    customConnectionApplyKey: async (args) => {
      main.calls.push(["apply", args.slots]);
      main.events.push("apply:start");
      if (hold) await new Promise((resolve) => (main.release = resolve));
      if (fail) {
        main.events.push("apply:failed");
        throw new Error("The custom connection has no key");
      }
      main.value = LB_KEY;
      main.events.push("apply:end");
      return { success: true };
    },
    customConnectionCompare: async (args) => {
      main.calls.push(["compare", args.slots]);
      return compare;
    },
    getCustomTranscriptionKey: async () => {
      main.calls.push(["get"]);
      return main.value;
    },
  };
  return main;
}

const lbConnection = (sharedKey = NOTHING_ELSE, overrides = {}) => ({
  ...env.connection.pickerConnection(LB, { capability: "speech", hasKey: true }),
  sharedKey,
  ...overrides,
});

/** A pick on Little Buddy, through the adapter with the real key step. */
async function commitOnConnection(
  surface,
  model,
  { policy = UNMANAGED, connection = lbConnection() } = {}
) {
  const modes = [];
  const ctx = pickerContext(surface, policy, { connection });
  const result = await env.adapter.commitSttConnectionSelection(surface, model, {
    context: ctx,
    effectiveMode: ctx.current.mode,
    store: env.store.useSettingsStore.getState,
    requestSignIn: () => {},
    onModeChange: (mode) => modes.push(mode),
    connection: LB,
    applyKey: env.pick.applyConnectionKey,
    rememberModel: (name) => env.pick.rememberConnectionModel(name, "speech"),
  });
  return { result, modes };
}

/** The same choice made by hand: the custom endpoint's URL, the shared key, then the model. */
function manualCustomPick(surface, model, url, policy) {
  const s = state();
  (surface === "fileTranscription"
    ? s.setUploadCloudTranscriptionBaseUrl
    : s.setCloudTranscriptionBaseUrl)(url);
  // The key field's write to the store (its debounced save to main is the field's own).
  env.store.useSettingsStore.setState({ customTranscriptionApiKey: LB_KEY });
  const { result, calls } = commit(
    surface,
    { mode: "providers", provider: "custom", model },
    { policy }
  );
  assert.equal(result.status, "committed");
  return calls.modes;
}

const fresh = (start) => reset({ customConnection: null, ...start });

test("a pick on the connection leaves exactly what a hand-entered custom endpoint leaves", async (t) => {
  await load(t);
  const starts = fixtures();
  // Already on Little Buddy, through a pasted operation URL for its deployment.
  starts.pasted = {
    ...starts.daily,
    cloudTranscriptionBaseUrl: LB_OPERATION,
    uploadCloudTranscriptionBaseUrl: "",
  };
  let compared = 0;
  for (const [policyName, policy] of [
    ["unmanaged", UNMANAGED],
    ["managed", MANAGED],
  ]) {
    for (const [startName, start] of Object.entries(starts)) {
      for (const surface of SURFACES) {
        for (const model of ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"]) {
          const label = `${policyName}, ${startName}, ${surface}: ${model}`;
          fresh(start);
          const offered = env.stt.sttPickAvailability(
            surface,
            { mode: "providers", provider: "custom", model, action: "useConnection" },
            pickerContext(surface, policy, { connection: lbConnection() })
          );
          if (surface === "liveRecording") {
            assert.equal(offered, null, `${label}: no custom lane`);
            continue;
          }
          assert.equal(offered, true, `${label} is offered`);
          // The pasted URL names gpt-4o-transcribe: kept for it, the resource's otherwise.
          const pasted =
            startName === "pasted" && surface === "dictation" && model === "gpt-4o-transcribe";
          const inheritsPasted =
            startName === "pasted" &&
            surface === "fileTranscription" &&
            model === "gpt-4o-transcribe";
          const url = pasted || inheritsPasted ? LB_OPERATION : LB_ORIGIN;

          fresh(start);
          const manualModes = manualCustomPick(surface, model, url, policy);
          const expected = snapshot(policy);

          fresh(start);
          const main = installMain();
          const { result, modes } = await commitOnConnection(surface, model, { policy });
          assert.equal(result.status, "committed", label);
          assert.deepEqual(snapshot(policy), expected, label);
          assert.deepEqual(modes, manualModes, `${label}: the mode-change toast`);
          assert.deepEqual(main.calls[0], ["apply", ["CUSTOM_TRANSCRIPTION_API_KEY"]], label);
          compared += 1;
        }
      }
    }
  }
  assert.equal(compared, 2 * 4 * 2 * 2);
});

test("the shared key is copied, and read back, before anything else is written", async (t) => {
  await load(t);
  const { daily } = fixtures();
  const { store } = env;
  fresh(daily);
  const before = snapshot();
  const main = installMain({ hold: true });
  const writes = [];
  const unsubscribe = store.useSettingsStore.subscribe((s) =>
    writes.push({
      main: main.events.at(-1),
      url: s.uploadCloudTranscriptionBaseUrl,
      key: s.customTranscriptionApiKey,
    })
  );
  const setItem = env.storage.setItem;
  env.storage.setItem = (key, value) => {
    writes.push({ main: main.events.at(-1), persisted: key });
    setItem(key, value);
  };
  t.after(() => {
    unsubscribe();
    env.storage.setItem = setItem;
  });

  const pending = commitOnConnection("fileTranscription", "gpt-4o-transcribe", {
    connection: lbConnection({ matches: true, conflict: "recognition" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(main.events, ["apply:start"], "main is copying the key");
  assert.deepEqual(writes, [], "nothing written while it does");
  assert.deepEqual(snapshot(), before);

  main.release();
  const { result } = await pending;
  assert.equal(result.status, "committed");
  assert.ok(writes.length > 0);
  assert.ok(
    writes.every((write) => write.main === "apply:end"),
    "every write after main's copy"
  );
  assert.equal(writes[0].key, LB_KEY, "the key comes first");
  const firstUrl = writes.findIndex((write) => write.url === LB_ORIGIN);
  assert.ok(firstUrl > 0);
  assert.ok(writes.slice(firstUrl).every((write) => !("key" in write) || write.key === LB_KEY));
  assert.deepEqual(
    main.calls.map(([call]) => call),
    ["apply", "get"]
  );
});

test("a refused key copy, the shared-key rule or a surface without a custom lane writes nothing", async (t) => {
  await load(t);
  const { daily } = fixtures();
  fresh(daily);
  const before = snapshot();

  const failing = installMain({ fail: true });
  const refused = await commitOnConnection("dictation", "gpt-4o-transcribe");
  assert.equal(refused.result.status, "refused");
  assert.deepEqual(refused.result.reason, {
    reasonKey: "modelPicker.connection.reasons.keyFailed",
    reasonParams: { name: "Little Buddy" },
  });
  assert.deepEqual(snapshot(), before, "nothing written");
  assert.deepEqual(
    failing.calls.map(([call]) => call),
    ["apply"]
  );

  for (const [label, surface, connection, reason] of [
    [
      "File Transcription still sends another key elsewhere",
      "dictation",
      lbConnection({ matches: false, conflict: "fileTranscription" }),
      "modelPicker.connection.reasons.sharedKey",
    ],
    ["no connection any more", "dictation", null, null],
    [
      "the connection has no key",
      "fileTranscription",
      lbConnection(NOTHING_ELSE, { hasKey: false }),
      "modelPicker.reasons.noKey",
    ],
    ["Live Recording", "liveRecording", lbConnection(), null],
  ]) {
    const main = installMain();
    const { result } = await commitOnConnection(surface, "gpt-4o-transcribe", { connection });
    assert.equal(result.status, "refused", label);
    assert.equal(result.reason?.reasonKey ?? null, reason, label);
    assert.deepEqual(main.calls, [], `${label}: main isn't asked`);
    assert.deepEqual(snapshot(), before, `${label}: nothing written`);
  }
  // Browsing ("Enter a deployment name…") writes nothing either.
  assert.equal(
    commit("dictation", {
      mode: "providers",
      provider: "custom",
      model: "",
      action: "enterConnectionModel",
    }).result.status,
    "browse"
  );
  assert.deepEqual(snapshot(), before);
});

test("main answers whether the shared key already is the connection's, as a boolean", async (t) => {
  await load(t);
  for (const [answer, expected] of [
    [{ CUSTOM_TRANSCRIPTION_API_KEY: true }, true],
    [{ CUSTOM_TRANSCRIPTION_API_KEY: false }, false],
    [undefined, null],
  ]) {
    const main = installMain({ compare: answer });
    assert.equal(await env.pick.compareSharedSttKey(), expected);
    assert.deepEqual(main.calls, [["compare", ["CUSTOM_TRANSCRIPTION_API_KEY"]]]);
  }
  globalThis.window.electronAPI = {};
  assert.equal(await env.pick.compareSharedSttKey(), null, "no IPC, no answer");
});

test("a committed pick is remembered on the connection as a speech model", async (t) => {
  await load(t);
  const { daily } = fixtures();
  fresh({ ...daily, customConnection: LB });
  installMain();
  await commitOnConnection("dictation", "gpt-4o-mini-transcribe");
  assert.deepEqual(state().customConnection.models, {
    language: ["gpt-5-mini"],
    speech: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
  });
  installMain({ fail: true });
  await commitOnConnection("dictation", "whisper-1");
  assert.deepEqual(state().customConnection.models.speech, [
    "gpt-4o-transcribe",
    "gpt-4o-mini-transcribe",
  ]);
});

nodeTest("the speech-to-text selection adapter", async (t) => {
  await load(t);
  for (const [name, fn] of subtests) await t.test(name, fn);
});

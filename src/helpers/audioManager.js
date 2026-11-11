import i18n from "../i18n";
import ReasoningService from "../services/ReasoningService";
import {
  EMPTY_OUTPUT_MESSAGE_KEY,
  TRUNCATED_OUTPUT_MESSAGE_KEY,
} from "../services/ai/chatRequestBody";
import logger from "../utils/logger";
import { logText } from "../utils/logText.js";
import { markStartTrace } from "../utils/dictationStartTrace";
import { canStartDictation } from "../utils/dictationReadiness";
import { finishCleanupOutput } from "../utils/cleanupOutput";
import { isAzureOpenAIEndpoint } from "../utils/urlUtils";
import { withSessionRefresh } from "../lib/auth";
import { getBaseLanguageCode, getLanguageLabel } from "../utils/languageSupport";
import { convertToWav, needsWavConversion } from "../utils/audioContainer";
import {
  applyChineseScript,
  mergeWhisperPrompt,
  resolveChineseScriptTarget,
  resolveCleanupLanguage,
} from "../utils/chineseScript";
import {
  createLocalSpeechGateState,
  getLocalSpeechGateDecision,
  recordLocalSpeechWindow,
  recordPcm16SpeechWindow,
} from "./localSpeechGate";
import { reacquireIfDead } from "./micTrackHealth";
import { isMicWarm, WARMUP_ACQUIRE_TIMEOUT_MS } from "./micWarmState";
import {
  PreparedMicCapture,
  disposePreparedCapture,
  discardPreRoll,
  PRE_ROLL_MAX_AGE_MS,
} from "./preparedMicCapture";
import { MicStreamHold } from "./micStreamHold";
import { PcmTap } from "./pcmTap";
import { ActiveMicRecoveryController } from "./activeMicRecovery";
import { followsSystemDefaultMic } from "./micSelectionRecovery";
import {
  isCacheableMicrophoneResolution,
  resolvePreferredMicrophone,
  TRANSCRIPTION_AUDIO_CONSTRAINTS,
} from "./microphoneSelection";
import { isStaleDeviceError } from "./staleMicDevice";
import { shouldSaveDiscardedRecording } from "./discardedRecording";
import {
  ANALYTICS_COUNTER_VERSION,
  countSpokenWords,
  localDateKey,
  resolveAnalyticsMode,
} from "./analytics";
import {
  getSettings,
  useSettingsStore,
  getEffectiveCleanupModel,
  isCloudCleanupMode,
  isCloudDictationAgentMode,
  isCloudTranslationMode,
  selectResolvedLLMConfig,
} from "../stores/settingsStore";

import {
  effectiveAudioRetentionDays,
  effectiveLocalHistoryEnabled,
  isAgentAllowed,
  isCloudBackupAllowed,
  isLlmSelectionAllowed,
  isLocalChoiceRefusal,
  isLocalModelAllowedByPolicy,
  isTranscriptionContextAllowed,
  isTranscriptionSelectionAllowed,
  localModelRefusal,
} from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import {
  getBatchTranscriptionModel,
  getCloudModel,
  getProviderDisplayName,
  getTranscriptionProvider,
  getTranscriptionProviders,
  isOnlineParakeetModel,
  isSherpaLocalProvider,
} from "../models/ModelRegistry";
import { TINFOIL_PROXY_REQUIRED_ERROR } from "../services/transcriptionBaseUrl";
import {
  batchTranscriptionHttpError,
  byokFileSizeLimit,
  resolveByokModel,
  resolveTranscriptionRoute,
  STREAMING_ONLY_PROVIDERS,
} from "./transcriptionRoute.ts";
import {
  getManagedTranscriptionResolution,
  isManagedTranscriptionActive,
} from "../services/managedTranscription.ts";
import { getTranscriptionApiKey } from "../services/fileTranscription";
import { shouldSkipTranscriptionApiKey } from "./transcriptionAuth";
import {
  isOrukeetStreaming,
  isSelfHostedTranscription,
  resolveSelfHostedTranscriptionModel,
} from "./selfHostedTranscription";
import {
  isManagedOrukeetStream,
  isTranscriptionPolicyRefusal,
  resolveStreamingFallbackTarget,
  resolveStreamingStartFallback,
} from "./transcriptionFallback";
import { transcriptionFailureOutcome } from "./transcriptionFailureOutcome";
import {
  EMPTY_TRANSCRIPT_CODE,
  emptyDictationOutcome,
  emptyTranscriptError,
  normalizeQuietEmptyDictationSeconds,
} from "../utils/emptyDictation.js";
import { keptRecordingFor } from "./failedRecordingRetry";
import { sendDictationTranscription } from "./dictationTranscriptionClient";
import { transcriptionOutcomeTag } from "./connectionOutcomeTargets.js";
import { IPC_ERROR_FIELDS, errorFromIpcResult } from "./ipcErrorFields";
import {
  PROVIDER_ERROR_CODES,
  asProviderError,
  providerError,
  providerHttpError,
  redactProviderBody,
} from "./providerHttpErrors";
import {
  AZURE_SPEECH_NAME,
  AZURE_SPEECH_PROVIDER_ID,
  buildAzureSpeechRequest,
  parseAzureSpeechAnswer,
  resolveMaiLocale,
} from "./azureSpeechTranscription.js";
import {
  executeTranslationChain,
  hasTextContent,
  resolveTranslatedText,
  shouldRunTranslateStep,
} from "./translationChain";
import {
  detectAgentName,
  stripAgentAddress,
  stripAgentAddressPreservingFormatting,
} from "../config/agentDetection";
import {
  cleanupUnconfiguredNotice,
  resolveDictationRouteKind,
  resolveAgentImageTarget,
  resolveWakeWordLanguage,
} from "./dictationRouting";
import {
  resolveDictationAgentInference,
  resolveDictationAgentVisionInference,
} from "./dictationAgentInference";
import { providerSupportsImages } from "../services/ai/inferenceProviders";
import { resolveDictationTranslationInference } from "./dictationTranslationInference";
import { resolvePrompt, appendScreenContextSuffix } from "../config/prompts";
import { buildDictationCleanupConfig, cleanupStepMeta } from "./dictationCleanupConfig";
import { resolveDictationToneStyle } from "../config/toneStyle";
import { selectionEditToneSentence } from "../config/prompts/toneStyle";
import { syncService } from "../services/SyncService.js";
import { evaluateFinishedRecording, withSalvageWarning } from "./recordingValidation";
import { isEmptyRecording } from "./recordingGuard";
import { startRecordingSpool, takeInterruptedRecordings } from "./recordingSpool";
import {
  DEFAULT_RECORDING_QUALITY,
  normalizeRecordingQuality,
  recorderOptionsFor,
} from "../utils/recordingQuality.js";
import {
  analyzeDictionaryPromptFragment,
  dictionaryEchoError,
  matchesDictionaryPrompt,
  payloadSendsDictionaryBias,
  stripTrailingDictionaryEcho,
} from "../utils/dictionaryEchoFilter.js";
import {
  dictionaryPromptLimit,
  dictionaryReachesTranscriptionModel,
  PROMPT_HEAD_TERMS,
  sharedDictionaryPromptChars,
  trimDictionaryPrompt,
  WHISPER_DECODER_PROMPT_CHARS,
} from "../utils/dictionaryPromptCap.js";
import {
  dictionaryKeywordOverflow,
  dictionaryKeywords,
  usesTranscriptionKeywords,
} from "../utils/dictionaryKeywords.js";
import {
  getDictionaryHintTiers,
  getEffectiveDictionaryWords,
  getLlmDictionaryWords,
  MAX_SHARED_KEYTERMS,
  selectCleanupDictionary,
  toCloudDictionaryFields,
} from "../utils/snippets";
import { dictionaryWordKey } from "../utils/dictionaryWordKey.js";
import { buildDictionaryHints, resolveHintTarget } from "../utils/dictionaryHints";
import {
  hintScoresForDictionary,
  normalizeDictionaryHintOrder,
  normalizeHintScores,
} from "../utils/dictionaryHintOrder";
import { getGlossaryCanonicalTerms } from "../utils/glossaryTerms";
import { getGlossarySnapshot } from "../stores/glossaryStore";
import {
  getLearnedDictionaryWords,
  getPinnedDictionaryKeys,
} from "../stores/dictionarySourcesStore";
import { getDictionaryHintScores } from "../stores/dictionaryUsageStore";
import {
  passthroughStep,
  runPostTranscription,
  SERVER_PROMPT_REF,
  summarizeGlossaryTrace,
  traceStyle,
} from "./postTranscription";
import { isStyleReachable, runStyledDictation } from "../services/dictationStyles";
import { styleRouteKind } from "../config/styles/library";
import { COPILOT_PROVIDER_ID } from "../config/copilot";
import { normalizeAgentSelectionContext } from "../utils/agentSelectionContext";
import { getAgentName } from "../utils/agentName";
import { shouldDisplayDictationPreview } from "../utils/transcriptionPreview";
import {
  buildSelectionEditSystemPrompt,
  buildSelectionEditUserPrompt,
  buildLocalSelectionEditSystemPrompt,
  buildLocalSelectionEditUserPrompt,
  createSelectionCompletionMarker,
  extractLocalSelectionEditReplacement,
  SELECTION_EDIT_RESPONSE_FORMAT,
  extractSelectionEditReplacement,
  getSelectionCaptureDisposition,
  isSelectionQuestionResponse,
} from "./selectionEditing";
import {
  isOpenAiRealtimeSelection,
  isGeminiLiveSelection,
  defaultStreamingProviderName,
  orukeetDetectedLanguageFields,
  resolveManagedOrukeetRoute,
  resolveStreamingProviderName,
  buildStreamingSessionOptions,
  isCloudMeteredStream,
  evaluateOrukeetLanguageRouting,
  hasOrukeetExperiment,
  ORUKEET_EXPERIMENT_CONFIG_TTL_MS,
} from "./dictationStreamingRouting";

const REASONING_CACHE_TTL = 30000; // 30 seconds
// A server-side rollout change (a provider switched on or rolled back) must
// reach a long-running app without a restart.
const STT_CONFIG_TTL_MS = 15 * 60 * 1000;
const RECORDING_TIMESLICE_MS = 250; // flush chunks periodically so short recordings still carry audio frames. See #871.
// Failure detector only: fires when the worklet or audio graph is dead and never flushes.
const PREVIEW_FLUSH_WATCHDOG_MS = 1000;
const neverCancelled = () => false;
const MIN_SPARSE_RECORDING_DURATION_SECONDS = 3;
const MIN_UNIQUE_WORD_GAIN = 2;
// The target-app probe gives up after 700 ms (selectionManager), so a frozen
// target is known long before transcription ends; this only bounds a lost reply.
const RECORDING_TARGET_WAIT_MS = 1000;
// Begun when the recording started, so its reply is in long before the
// dictation is; this only bounds a lost one. A trace without a run saves no steps.
const STEP_HISTORY_RUN_WAIT_MS = 250;

// Asks main to begin a step-history run: main captures who owns this
// dictation's steps now, and checks it again when the dictation is saved.
// `{ transcriptionId }` begins a re-sent failed dictation's run on its row.
// Resolves the run id, or null without one (no bridge, or an older main).
function requestStepHistoryRun(options) {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  const request = api?.beginStepHistoryRun
    ? options
      ? api.beginStepHistoryRun(options)
      : api.beginStepHistoryRun()
    : undefined;
  if (!request) return Promise.resolve(null);
  return Promise.resolve(request)
    .then((reply) => (typeof reply?.runId === "string" ? reply.runId : null))
    .catch(() => null);
}

async function settleStepHistoryRun(pending) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), STEP_HISTORY_RUN_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Teammates' shared words (#2855) in a keyterm list: every personal word, then
// at most MAX_SHARED_KEYTERMS shared words while the whole list stays inside
// the keyterm providers' limits (AssemblyAI takes at most 100 keyterms of at
// most 50 characters each; Deepgram refuses keyterms past 500 tokens, which
// ~1,000 characters of rare names and jargon stays inside), as snippets'
// getKeytermDictionaryWords bounds them.
const KEYTERM_SHARED_LIMITS = Object.freeze({
  sharedWords: MAX_SHARED_KEYTERMS,
  maxTerms: 100,
  totalChars: 1000,
  maxWordLength: 50,
});

// The user's own dictionary words that apply (#2855): all of them, except a
// moved word whose every shared copy the member hid (suppressedPersonal), as
// snippets' hint tiers read them.
function personalDictionaryWords(settings) {
  return getEffectiveDictionaryWords({
    customDictionary: settings?.customDictionary,
    sharedDictionaryHints: {
      space: [],
      workspace: [],
      suppressedPersonal: settings?.sharedDictionaryHints?.suppressedPersonal,
    },
  });
}

// The terms a provider splits a prompt entry into: a personal entry may hold
// commas (dictionaryPromptCap's term count).
const promptTermCount = (word) => word.split(/[,\r\n]+/).filter((term) => term.trim()).length || 1;

// Adds teammates' shared words (#2855; space words, then workspace words) to
// the user's own hint plan as its lowest priority. They only fill what the
// user's own words leave of the request's budget (`maxChars`, `maxTerms`),
// never when the user's own list was already cut, and stay inside the shared
// limits: `sharedChars` bounds the list's length once shared words join it (a
// Whisper decoder never reads past its window), `sharedWords` the shared words,
// `totalTerms` and `totalChars` the whole list, and a shared word longer than
// `maxWordLength` is skipped. Otherwise the first shared word that doesn't fit
// ends the fill, so priority holds. A tail prompt opens with them (workspace,
// space, then the user's own words, where the decoder reads); a head-order list
// ends with them. `personalPrompt` is the plan's own prompt.
function withSharedHints(plan, [space = [], workspace = []], limits = {}) {
  const {
    sharedChars = Infinity,
    sharedWords = MAX_SHARED_KEYTERMS,
    totalTerms = Infinity,
    totalChars = Infinity,
    maxTerms = Infinity,
    maxWordLength = Infinity,
  } = limits;
  const fill = { space: [], workspace: [] };
  if (!plan.truncated) {
    const seen = new Set(plan.entries.map((entry) => dictionaryWordKey(entry.term)));
    let length = plan.prompt?.length ?? 0;
    let count = plan.terms.length;
    let terms = plan.terms.reduce((sum, term) => sum + promptTermCount(term), 0);
    let chars = plan.terms.reduce((sum, term) => sum + term.length, 0);
    let added = 0;
    filling: for (const [tier, words] of [
      ["space", space],
      ["workspace", workspace],
    ]) {
      for (const word of words) {
        if (typeof word !== "string") continue;
        const term = word.trim();
        const key = dictionaryWordKey(term);
        if (!key || seen.has(key) || term.length > maxWordLength) continue;
        const next = length + term.length + (count > 0 ? 2 : 0);
        const nextTerms = terms + promptTermCount(term);
        if (
          next > plan.maxChars ||
          next > sharedChars ||
          count >= maxTerms ||
          added >= sharedWords ||
          nextTerms > totalTerms ||
          chars + term.length > totalChars
        ) {
          break filling;
        }
        seen.add(key);
        fill[tier].push(term);
        length = next;
        count++;
        terms = nextTerms;
        chars += term.length;
        added++;
      }
    }
  }
  const sharedTerms = [...fill.space, ...fill.workspace];
  if (sharedTerms.length === 0) return { ...plan, personalPrompt: plan.prompt, sharedTerms };
  const terms =
    plan.order === "tail"
      ? [...fill.workspace, ...fill.space, ...plan.terms]
      : [...plan.terms, ...sharedTerms];
  return { ...plan, prompt: terms.join(", "), terms, personalPrompt: plan.prompt, sharedTerms };
}

// Same guard processTranscriptionCore has always used: node test harnesses
// run without localStorage.
const currentAgentName = () =>
  typeof window !== "undefined" && window.localStorage ? getAgentName() : "OpenWhispr";

// A selection edit that fails leaves its transcript behind; it rides out on the
// error so the failed history entry keeps it. Only those errors carry it: they
// are created per dictation, while others can be one cached rejection shared by
// every dictation. Non-enumerable, so a logged error never writes the text out.
const attachTranscript = (error, transcript, clientTranscriptionId) => {
  if (!error?.selectionEditFatal || error.transcript !== undefined) return;
  const text = typeof transcript === "string" ? transcript.trim() : "";
  if (!text) return;
  Object.defineProperty(error, "transcript", { value: text, configurable: true });
  if (clientTranscriptionId) {
    Object.defineProperty(error, "transcriptClientId", {
      value: clientTranscriptionId,
      configurable: true,
    });
  }
};

const cleanupFailureFromError = (error) => ({
  message: error?.message || String(error),
  ...(error?.messageKey ? { messageKey: error.messageKey } : {}),
  ...(error?.messageParams ? { messageParams: error.messageParams } : {}),
  ...(error?.surface ? { surface: error.surface } : {}),
  ...(error?.settingsTarget ? { settingsTarget: error.settingsTarget } : {}),
  ...(error?.action ? { action: error.action } : {}),
  ...(error?.actionKey ? { actionKey: error.actionKey } : {}),
  ...(error?.copyCommand ? { copyCommand: error.copyCommand } : {}),
  ...(error?.technicalDetails ? { technicalDetails: error.technicalDetails } : {}),
});

const cloudSignInRequiredError = () => {
  const err = new Error(
    "OpenWhispr Cloud requires sign-in. Please sign in again or switch to BYOK mode."
  );
  err.code = "AUTH_REQUIRED";
  err.messageKey = "hooks.audioRecording.errorDescriptions.sessionExpired";
  return err;
};

const micDeviceKey = (settings) =>
  `${settings.microphoneSelectionMode}|${settings.selectedMicDeviceId}`;

// A recording's length in ms from its metadata, or null when unknown.
const durationMsOf = (metadata) =>
  Number.isFinite(metadata?.durationSeconds) ? Math.round(metadata.durationSeconds * 1000) : null;

const round4 = (value) => (Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null);

// What the speech gate measured of an empty dictation, when it measured it.
function speechGateMetrics(decision) {
  if (!Number.isFinite(decision?.peakRms)) return {};
  return {
    gateReason: decision.reason,
    peakRms: round4(decision.peakRms),
    peakAmplitude: round4(decision.peakAmplitude),
    speechWindowCount: decision.speechWindowCount,
    maxConsecutiveSpeechWindows: decision.maxConsecutiveSpeechWindows,
  };
}

function getEffectiveRetentionPreferences() {
  const settings = getSettings();
  const policyState = usePolicyStore.getState();
  return {
    dataRetentionEnabled: effectiveLocalHistoryEnabled(policyState, settings.dataRetentionEnabled),
    audioRetentionDays: effectiveAudioRetentionDays(policyState, settings.audioRetentionDays),
  };
}

// Recording quality (Settings › Storage › Recordings), read once when a
// recording session starts: a change mid-recording applies to the next one.
const currentRecordingQuality = () => normalizeRecordingQuality(getSettings()?.recordingQuality);

// Every dictation recorder (pre-roll, batch, microphone recovery, streaming
// fallback) is built here, at its session's quality. Original passes no
// options, so Chromium encodes exactly as it always has.
function createDictationRecorder(stream, quality) {
  const options = recorderOptionsFor(quality);
  return options ? new MediaRecorder(stream, options) : new MediaRecorder(stream);
}

// Insights sync is opt-in, so nothing analytics-only may ride along on a cloud
// request until the user has enabled it. History retention gates it too: the
// local write below the same gate is skipped, and the cloud must not keep rows
// the device never recorded. Managed workspaces that forbid cloud backup forbid
// these counters with it — they are user data leaving the device like any other.
function analyticsSyncEnabled(settings = getSettings()) {
  return (
    settings.isSignedIn &&
    settings.insightsSyncEnabled &&
    isCloudBackupAllowed(usePolicyStore.getState()) &&
    getEffectiveRetentionPreferences().dataRetentionEnabled
  );
}

// Shared by the agent route and its text-only retry, which needs the prompt
// without the screen-context suffix.
function dictationAgentPrompt(settings, agentName) {
  return resolvePrompt("dictationAgent", {
    agentName,
    language: settings.preferredLanguage,
    customDictionary: getLlmDictionaryWords(settings, { includeTriggers: true }),
    uiLanguage: settings.uiLanguage,
  });
}

function dictationAgentReachable(settings) {
  return resolveDictationAgentInference(settings, { isCloudAgent: isCloudDictationAgentMode() })
    .reachable;
}

function translationChainReachable(settings) {
  return resolveDictationTranslationInference(settings, {
    isCloudTranslation: isCloudTranslationMode(),
  }).reachable;
}

// A scope sends to Copilot only in providers mode (the model slot is shared
// with local mode) and with a model picked.
function sendsToCopilot(config) {
  return (
    config?.mode === "providers" &&
    config.provider === COPILOT_PROVIDER_ID &&
    !!config.model?.trim()
  );
}

// Whether a dictation starting now can make a request to GitHub Copilot, read
// with the resolvers the pipeline routes with. A guess: the wake word can
// still route a dictation to the assistant, and a wrong guess only keeps the
// runtime up for its idle time. Never the voice assistant, which Copilot
// refuses.
function copilotPrewarmWanted(
  settings,
  { voiceAgentRequested = false, translationRequested = false, style = null } = {}
) {
  if (voiceAgentRequested) return false;
  const cleanupOnCopilot = sendsToCopilot(selectResolvedLLMConfig(settings, "dictationCleanup"));
  if (translationRequested) {
    const translation = resolveDictationTranslationInference(settings, {
      isCloudTranslation: isCloudTranslationMode(),
    });
    if (translation.reachable && translation.config?.provider === COPILOT_PROVIDER_ID) return true;
    // The chain's cleanup step.
    return !!settings.useCleanupModel && cleanupOnCopilot;
  }
  if (!cleanupOnCopilot) return false;
  // A style runs on cleanup's model even with cleanup off.
  return !!settings.useCleanupModel || (!!style && isStyleReachable(settings));
}

function isAgentScopeBlocked(settings) {
  return (
    !!settings.useDictationAgent && !!settings.policyBlockedLocalScopes?.includes("dictationAgent")
  );
}

function resolveReasoningRoute(
  text,
  settings,
  agentName,
  voiceAgentRequested,
  translationRequested,
  screenContext,
  detectedLanguage
) {
  const wakeWordLanguage = resolveWakeWordLanguage(settings, detectedLanguage, text);
  const cleanup = selectResolvedLLMConfig(settings, "dictationCleanup");
  const cleanupReachable =
    !!settings.useCleanupModel && (!!cleanup.model?.trim() || isCloudCleanupMode());
  const agent = resolveDictationAgentInference(settings, {
    isCloudAgent: isCloudDictationAgentMode(),
  });

  const translation = resolveDictationTranslationInference(settings, {
    isCloudTranslation: isCloudTranslationMode(),
  });

  const kind = resolveDictationRouteKind({
    cleanupReachable,
    // A blocked assistant still takes its own commands, and refuses them by name
    // in the agent window: one never falls back to cleanup and gets pasted as text.
    agentReachable: agent.reachable || isAgentScopeBlocked(settings),
    // A translation recording ignores the wake word, so skip the scan.
    agentInvoked:
      !translationRequested &&
      !!agentName &&
      detectAgentName(text, agentName, wakeWordLanguage, settings.snippets),
    voiceAgentRequested,
    translationRequested,
    translationReachable: translation.reachable,
  });
  logger.logReasoning("ROUTE_RESOLVED", {
    kind,
    voiceAgentRequested,
    agentReachable: agent.reachable,
    agentMode: settings.dictationAgentMode,
    agentProvider: agent.displayProvider,
    agentModel: agent.model,
    hasScreenContext: !!screenContext,
  });
  if (translationRequested && kind !== "translation") {
    logger.warn(
      "Translation requested but unreachable, falling back",
      {
        kind,
        useDictationTranslation: settings.useDictationTranslation,
        hasTarget: !!settings.translationTargetLanguage?.trim(),
      },
      "transcription"
    );
  }
  // Shared by ordinary cleanup and the translation chain's cleanup step (and by
  // Prompt Studio's tests, so they send what a dictation would). It carries the
  // cleanup scope's reasoning effort (#2694).
  const cleanupConfig = buildDictationCleanupConfig(settings);
  if (kind === "translation") {
    return {
      kind: "translation",
      model: translation.model,
      cleanupReachable,
      cleanupConfig,
      config: {
        ...translation.config,
        systemPrompt: resolvePrompt("translate", {
          agentName,
          targetLanguageLabel: getLanguageLabel(settings.translationTargetLanguage),
          customDictionary: getLlmDictionaryWords(settings, { includeTriggers: true }),
          uiLanguage: settings.uiLanguage,
        }),
      },
    };
  }
  if (kind === "agent") {
    const vision = resolveDictationAgentVisionInference(settings, {
      isSignedIn: settings.isSignedIn,
    });
    const { attach, useVisionOverride } = resolveAgentImageTarget({
      hasScreenContext: !!screenContext,
      visionOverrideActive: vision.active,
      visionProviderImageWired: providerSupportsImages(vision.config.provider),
      baseProviderImageWired: providerSupportsImages(agent.config.provider),
      isCloudAgent: isCloudDictationAgentMode(),
      baseModelSupportsVision: !!getCloudModel(agent.model, agent.config.provider)?.supportsVision,
    });
    const target = useVisionOverride ? vision : agent;
    logger.logReasoning("AGENT_IMAGE_TARGET", {
      hasScreenContext: !!screenContext,
      visionOverrideActive: vision.active,
      attach,
      useVisionOverride,
    });

    const systemPrompt = dictationAgentPrompt(settings, agentName);

    return {
      kind: "agent",
      cleanupReachable,
      model: target.model,
      config: {
        ...target.config,
        systemPrompt: attach
          ? appendScreenContextSuffix(systemPrompt, settings.uiLanguage)
          : systemPrompt,
        ...(attach ? { screenContext, textOnlySystemPrompt: systemPrompt } : {}),
        // Selection edits run on this (dictation) scope, so they need it
        // reachable; standalone commands resolve the same scope again in the
        // agent window and report their own configuration problems there.
        selectionEditReachable: agent.reachable,
        // Detection and stripping must read the transcript identically, so both
        // inputs ride the route rather than being re-read after the await.
        wakeWordLanguage,
        snippets: settings.snippets,
        // The assistant re-decides attach/drop for its own request, so carry
        // the raw screenshot past this attach gate for that path.
        ...(screenContext ? { rawScreenContext: screenContext } : {}),
      },
    };
  }
  if (kind === "cleanup") {
    return { kind: "cleanup", cleanupReachable, config: cleanupConfig };
  }
  return { kind: "skip", cleanupReachable };
}

const PLACEHOLDER_KEYS = {
  openai: "your_openai_api_key_here",
  groq: "your_groq_api_key_here",
  xai: "your_xai_api_key_here",
  mistral: "your_mistral_api_key_here",
};

const isValidApiKey = (key, provider = "openai") => {
  if (!key || key.trim() === "") return false;
  const placeholder = PLACEHOLDER_KEYS[provider] || PLACEHOLDER_KEYS.openai;
  return key !== placeholder;
};

// Dictation won't wait out another model's answer: past this it goes in as spoken.
const DICTATION_MODEL_BUSY_WAIT_MS = 2000;

// Realtime providers expose no finalize handshake (unlike Deepgram/AssemblyAI/
// Corti), so the transcript tail lands whenever it lands — wait, don't sleep.
const STREAMING_FINAL_QUIET_MS = 250;
const STREAMING_FINAL_CEILING_MS = 2000;

// Both realtime providers share the dictation realtime IPC surface and differ
// only in the token-provider id. Forcing `provider` here (even though
// buildStreamingSessionOptions already stamps it) is pinned by
// audioManagerStreamingRouting.test.js: the hardened main-process allowlist
// fails closed on an options object that lost the tag (#1624).
const makeDictationRealtimeProvider = (id) => ({
  awaitsFinalTranscript: true,
  warmup: (opts) => window.electronAPI.dictationRealtimeWarmup({ ...opts, provider: id }),
  start: (opts) => window.electronAPI.dictationRealtimeStart({ ...opts, provider: id }),
  send: (buf) => window.electronAPI.dictationRealtimeSend(buf),
  stop: () => window.electronAPI.dictationRealtimeStop(),
  onPartial: (cb) => window.electronAPI.onDictationRealtimePartial(cb),
  onFinal: (cb) => window.electronAPI.onDictationRealtimeFinal(cb),
  onError: (cb) => window.electronAPI.onDictationRealtimeError(cb),
  onSessionEnd: (cb) => window.electronAPI.onDictationRealtimeSessionEnd(cb),
});

const STREAMING_PROVIDERS = {
  deepgram: {
    warmup: (opts) => window.electronAPI.deepgramStreamingWarmup(opts),
    start: (opts) => window.electronAPI.deepgramStreamingStart(opts),
    send: (buf) => window.electronAPI.deepgramStreamingSend(buf),
    finalize: () => window.electronAPI.deepgramStreamingFinalize(),
    stop: () => window.electronAPI.deepgramStreamingStop(),
    status: () => window.electronAPI.deepgramStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onDeepgramPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onDeepgramFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onDeepgramError(cb),
    onSessionEnd: (cb) => window.electronAPI.onDeepgramSessionEnd(cb),
  },
  assemblyai: {
    warmup: (opts) => window.electronAPI.assemblyAiStreamingWarmup(opts),
    start: (opts) => window.electronAPI.assemblyAiStreamingStart(opts),
    send: (buf) => window.electronAPI.assemblyAiStreamingSend(buf),
    finalize: () => window.electronAPI.assemblyAiStreamingForceEndpoint(),
    stop: () => window.electronAPI.assemblyAiStreamingStop(),
    status: () => window.electronAPI.assemblyAiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onAssemblyAiPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onAssemblyAiFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onAssemblyAiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onAssemblyAiSessionEnd(cb),
  },
  "openai-realtime": makeDictationRealtimeProvider("openai-realtime"),
  orukeet: {
    ...makeDictationRealtimeProvider("orukeet"),
    finalizeAcknowledged: true,
    finalize: () => window.electronAPI.dictationRealtimeFinalize(),
  },
  gemini: {
    // The final transcript lands ~500ms after audioStreamEnd (which finalize
    // sends), ~2s at the p95 tail, so the stop sequence waits for it under a
    // wider ceiling. geminiLiveStreaming.js measures the same 3s budget from
    // audioStreamEnd before its own disconnect gives up.
    awaitsFinalTranscript: true,
    finalCeilingMs: 3000,
    // Its stop result supersedes the streamed finals: it also carries a last
    // turn the server never finalized.
    preferStopTranscript: true,
    warmup: (opts) => window.electronAPI.geminiStreamingWarmup(opts),
    start: (opts) => window.electronAPI.geminiStreamingStart(opts),
    send: (buf) => window.electronAPI.geminiStreamingSend(buf),
    finalize: () => window.electronAPI.geminiStreamingFinalize(),
    stop: () => window.electronAPI.geminiStreamingStop(),
    status: () => window.electronAPI.geminiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onGeminiPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onGeminiFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onGeminiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onGeminiSessionEnd(cb),
  },
  corti: {
    warmup: (opts) => window.electronAPI.cortiStreamingWarmup(opts),
    start: (opts) => window.electronAPI.cortiStreamingStart(opts),
    send: (buf) => window.electronAPI.cortiStreamingSend(buf),
    finalize: () => window.electronAPI.cortiStreamingFinalize(),
    stop: () => window.electronAPI.cortiStreamingStop(),
    status: () => window.electronAPI.cortiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onCortiPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onCortiFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onCortiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onCortiSessionEnd(cb),
  },
  "tinfoil-realtime": makeDictationRealtimeProvider("tinfoil-realtime"),
};

// Batch providers that must transcribe via a main-process proxy (CORS,
// non-Bearer auth, OAuth, or attested transport) instead of a renderer fetch.
function audioExtensionForMime(mimeType) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

// Workspace-managed Azure STT: the Entra token lives in the main process, so
// dictation dispatches over IPC exactly like the proxied providers below.
const MANAGED_TRANSCRIPTION_SPEC = {
  displayName: "Managed Azure",
  ipc: () => window.electronAPI?.managedTranscribe,
  buildPayload: ({ audioBuffer, language, dictionaryPrompt, managedResolution, mimeType }) => ({
    audioBuffer,
    fileName: `audio.${audioExtensionForMime(mimeType)}`,
    mimeType,
    language,
    prompt: dictionaryPrompt || undefined,
    managed: { provider: managedResolution.provider, context: managedResolution.context },
  }),
};

// `echoPrompt` gives the dictionary in the order the payload carries it, for
// the trailing-echo strip; without one it's the Whisper-order `prompt`.
const PROXY_TRANSCRIPTION_PROVIDERS = {
  tinfoil: {
    displayName: "Tinfoil",
    ipc: () => window.electronAPI?.proxyTinfoilTranscription,
    buildPayload: ({ audioBuffer, language, dictionaryPrompt }) => ({
      audioBuffer,
      language,
      prompt: dictionaryPrompt || undefined,
    }),
  },
  mistral: {
    displayName: "Mistral",
    ipc: () => window.electronAPI?.proxyMistralTranscription,
    // contextBias keeps the HEAD of the list, so it reads the prompt in priority
    // order (personal words first), not the Whisper order that ends with them.
    buildPayload: ({ audioBuffer, model, language, priorityDictionaryPrompt }) => {
      const payload = { audioBuffer, model, language };
      const tokens = (priorityDictionaryPrompt || "")
        .split(",")
        .flatMap((entry) => entry.trim().split(/\s+/))
        .filter(Boolean)
        .slice(0, 100);
      if (tokens.length > 0) payload.contextBias = tokens;
      return payload;
    },
    echoPrompt: ({ priorityDictionaryPrompt }) => priorityDictionaryPrompt,
  },
  gemini: {
    displayName: "Gemini",
    ipc: () => window.electronAPI?.proxyGeminiTranscription,
    buildPayload: ({ audioBuffer, model, language, keyterms }) => ({
      audioBuffer,
      model,
      language,
      keyterms: keyterms.length > 0 ? keyterms : undefined,
    }),
    echoPrompt: ({ keyterms }) => keyterms.join(", "),
  },
  xai: {
    displayName: "xAI",
    ipc: () => window.electronAPI?.proxyXaiTranscription,
    buildPayload: ({ audioBuffer, language, keyterms }) => {
      const payload = { audioBuffer, language: language !== "auto" ? language : undefined };
      if (keyterms.length > 0) payload.keyterms = keyterms;
      return payload;
    },
    echoPrompt: ({ keyterms }) => keyterms.join(", "),
  },
  corti: {
    displayName: "Corti",
    ipc: () => window.electronAPI?.proxyCortiTranscription,
    buildPayload: ({ audioBuffer, language, apiSettings }) => ({
      audioBuffer,
      // Corti requires a concrete primaryLanguage; default to English when auto-detecting
      language: language || "en",
      environment: apiSettings.cortiEnvironment || "us",
      tenant: (apiSettings.cortiTenant || "").trim() || "base",
    }),
  },
};

// Selection-edit copy for a failed reply, looked up by the cause's messageKey,
// then by its code.
const SELECTION_EDIT_FAILURE_COPY = {
  SELECTION_EDIT_INVALID_RESPONSE: "invalidResponse",
  OUTPUT_COMPLETION_UNVERIFIED: "invalidResponse",
  SELECTION_EDIT_EMPTY_RESPONSE: "emptyResponse",
  [EMPTY_OUTPUT_MESSAGE_KEY]: "emptyResponse",
  [TRUNCATED_OUTPUT_MESSAGE_KEY]: "truncatedResponse",
};

// A local model the app does not know is a setup problem, never a reason to send a
// local-mode user's audio to a cloud provider.
const isUnknownLocalModelError = (error) =>
  /Invalid (model name|Parakeet model):/.test(error?.message ?? "");

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.micCaptureStatus = "inactive";
    this.cachedApiKey = null;
    this.cachedApiKeyProvider = null;
    this._micWarmedAt = 0;
    this._startInProgress = false;
    this._micOpenReported = false;
    this.preparedMicCapture = new PreparedMicCapture({
      dispose: (prepared) => this._disposePrepared(prepared),
      onActiveChange: () => {
        this._syncMicOpenGate();
        this.onStateChange?.(this.getState());
      },
    });
    const micSettings = getSettings();
    this._micHoldSeconds = Number(micSettings.micWarmHoldSeconds) || 0;
    this._micDeviceKey = micDeviceKey(micSettings);
    this.micStreamHold = new MicStreamHold({
      holdSeconds: this._micHoldSeconds,
      onHoldChange: () => this._syncMicOpenGate(),
      isBusy: () =>
        this.isRecording ||
        this.isStreaming ||
        this.mediaRecorder?.state === "recording" ||
        this.preparedMicCapture.active,
    });

    // Every window owns an AudioManager (dictation and the agent overlay), so
    // the hold has to follow the setting here rather than in one window's hook.
    this._unsubscribeSettings = useSettingsStore.subscribe((state) => {
      const holdSeconds = Number(state.micWarmHoldSeconds) || 0;
      if (holdSeconds !== this._micHoldSeconds) {
        this._micHoldSeconds = holdSeconds;
        this.micStreamHold.setHoldSeconds(holdSeconds);
      }
      const deviceKey = micDeviceKey(state);
      if (deviceKey !== this._micDeviceKey) {
        this._micDeviceKey = deviceKey;
        this.cachedMicDeviceId = null;
        this.rejectedMicDeviceId = null;
        this._micWarmedAt = 0;
        this.cancelPreparedMicCapture();
        this.micStreamHold.drop();
      }
    });

    this._onApiKeyChanged = () => {
      this.cachedApiKey = null;
      this.cachedApiKeyProvider = null;
      // Replace a socket warmed with the previous key now rather than at the next
      // start. A key save in Settings is no reason to open the mic.
      if (!this.isRecording && !this.isProcessing && this.shouldUseStreaming()) {
        this.warmupStreamingConnection({ warmMic: false });
      }
    };
    window.addEventListener("api-key-changed", this._onApiKeyChanged);

    // Invalidate the pinned mic device when the OS adds/removes/suspends inputs.
    // Otherwise wake-after-idle keeps requesting a stale deviceId that yields silence.
    this._onDeviceChange = () => {
      this.cachedMicDeviceId = null;
      this._micWarmedAt = 0;
      this.rejectedMicDeviceId = null;
      this.cancelPreparedMicCapture();
      this.micStreamHold.drop();
      // The main process keeps the OS default mic until told it changed, so
      // re-resolve now, or the next hotkey press would pin the old default.
      window.electronAPI?.getSystemDefaultMicrophone?.({ refresh: true })?.catch(() => {});
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", this._onDeviceChange);
    this.recordingStartTime = null;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;
    this.isStreaming = false;
    this.streamingAudioContext = null;
    this.streamingSource = null;
    this.streamingAnalyser = null;
    this.streamingProcessor = null;
    this.streamingStream = null;
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextBump = null;
    this.streamingTextDebounce = null;
    this.cachedMicDeviceId = null;
    this.rejectedMicDeviceId = null;
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;
    this.workletBlobUrl = null;
    this.streamingStartInProgress = false;
    this._streamingStartSettlementWaiters = [];
    this.stopRequestedDuringStreamingStart = false;
    this._streamingStopPromise = null;
    this._streamingStopMode = null;
    this._streamingSessionGeneration = 0;
    this._streamingCancellationGeneration = 0;
    this._activeTranscriptionAbortController = null;
    this._activeStreamingSessionId = null;
    this._streamingMeteredByCloud = false;
    this._activeStreamingProviderName = null;
    this._activeStreamingConfig = null;
    this._activePipelineOptions = undefined;
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this._recordingSpool = null;
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.translationApplied = false;
    // The style this recording carries, frozen when it started (null = Plain).
    this.recordingStyle = null;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    this._shownCleanupSetupKey = null;
    this._processingCancellationGeneration = 0;
    this._activeProcessingPipeline = null;
    this.screenContextPromise = null;
    this.toneStylePromise = null;
    this.lastToneAppCategory = null;
    this.toneStyleStartDeadline = 0;
    this.selectionCapturePromise = null;
    this.recordingTargetPromise = null;
    this.stepHistoryRunPromise = null;
    this.sttConfig = null;
    this.sttConfigFetchedAt = null;
    this.streamingFallbackReason = null;
    this._streamingFailoverReason = null;
    this._streamingSpeechGateState = null;
    this.warmupFailureStreak = 0;
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this._localSpeechGateState = null;
    this._streamingCommitActive = false;
    this._previewFlushResolve = null;
    this._batchSegments = [];
    this._batchPcmTap = null;
    this._rotatingBatchRecorder = null;
    this._rotationResolve = null;
    this._stopRequestedDuringMicRecovery = false;
    this._cancelRequestedDuringMicRecovery = false;
    this._streamingFallbackSegments = [];
    this._streamingMicSwapPromise = null;
    // The current recording session's quality (frozen when it starts).
    this._recordingQuality = DEFAULT_RECORDING_QUALITY;
    this.micRecovery = new ActiveMicRecoveryController({
      mediaDevices: navigator.mediaDevices,
      // Recovery waits for the default-mic lookup; a dictation's start and warm-up don't (#2765).
      acquire: async (reason) => {
        try {
          const constraints = await this.getAudioConstraints(
            false,
            reason === "devicechange" || reason === "devicechange-ended",
            true
          );
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
          logger.debug(
            "Preferred mic unavailable during recovery, falling back to default",
            { error: error.message },
            "audio"
          );
          const fallback = await this.getAudioConstraints(true, false, true);
          return navigator.mediaDevices.getUserMedia(fallback);
        }
      },
      onRecovered: (replacement, previous) => this.replaceActiveMic(replacement, previous),
      onStatusChange: (status) => this.setMicCaptureStatus(status),
    });
  }

  // A recording's chunks are spooled until its result is saved, so a hung or
  // crashed app can hand the audio back on the next launch (#2073). Recovered
  // audio lands in history, so spool none the user wouldn't keep.
  _startRecordingSpool() {
    const { dataRetentionEnabled, audioRetentionDays } = getEffectiveRetentionPreferences();
    if (!dataRetentionEnabled || audioRetentionDays <= 0) return null;
    return startRecordingSpool(this.getRecordingRouteKind(), {
      recordingQuality: this._recordingQuality,
    });
  }

  // A styled recording is its own intent, like translation: assistant and
  // translation recordings never carry one.
  getActiveRecordingStyle() {
    if (this.voiceAgentRequested || this.translationRequested) return null;
    return this.recordingStyle || null;
  }

  // History's route_kind for this recording: "translation", "style:<id>" or null.
  getRecordingRouteKind() {
    if (this.translationRequested) return "translation";
    return styleRouteKind(this.getActiveRecordingStyle()?.id);
  }

  // Frozen for the recording: set once when it starts, cleared by a cancel.
  // A second press while holding or processing never starts a new recording,
  // so it never reaches this.
  setRecordingStyle(style) {
    this.recordingStyle =
      style && typeof style.id === "string" ? Object.freeze({ ...style }) : null;
  }

  _takeRecordingSpool() {
    const spool = this._recordingSpool;
    this._recordingSpool = null;
    return spool;
  }

  getWorkletBlobUrl() {
    if (this.workletBlobUrl) return this.workletBlobUrl;
    const code = `
const BUFFER_SIZE = 800;
class PCMStreamingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this.port.postMessage(partial.buffer, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
        }
        this.port.postMessage("flushed");
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-streaming-processor", PCMStreamingProcessor);
`;
    this.workletBlobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return this.workletBlobUrl;
  }

  // The speech-to-text hint list. One builder (utils/dictionaryHints) for the
  // user's own words, read by the request, the echo check and the Dictionary
  // page: pinned words in pin order, manual entries, then the glossary's
  // canonical forms, then snippet triggers, then auto-learned entries, within
  // the request budget and in the order the model reads. The manual and learned
  // tiers follow the order setting: by evidence (the usage store's scores,
  // while it has counts; bounded exactly as Re-transcribe's dictionary block
  // carries them) or as added. Teammates' shared words (#2855) follow as the
  // lowest priority, in what the user's own words leave (withSharedHints):
  // `shared` gives the request's shared limits, by default those of a prompt
  // with no provider limit (OpenWhispr Cloud's routes, local engines, the
  // proxied providers): shared words only fill the Whisper decoder's window
  // beside the script bias, at most PROMPT_HEAD_TERMS terms in all, since past
  // the window a decoder never reads them and the Cloud API's Groq and Gemini
  // routes keep the HEAD of an over-long prompt, which opens with shared words.
  // `personalPrompt` is the user's own part, which echo checks also read alone.
  getDictionaryHints({
    settings = getSettings(),
    maxChars,
    maxTerms,
    order,
    includeSnippets,
    shared,
  } = {}) {
    const words = personalDictionaryWords(settings);
    const plan = buildDictionaryHints({
      dictionary: words,
      learnedWords: getLearnedDictionaryWords(),
      pinnedWords: getPinnedDictionaryKeys(),
      glossaryTerms: getGlossaryCanonicalTerms(),
      snippets: settings?.snippets,
      includeSnippets,
      maxChars,
      maxTerms,
      order,
      rankBy: normalizeDictionaryHintOrder(settings?.dictionaryHintOrder),
      scores: normalizeHintScores(
        hintScoresForDictionary(getDictionaryHintScores(), words),
        words.length
      ),
    });
    const [, space, workspace] = getDictionaryHintTiers(settings);
    return withSharedHints(
      plan,
      [space, workspace],
      shared ?? {
        sharedChars: WHISPER_DECODER_PROMPT_CHARS - this.getScriptBiasReserve(settings),
        sharedWords: MAX_SHARED_KEYTERMS,
        totalTerms: PROMPT_HEAD_TERMS,
        maxTerms,
      }
    );
  }

  // Unbudgeted and in Whisper's tail order unless a request says otherwise.
  getCustomDictionaryPrompt(options = {}) {
    return this.getDictionaryHints(options).prompt;
  }

  // The user's own part of getCustomDictionaryPrompt(), without teammates'
  // words, for echo checks.
  getPersonalDictionaryPrompt(settings = getSettings()) {
    return this.getDictionaryHints({ settings }).personalPrompt;
  }

  // The Chinese script bias leads the prompt (mergeWhisperPrompt); a budgeted
  // request leaves room for it before choosing terms, so a trim never drops
  // the tail entries Whisper reads.
  getScriptBiasReserve(settings = getSettings()) {
    const bias = mergeWhisperPrompt(
      null,
      resolveChineseScriptTarget(
        this.getEffectiveSttLanguage(settings),
        settings.chineseScriptPreference
      )
    );
    return bias ? bias.length + 1 : 0;
  }

  // The exact prompt a budgeted request sends, its dictionary part and the
  // user's own part of that, which the echo check compares against. Shared
  // words get the same limits as on every other STT path: at most
  // MAX_SHARED_KEYTERMS, and on a Whisper decoder only what it reads
  // (sharedDictionaryPromptChars); `shared` adds a route's own (Cloud's term cap).
  getSttHintPrompt(
    settings = getSettings(),
    { maxChars = Infinity, order = "tail", shared = {} } = {}
  ) {
    const reserve = this.getScriptBiasReserve(settings);
    const hints = this.getDictionaryHints({
      settings,
      maxChars: maxChars - reserve,
      order,
      shared: {
        sharedChars: sharedDictionaryPromptChars(maxChars) - reserve,
        sharedWords: MAX_SHARED_KEYTERMS,
        ...shared,
      },
    });
    return {
      dictionaryPrompt: hints.prompt,
      personalPrompt: hints.personalPrompt,
      prompt: this.getWhisperPrompt(settings, hints.prompt),
    };
  }

  // Script conversion targets whatever the user ends up pasting: the translation
  // target when translating, otherwise the dictation language. Using the STT
  // language here would force zh-TW source audio back to Traditional even when
  // the user asked to translate into Simplified.
  //
  // Only a completed translate step actually moves text into the target language.
  // When translation is unreachable, skipped or fails, the source transcript is
  // what gets pasted, so it must be scripted as the STT language — otherwise a
  // failed ja → zh-CN run would run Japanese through OpenCC (会議の資料 → 会议の数据).
  getEffectiveOutputLanguage(settings) {
    if (this.translationRequested && this.translationApplied) {
      return settings.translationTargetLanguage || "auto";
    }
    return this.getEffectiveSttLanguage(settings);
  }

  // Whisper only accepts language "zh"; script (简体/繁體) is applied here. See #975.
  // No transcript exists yet, so only an explicit zh-CN/zh-TW may bias the prompt.
  getWhisperPrompt(
    settings = getSettings(),
    dictionaryPrompt = this.getCustomDictionaryPrompt({ settings })
  ) {
    return mergeWhisperPrompt(
      dictionaryPrompt,
      resolveChineseScriptTarget(
        this.getEffectiveSttLanguage(settings),
        settings.chineseScriptPreference
      )
    );
  }

  // Cleanup runs before the translate step, so it still works in the STT language.
  getCleanupLanguage(settings) {
    return resolveCleanupLanguage(this.getEffectiveSttLanguage(settings));
  }

  finalizeChineseScript(text, settings = getSettings()) {
    // A selection edit has already applied its explicit language instruction.
    // A dictation-wide script preference must not rewrite that document again.
    if (this.pendingSelectionEdit) return text;
    return applyChineseScript(
      text,
      resolveChineseScriptTarget(
        this.getEffectiveOutputLanguage(settings),
        settings.chineseScriptPreference,
        text
      )
    );
  }

  // Check the dictionary on its own as well as the full prompt: the echo filter needs
  // 70% of the prompt's words to appear, and a Chinese script bias counts as one more
  // word, which alone pushes a one- or two-term dictionary under the threshold.
  // A budgeted request passes the dictionary it actually sent (and its user's
  // own part, getSttHintPrompt): an echo of a capped prompt only clears the 70%
  // bar measured against that same capped list. Shared words dilute that share
  // the same way, so when the prompt carried any, an echo of the user's own
  // words is checked on its own too, as it was before shared words existed.
  isDictionaryEcho(text, dictionaryPrompt, personalPrompt) {
    if (dictionaryPrompt === undefined) {
      dictionaryPrompt = this.getCustomDictionaryPrompt();
      personalPrompt = this.getPersonalDictionaryPrompt();
    }
    const settings = getSettings();
    const prompts = [dictionaryPrompt];
    if (personalPrompt && personalPrompt !== dictionaryPrompt) prompts.push(personalPrompt);
    return prompts.some(
      (prompt) =>
        matchesDictionaryPrompt(text, prompt) ||
        matchesDictionaryPrompt(text, this.getWhisperPrompt(settings, prompt))
    );
  }

  // Drops a hint list the model recited after the speech (#2581). Pass the
  // prompt the request actually carried: a capped prompt can only echo itself.
  // Snippet triggers beside the dictionary never start or count toward a recital;
  // the glossary's canonical forms ride in the list like dictionary words.
  stripTrailingDictionaryEcho(text, sentPrompt) {
    const stripped = stripTrailingDictionaryEcho(text, sentPrompt, [
      ...this.getCustomDictionaryArray(),
      ...getGlossaryCanonicalTerms(),
    ]);
    if (stripped !== text) {
      logger.debug(
        "Stripped trailing dictionary echo",
        { originalLength: text.length, strippedLength: stripped.length },
        "transcription"
      );
    }
    return stripped;
  }

  setCallbacks({
    onStateChange,
    onError,
    // Optional: the agent overlay has no dictation toast surface.
    onNoAudio = undefined,
    onTranscriptionComplete,
    onPartialTranscript,
    onStreamingCommit,
    onTranslationFallback,
    onStyleFallback,
  }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onNoAudio = onNoAudio;
    this.onTranscriptionComplete = onTranscriptionComplete;
    this.onPartialTranscript = onPartialTranscript;
    this.onStreamingCommit = onStreamingCommit;
    this.onTranslationFallback = onTranslationFallback;
    this.onStyleFallback = onStyleFallback;
  }

  // Fail-open: translation degraded/failed but raw text is still pasted. Surface why.
  notifyTranslationFallback(reason) {
    this.onTranslationFallback?.({ reason });
  }

  // The style didn't apply: "failed" pastes the cleaned text, "unreachable"
  // (no model for the cleanup scope) the transcript. Either way, say so.
  notifyStyleFallback(style, reason) {
    this.onStyleFallback?.({
      reason,
      style: style ? { id: style.id, name: style.name, emoji: style.emoji } : null,
    });
  }

  setMicCaptureStatus(status) {
    if (this.micCaptureStatus === status) return;
    this.micCaptureStatus = status;
    this.onStateChange?.({
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      isPreparing: this.preparedMicCapture.active,
      micCaptureStatus: status,
    });
  }

  async beginMicRecovery(stream) {
    // A stop/cancel can land during the awaits between recorder start and this
    // call; never arm recovery for a recording that already ended.
    if (!this.isRecording) return;
    await this.micRecovery.start(stream, {
      followDefault: followsSystemDefaultMic(getSettings()),
    });
  }

  async replaceActiveMic(replacement, previous) {
    if (!this.isRecording) throw new Error("Recording is no longer active");
    if (this.isStreaming) {
      await this.replaceStreamingMic(replacement, previous);
    } else {
      await this.replaceBatchMic(replacement, previous);
    }
  }

  async mergeRecordedSegments(segments, quality = this._recordingQuality) {
    // Header-only segments carry no audio frames and crash FFmpeg's concat (#871).
    const usable = segments.filter((segment) => segment && !isEmptyRecording(segment.size));
    if (usable.length === 0) return null;
    if (usable.length === 1) return usable[0];
    const payload = await Promise.all(
      usable.map(async (segment) => ({
        buffer: await segment.arrayBuffer(),
        mimeType: segment.type || "audio/webm",
      }))
    );
    // Merged at the recording's own quality (main maps it to FFmpeg's bitrate).
    const result = await window.electronAPI.mergeAudioSegments(payload, {
      quality: normalizeRecordingQuality(quality),
    });
    if (!result?.success) throw new Error(result?.error || "Failed to merge audio segments");
    return new Blob([result.buffer], { type: result.mimeType });
  }

  getLargestRecordedSegment(segments) {
    return segments
      .filter((segment) => segment && !isEmptyRecording(segment.size))
      .reduce(
        (largest, segment) => (segment.size > (largest?.size || 0) ? segment : largest),
        null
      );
  }

  setVoiceAgentRequested(requested) {
    this.voiceAgentRequested = requested;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    // No recording must ever see a stale capture (e.g. left over from a
    // cancelled voice-agent recording, even after the setting was turned
    // off). A live voice-agent start re-captures right after this call.
    this.screenContextPromise = null;
    this.toneStylePromise = null;
    // Same for a prefetched selection: bounded to one recording, so a read taken
    // in an earlier app can never be edited in place by this command.
    this.selectionCapturePromise = null;
    // And for the target app: a recording that never asked for its own (the
    // agent overlay) must not inherit an earlier recording's app.
    this.recordingTargetPromise = null;
    // Nor an earlier recording's step-history run (and its owner).
    this.stepHistoryRunPromise = null;
  }

  // Begins this recording's step-history run in main (see
  // requestStepHistoryRun). Never awaited at start; postTranscribe reads it.
  beginStepHistoryRun() {
    this.stepHistoryRunPromise = requestStepHistoryRun();
  }

  // Starts the GitHub Copilot runtime and its model list while the user
  // speaks, when this dictation's cleanup or translation can run on Copilot
  // (copilotPrewarmWanted). Fire and forget: never awaited, never throws, and
  // logs nothing. Returns whether it asked main to prewarm.
  beginCopilotPrewarm(options = {}) {
    try {
      if (!copilotPrewarmWanted(getSettings(), options)) return false;
      const request = window.electronAPI?.prewarmCopilot?.();
      if (!request) return false;
      Promise.resolve(request).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  // Asks main for the target app it froze when this recording started (see
  // capture-dictation-target). Never awaited at start: the probe resolves while
  // the user speaks, and the post-transcription boundary reads it.
  beginRecordingTargetCapture() {
    const request = window.electronAPI?.getDictationTargetApp?.();
    this.recordingTargetPromise = request ? Promise.resolve(request).catch(() => null) : null;
  }

  // The recording's frozen target app (exe name), or null when unknown.
  async getRecordingTargetApp() {
    const pending = this.recordingTargetPromise;
    if (!pending) return null;
    let timer;
    try {
      const target = await Promise.race([
        pending,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), RECORDING_TARGET_WAIT_MS);
        }),
      ]);
      const exeName = typeof target?.exeName === "string" ? target.exeName.trim() : "";
      return exeName || null;
    } finally {
      clearTimeout(timer);
    }
  }

  setTranslationRequested(requested) {
    this.translationRequested = requested;
    this.translationApplied = false;
  }

  // In translation mode the STT hint is the configured source language, not
  // the UI-wide preferred language; "auto" keeps whisper auto-detection.
  getEffectiveSttLanguage(settings) {
    if (this.translationRequested) {
      return settings.translationSourceLanguage || "auto";
    }
    return settings.preferredLanguage;
  }

  // Kicked off at voice-agent recording start (so the screenshot reflects the
  // invocation moment) and consumed after transcription by the reasoning route.
  beginScreenContextCapture() {
    this.screenContextPromise = window.electronAPI?.captureScreenContext?.() ?? null;
  }

  // Kicked off at voice-agent recording start, alongside the screenshot, so the
  // read resolves while the user is still speaking.
  beginSelectionCapture() {
    this.selectionCapturePromise = window.electronAPI?.captureSelectedText?.() ?? null;
    // Marks the stored promise handled without consuming it: a failure nobody is
    // awaiting yet must not surface as an unhandled rejection, and the awaiting
    // caller must still see the original error.
    this.selectionCapturePromise?.catch(() => {});
  }

  consumeSelectionCapture() {
    const pending = this.selectionCapturePromise;
    this.selectionCapturePromise = null;
    return pending ?? window.electronAPI?.captureSelectedText?.();
  }

  async consumeScreenContext() {
    const pending = this.screenContextPromise;
    this.screenContextPromise = null;
    if (!pending) return null;
    try {
      // Capture resolves in well under a second; the race only protects the
      // paste path if the IPC ever hangs.
      const image = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!image) logger.logReasoning("SCREEN_CONTEXT_UNAVAILABLE", {});
      return image;
    } catch {
      return null;
    }
  }

  // Kicked off at dictation start while Tone & Style is on, so the target app
  // is classified while the user speaks. Only a dictation that captured its
  // app gets a tone: a retried or re-run transcription has no target.
  beginToneStyleCapture() {
    this.toneStylePromise =
      window.electronAPI?.captureDictationAppCategory?.()?.catch(() => null) ?? null;
    // An Orukeet start waits at most 250 ms from here for the app, so the wait
    // overlaps the mic opening instead of delaying the start cue after it.
    this.toneStyleStartDeadline = performance.now() + 250;
  }

  // Consumed by the cleanup route, and by an agent command's rewrite of the
  // selection. Translation keeps its source's tone.
  async consumeToneStyle() {
    const pending = this.toneStylePromise;
    this.toneStylePromise = null;
    const settings = getSettings();
    if (!pending || !settings.toneStyleEnabled) return null;
    // Classification lands while the user speaks (a Wayland AT-SPI target takes
    // about a second); the race only guards the paste path if the IPC ever
    // hangs, and an unknown app reads as other.
    const appCategory = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    const toneStyle = resolveDictationToneStyle(settings.toneStyles, appCategory);
    logger.logReasoning("TONE_STYLE", toneStyle);
    return toneStyle;
  }

  // An agent-route failure pastes the spoken command verbatim into the focused
  // app — surface that. Cleanup failures stay quiet; raw text is a fine result.
  _notifyAgentReasoningFailed() {
    this.onError?.({
      code: "AGENT_REASONING_FAILED",
      title: "Agent Unavailable",
      messageKey: "hooks.audioRecording.errorDescriptions.agentReasoningFailed",
    });
  }

  // The command still ran, so this is a downgrade notice rather than a failure.
  _notifyScreenContextSkipped() {
    this.onError?.({
      code: "SCREEN_CONTEXT_SKIPPED",
      title: "Screen Context Skipped",
      messageKey: "hooks.audioRecording.errorDescriptions.screenContextSkipped",
      variant: "default",
    });
  }

  isRecordingAllowedByPolicy() {
    const policyState = usePolicyStore.getState();
    return (
      (isManagedTranscriptionActive() ||
        isTranscriptionContextAllowed(policyState, getSettings(), "dictation")) &&
      (!this.voiceAgentRequested || isAgentAllowed(policyState))
    );
  }

  assertAgentAllowedByPolicy() {
    if (isAgentAllowed(usePolicyStore.getState())) return;
    const error = new Error("AI agent use is restricted by your organization.");
    error.code = "POLICY_RESTRICTED";
    error.messageKey = "common.policyAgentRestricted";
    throw error;
  }

  setSttConfig(config) {
    this.sttConfig = config;
    this.sttConfigFetchedAt = Date.now();
  }

  isSttConfigStale(now = Date.now()) {
    // Re-check opt-in language experiments frequently so a server rollback
    // takes effect on the next recording after at most 30 s of cached config.
    const ttl = hasOrukeetExperiment(this.sttConfig)
      ? ORUKEET_EXPERIMENT_CONFIG_TTL_MS
      : STT_CONFIG_TTL_MS;
    return !this.sttConfig || !this.sttConfigFetchedAt || now - this.sttConfigFetchedAt > ttl;
  }

  invalidateSttConfig() {
    this.sttConfig = null;
    this.sttConfigFetchedAt = null;
  }

  getStreamingProvider(name) {
    return STREAMING_PROVIDERS[name];
  }

  // The provider the active streaming session started on. The sttConfig can be
  // refreshed mid-recording and resolve a different provider, but the open
  // socket, its final and its disconnect belong to the one that started.
  getActiveStreamingProviderName() {
    return this._activeStreamingProviderName ?? this.getStreamingProviderName();
  }

  // Only the session that set the active fields clears them: a newer start
  // may already own them.
  _endStreamingSession(sessionId) {
    if (this._activeStreamingSessionId !== sessionId) return;
    this._activeStreamingSessionId = null;
    this._activeStreamingProviderName = null;
    this._activeStreamingConfig = null;
    this._activePipelineOptions = undefined;
  }

  getStreamingProviderName() {
    // Every AudioManager instance records dictation; notes and meetings have
    // their own routing, so the context is a literal here.
    const settings = getSettings();
    const name = resolveStreamingProviderName({
      settings,
      context: "dictation",
      sttConfig: this.sttConfig,
      language: this.getEffectiveSttLanguage(settings),
    });
    // A server-driven sttConfig.streamingProvider we don't recognize must fall
    // back to a provider we can run — and the reported name must match the
    // channel bindings actually used, so the main process is never handed a
    // provider id it would fail closed on.
    return STREAMING_PROVIDERS[name] ? name : defaultStreamingProviderName("dictation");
  }

  async getAudioConstraints(
    forceDefaultMic = false,
    refreshSystemDefault = false,
    waitForSystemDefault = false
  ) {
    const settings = getSettings();
    const noProcessing = TRANSCRIPTION_AUDIO_CONSTRAINTS;

    if (
      !forceDefaultMic &&
      !refreshSystemDefault &&
      this.cachedMicDeviceId &&
      this.cachedMicDeviceId !== this.rejectedMicDeviceId
    ) {
      this._lastMicResolution = "cached";
      return {
        audio: { deviceId: { exact: this.cachedMicDeviceId }, ...noProcessing },
      };
    }

    try {
      const resolution = await resolvePreferredMicrophone({
        settings,
        forceSystemDefault: forceDefaultMic,
        refreshSystemDefault: forceDefaultMic || refreshSystemDefault,
        waitForSystemDefault,
      });
      const deviceId = resolution.device?.deviceId;

      if (deviceId && deviceId !== this.rejectedMicDeviceId) {
        this._lastMicResolution = resolution.status;
        if (isCacheableMicrophoneResolution(resolution)) {
          this.cachedMicDeviceId = deviceId;
        }
        logger.debug(
          "Resolved microphone input",
          {
            mode: resolution.mode,
            status: resolution.status,
            label: resolution.device.label,
          },
          "audio"
        );
        return { audio: { deviceId: { exact: deviceId }, ...noProcessing } };
      }

      logger.debug(
        "Microphone selection could not be pinned; using browser fallback",
        { mode: resolution.mode, status: resolution.status },
        "audio"
      );
    } catch (error) {
      logger.debug(
        "Failed to resolve microphone selection; using browser fallback",
        { error: error.message },
        "audio"
      );
    }

    this._lastMicResolution = "browser-fallback";
    return { audio: { ...noProcessing } };
  }

  async cacheMicrophoneDeviceId() {
    if (this.cachedMicDeviceId) return; // Already cached

    try {
      const resolution = await resolvePreferredMicrophone({ settings: getSettings() });
      if (isCacheableMicrophoneResolution(resolution)) {
        this.cachedMicDeviceId = resolution.device.deviceId;
        logger.debug(
          "Microphone device ID pre-cached",
          { mode: resolution.mode, status: resolution.status },
          "audio"
        );
      }
    } catch (error) {
      logger.debug("Failed to pre-cache microphone device ID", { error: error.message }, "audio");
    }
  }

  // Open the mic the moment a dictation is likely (push-to-talk key-down,
  // toggle press) and hand the same stream — plus everything its pre-roll
  // recorder already captured — to the real recording. Replaces the one-shot
  // warmupMicDriver (#845): a raced warm-up never resolved before the
  // recording's own open, so it only ever added a concurrent double open.
  async prepareMicCapture({ trace } = {}) {
    // Preparing opens the device, so it answers to the same policy as the
    // recording it anticipates — otherwise a blocked user's key-down would
    // still light the mic and buffer pre-roll.
    if (!this.isRecordingAllowedByPolicy()) return null;
    // A start already awaiting the mic open leaves isRecording false for as long
    // as that open takes, so without this guard a second prepare would open the
    // device again and buffer a pre-roll no recording ever answers.
    if (
      this._startInProgress ||
      this.isRecording ||
      this.isProcessing ||
      this.isStreaming ||
      this._streamingStopPromise ||
      this.mediaRecorder?.state === "recording"
    ) {
      return null;
    }
    try {
      const prepared = await this.preparedMicCapture.prepare(async () => {
        // Built before the mic opens so its graph is rendering by the time the
        // pre-roll recorder starts; a tap attached later misses the first frames.
        const pcmTap = this._startPcmTap();
        try {
          const constraints = await this.getAudioConstraints();
          markStartTrace(trace, "micConstraintsReady");
          if (trace) trace.details = { ...trace.details, micResolution: this._lastMicResolution };
          const stream = await this._acquireCaptureStream(constraints, trace);
          markStartTrace(trace, "micReady");
          const value = {
            stream,
            constraints,
            recorder: null,
            chunks: [],
            pcmTap: null,
            startedAt: Date.now(),
            // The session starts here when its pre-roll is adopted.
            recordingQuality: currentRecordingQuality(),
          };
          if (!this.shouldUseStreaming()) this._startPreRollRecorder(value, pcmTap);
          if (value.recorder) markStartTrace(trace, "preRollStarted");
          if (!value.pcmTap) pcmTap?.close();
          return value;
        } catch (error) {
          pcmTap?.close();
          throw error;
        }
      });
      if (prepared) {
        logger.debug("Microphone capture prepared", { preRoll: !!prepared.recorder }, "audio");
      }
      return prepared;
    } catch (e) {
      logger.debug("Mic capture preparation failed (non-critical)", { error: e.message }, "audio");
      return null;
    }
  }

  cancelPreparedMicCapture() {
    this.preparedMicCapture.cancel();
  }

  // Tells the main process whether this renderer is holding the mic open outside
  // a recording — an idle hold or a prepared capture. Recordings are gated by
  // setUserRecording instead. Without this the device-global macOS/Linux mic
  // signal reports our own capture as a meeting.
  _syncMicOpenGate() {
    const open = this.micStreamHold.active || this.preparedMicCapture.active;
    if (open === this._micOpenReported) return;
    this._micOpenReported = open;
    window.electronAPI?.micWarmHoldChanged?.(open);
  }

  _disposePrepared(prepared) {
    if (!prepared) return;
    disposePreparedCapture(prepared);
    this._markCaptureStreamReleased();
  }

  // Record from the instant the prepared stream delivers frames. If the hold
  // guard confirms a real dictation these chunks become the recording's opening;
  // a cancel discards them without the audio ever leaving the renderer.
  _startPreRollRecorder(prepared, pcmTap) {
    try {
      const recorder = createDictationRecorder(prepared.stream, prepared.recordingQuality);
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) prepared.chunks.push(event.data);
      };
      recorder.start(RECORDING_TIMESLICE_MS);
      pcmTap?.attach(prepared.stream);
      prepared.recorder = recorder;
      prepared.pcmTap = pcmTap;
    } catch (e) {
      logger.debug("Pre-roll recorder unavailable", { error: e.message }, "audio");
    }
  }

  // Managed enterprise STT outranks the local lane, so the local engine never
  // sees this recording, and its refusal must not stop the enterprise route.
  _runsLocalPreview() {
    return Boolean(getSettings().useLocalWhisper) && !getManagedTranscriptionResolution();
  }

  // Offline local engines decode a renderer-captured 16 kHz WAV as-is, so the
  // batch recorder gets a PCM shadow (PcmTap). Online models commit their own
  // stream and every cloud lane wants the smaller WebM, so those get none.
  _startPcmTap() {
    const { useLocalWhisper, localTranscriptionProvider, parakeetModel } = getSettings();
    const offlineLocal =
      useLocalWhisper &&
      !getManagedTranscriptionResolution() &&
      !(localTranscriptionProvider === "nvidia" && isOnlineParakeetModel(parakeetModel));
    if (!offlineLocal) return null;
    try {
      return new PcmTap(this.getWorkletBlobUrl());
    } catch (e) {
      logger.debug("PCM tap unavailable", { error: e.message }, "audio");
      return null;
    }
  }

  _closeBatchPcmTap() {
    this._batchPcmTap?.close();
    this._batchPcmTap = null;
  }

  _constraintsKey(constraints) {
    return JSON.stringify(constraints?.audio ?? constraints ?? {});
  }

  _stampMicWarm() {
    this._micWarmedAt = Date.now();
  }

  // Every capture-stream release funnels through here: the driver was
  // demonstrably open, so stamp warmth (a free warm window for the next open,
  // replacing #1284's post-transcription re-warm and its extra device open)
  // and restart the idle-hold countdown.
  _markCaptureStreamReleased() {
    this._stampMicWarm();
    this.micStreamHold.touch();
  }

  async _acquireCaptureStream(constraints, trace) {
    const key = this._constraintsKey(constraints);
    const held = this.micStreamHold.acquireClone(key);
    if (held) {
      this._stampMicWarm();
      if (trace) trace.details = { ...trace.details, micSource: "held" };
      return held;
    }
    const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
    markStartTrace(trace, "micGetUserMediaDone");
    const stream = await this.acquireHealthyMicStream(rawStream, constraints);
    // "recovered": the first track stayed silent and the dead-mic ladder reopened it.
    if (trace) {
      trace.details = {
        ...trace.details,
        micSource: stream === rawStream ? "opened" : "recovered",
      };
    }
    this._stampMicWarm();
    return this.micStreamHold.adoptAndClone(stream, key);
  }

  // TTL-gated warm-up used only by the streaming-connection warm-up. The
  // recording paths never warm-then-discard — they open once via
  // prepareMicCapture and keep the stream. A stream resolving past the deadline
  // still stamps warmth: the driver did come up, which is exactly what the
  // slowest machines need recorded (#845).
  async _warmMicDriverIfCold(logCategory) {
    // A held master already has the driver up; opening a second device to prove
    // it is the concurrent double open this replaced.
    if (this.micStreamHold.active) {
      this._stampMicWarm();
      return;
    }
    if (isMicWarm(this._micWarmedAt, Date.now())) return;
    try {
      const constraints = await this.getAudioConstraints();
      const streamPromise = navigator.mediaDevices.getUserMedia(constraints);
      streamPromise
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop());
          this._stampMicWarm();
        })
        .catch(() => {});
      let timer = null;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("mic warmup timed out")),
          WARMUP_ACQUIRE_TIMEOUT_MS
        );
      });
      try {
        await Promise.race([streamPromise, deadline]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      logger.debug("Microphone driver pre-warmed", {}, logCategory);
    } catch (e) {
      logger.debug("Mic driver warmup failed (non-critical)", { error: e.message }, logCategory);
    }
  }

  // Recovers a dead/muted capture: retries the same device, then hops to the OS default,
  // remembering a silent pinned device for the session. Throws MicUnusableError when no
  // input delivers audio. See #1152.
  async acquireHealthyMicStream(rawStream, constraints) {
    const pinnedMicDeviceId = constraints.audio?.deviceId?.exact ?? null;
    let fallbackMicUnusable = false;
    // Keep verifying after a rejection too, otherwise a muted default records silence unnoticed.
    const verifyMic = pinnedMicDeviceId !== null || this.rejectedMicDeviceId !== null;
    const stream = await reacquireIfDead(
      rawStream,
      () => {
        this.cachedMicDeviceId = null;
        return this.getAudioConstraints();
      },
      logger,
      verifyMic
        ? {
            getConstraints: () => this.getAudioConstraints(true),
            onDeviceRejected: () => {
              if (pinnedMicDeviceId) this.rejectedMicDeviceId = pinnedMicDeviceId;
            },
            onFallbackUnusable: () => {
              fallbackMicUnusable = true;
            },
          }
        : null
    );

    if (fallbackMicUnusable) {
      stream.getTracks().forEach((track) => track.stop());
      const micError = new Error("No microphone is delivering audio");
      micError.name = "MicUnusableError";
      throw micError;
    }

    return stream;
  }

  async startRecording(forceDefaultMic = false) {
    let prepared = null;
    let preparedAdopted = false;
    let freshTap = null;
    const trace = this.startTrace;
    this.startTrace = null;
    this._startInProgress = true;
    try {
      if (!this.isRecordingAllowedByPolicy()) {
        logger.warn("Recording blocked by workspace policy", {}, "audio");
        return false;
      }
      if (
        this.isRecording ||
        this.isProcessing ||
        this.isStreaming ||
        this._streamingStopPromise ||
        this.mediaRecorder?.state === "recording"
      ) {
        return false;
      }

      const activationGeneration = this._activationCaptureGeneration ?? 0;
      if (
        !(await this._beginActivationCapture()) ||
        activationGeneration !== (this._activationCaptureGeneration ?? 0)
      )
        return false;
      const startRequestedAt = performance.now();
      prepared = forceDefaultMic ? null : await this.preparedMicCapture.take();
      const constraints =
        prepared?.constraints ?? (await this.getAudioConstraints(forceDefaultMic));
      // Without a prepared capture the tap starts here, before the mic opens.
      freshTap = prepared ? null : this._startPcmTap();
      const micStream = prepared?.stream ?? (await this._acquireCaptureStream(constraints, trace));
      const micReadyAt = performance.now();
      if (!prepared) markStartTrace(trace, "micReady");

      const audioTrack = micStream.getAudioTracks()[0];

      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
          },
          "audio"
        );
      }

      try {
        this._silenceCtx = new AudioContext();
        if (this._silenceCtx.state === "suspended") {
          // Not awaited — resume() can hang when the output device is wedged.
          this._silenceCtx.resume().catch(() => {});
        }
        this._silenceAnalyser = this._silenceCtx.createAnalyser();
        this._silenceAnalyser.fftSize = 2048;
        this._silenceSource = this._silenceCtx.createMediaStreamSource(micStream);
        this._silenceSource.connect(this._silenceAnalyser);
        this._localSpeechGateState = createLocalSpeechGateState();
        const dataArray = new Uint8Array(this._silenceAnalyser.fftSize);
        this._silenceInterval = setInterval(() => {
          // A stalled context reads flat silence; recording no windows fails the gate open.
          if (this._silenceCtx?.state !== "running") return;
          this._silenceAnalyser.getByteTimeDomainData(dataArray);
          let sum = 0;
          let peak = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          recordLocalSpeechWindow(this._localSpeechGateState, rms, peak);
        }, 100);
      } catch (e) {
        logger.warn("Audio level gate setup failed, skipping", { error: e.message }, "audio");
        this._localSpeechGateState = null;
      }

      this.audioChunks = [];
      this._batchSegments = [];
      this._closeBatchPcmTap();
      this._stopRequestedDuringMicRecovery = false;
      this._cancelRequestedDuringMicRecovery = false;
      this._receivedAudioData = false;
      const preRollUsable =
        prepared?.recorder?.state === "recording" &&
        Date.now() - prepared.startedAt <= PRE_ROLL_MAX_AGE_MS;
      if (!preRollUsable) discardPreRoll(prepared);
      const preRoll = preRollUsable
        ? { recorder: prepared.recorder, chunks: prepared.chunks }
        : null;
      // Pre-roll audio is part of the recording, so the reported duration
      // starts when the prepared stream started — but only when its recorder
      // was adopted; a prepared stream without pre-roll contributes no audio
      // before this point, and back-dating would inflate durationSeconds.
      this.recordingStartTime = preRoll ? prepared.startedAt : Date.now();
      // An adopted pre-roll already encodes at the quality read at key-down.
      this._recordingQuality = preRoll
        ? normalizeRecordingQuality(prepared.recordingQuality)
        : currentRecordingQuality();
      // The tap shadows the recorder from its first frame: the pre-roll's own,
      // or the one built before the mic opened. A tap started now would miss
      // the opening, so an unusable pre-roll leaves the WebM path in charge.
      this._batchPcmTap = preRoll ? prepared.pcmTap : freshTap;
      this._recordingSpool = this._startRecordingSpool();
      this.createBatchRecorder(micStream, preRoll);
      freshTap?.attach(micStream);
      preparedAdopted = true;
      this.isRecording = true;
      markStartTrace(trace, "recorderActive");
      this.onStateChange?.({
        isRecording: true,
        isProcessing: false,
        micCaptureStatus: "active",
      });
      const micReadyMs = Math.round(micReadyAt - startRequestedAt);
      const preparedAgeMs = prepared?.startedAt ? Date.now() - prepared.startedAt : 0;
      // Read by the start trace: preRoll false after a prepared capture means the
      // audio spoken before this point was dropped.
      this.lastStartInfo = {
        usedPreparedCapture: !!prepared,
        preRoll: !!preRoll,
        preparedAgeMs,
        startWaitedOnMicMs: micReadyMs,
      };
      logger.info(
        "Recording start timing",
        {
          micReadyMs,
          totalMs: Math.round(performance.now() - startRequestedAt),
          usedPreparedCapture: !!prepared,
          preparedAgeMs,
          recordingQuality: this._recordingQuality,
        },
        "audio"
      );

      const {
        showTranscriptionPreview,
        useLocalWhisper,
        localTranscriptionProvider,
        whisperModel,
        parakeetModel,
        cohereModel,
      } = getSettings();
      const isNvidia = localTranscriptionProvider === "nvidia";
      // Online models stream+commit during capture, so PCM runs even with preview off.
      const streamingCommit = useLocalWhisper && isNvidia && isOnlineParakeetModel(parakeetModel);
      this._streamingCommitActive = false;
      if (this._runsLocalPreview() && (showTranscriptionPreview || streamingCommit)) {
        try {
          this._previewAudioContext = new AudioContext({ sampleRate: 16000 });
          this._previewSource = this._previewAudioContext.createMediaStreamSource(micStream);
          await this._previewAudioContext.audioWorklet.addModule(this.getWorkletBlobUrl());

          this._previewProcessor = new AudioWorkletNode(
            this._previewAudioContext,
            "pcm-streaming-processor"
          );
          this._previewProcessor.port.onmessage = (event) => {
            if (event.data === "flushed") {
              this._previewFlushResolve?.();
              return;
            }
            window.electronAPI?.sendDictationPreviewAudio?.(event.data);
          };
          this._previewSource.connect(this._previewProcessor);

          const model = isNvidia
            ? parakeetModel
            : localTranscriptionProvider === "cohere"
              ? cohereModel
              : whisperModel;
          const language = getBaseLanguageCode(getSettings().preferredLanguage);
          window.electronAPI?.startDictationPreview?.({
            provider: localTranscriptionProvider,
            model,
            language,
            display: shouldDisplayDictationPreview(
              showTranscriptionPreview,
              this.voiceAgentRequested
            ),
          });
          this._streamingCommitActive = streamingCommit;
        } catch (e) {
          logger.warn("Preview worklet setup failed", { error: e.message }, "audio");
        }
      }

      await this.beginMicRecovery(micStream);

      return true;
    } catch (error) {
      this._cancelActivationCapture(this._takeActivationCapture());
      // A prepared value the recording never adopted still owns a live stream
      // (and possibly a pre-roll recorder); release it before any retry.
      freshTap?.close();
      if (prepared && !preparedAdopted) this._disposePrepared(prepared);
      if (isStaleDeviceError(error) && !forceDefaultMic) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn("Pinned microphone unavailable, retrying on default mic", {}, "audio");
        this.cachedMicDeviceId = null;
        return this.startRecording(true);
      }

      let errorTitle = "Recording Error";
      let errorDescription = `Failed to access microphone: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorTitle = "No Microphone Found";
        errorDescription = "No microphone was detected. Please connect a microphone and try again.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorTitle = "Microphone In Use";
        errorDescription =
          "The microphone is being used by another application. Please close other apps and try again.";
      } else if (error.name === "MicUnusableError") {
        errorTitle = "Microphone Muted";
        errorDescription =
          "Your microphones stayed muted and produced no audio. Please check your sound input settings and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      return false;
    } finally {
      this._startInProgress = false;
    }
  }

  createBatchRecorder(micStream, adoption = null) {
    // Adopting the pre-roll recorder keeps every chunk captured since key-down:
    // rebinding the handlers below transfers ownership with no gap and no
    // re-encode, and the seeded chunks become the recording's opening.
    const recorder =
      adoption?.recorder ?? createDictationRecorder(micStream, this._recordingQuality);
    const segmentChunks = adoption ? [...adoption.chunks] : [];
    if (segmentChunks.length > 0) {
      this._receivedAudioData = true;
      // The speech-gate analyser only attaches at recording start, so it never
      // measured these frames. Fail the gate open rather than let it discard a
      // short utterance spoken entirely in pre-roll (#845).
      this._localSpeechGateState = null;
    }
    this.mediaRecorder = recorder;
    this.audioChunks = segmentChunks;
    this.recordingMimeType = recorder.mimeType || "audio/webm";
    // Bound to this recorder: its last chunk lands after a cancel, when the
    // manager may already belong to the next recording.
    const spoolChunk = this._recordingSpool?.addSegment(this.recordingMimeType);
    segmentChunks.forEach((chunk) => spoolChunk?.(chunk));

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this._receivedAudioData = true;
        segmentChunks.push(event.data);
        spoolChunk?.(event.data);
      }
    };

    recorder.onstop = async () => {
      const segment = new Blob(segmentChunks, { type: recorder.mimeType || "audio/webm" });
      segmentChunks.length = 0;
      const rotating = this._rotatingBatchRecorder === recorder;
      // The recorder also stops on its own when its mic track dies (the stream
      // goes inactive). While recovery is armed, treat that like a rotation:
      // bank the segment and keep the recording alive for the replacement mic.
      if (rotating || this.micRecovery.started) {
        if (segment.size > 0) this._batchSegments.push(segment);
        micStream.getTracks().forEach((track) => track.stop());
        this._markCaptureStreamReleased();
        if (rotating) {
          this._rotatingBatchRecorder = null;
          this._rotationResolve?.();
          this._rotationResolve = null;
        } else {
          void this.micRecovery.recover("recorder-stopped");
        }
        return;
      }

      micStream.getTracks().forEach((track) => track.stop());
      this._markCaptureStreamReleased();
      await this.finalizeBatchRecording(segment);
    };

    if (!adoption) recorder.start(RECORDING_TIMESLICE_MS);
    return recorder;
  }

  async finalizeBatchRecording(finalSegment) {
    // Taken now, so a cancelled pipeline that settles late can't end the next
    // recording's spool.
    const spool = this._takeRecordingSpool();
    const activationCapture = this._takeActivationCapture();
    try {
      if (activationCapture)
        void window.electronAPI?.stopActivationCapture?.(activationCapture).catch(() => {});
      await this._finalizeBatchRecording(finalSegment, activationCapture);
    } finally {
      this._cancelActivationCapture(activationCapture);
      spool?.finish();
    }
  }

  async _finalizeBatchRecording(finalSegment, activationCapture = null) {
    const processingPipeline = this._startProcessingPipeline();
    processingPipeline.activationCapture = activationCapture;
    const wasCancelled = () => this._shouldAbandonProcessingPipeline(processingPipeline);
    const recordingQuality = this._recordingQuality;
    this.micRecovery.stop();
    this.teardownSpeechGate();
    const previewStopPromise = this.cleanupPreview({
      showCleanup: this.shouldShowPreviewCleanupState(),
    });
    const rawWavPromise = this._batchPcmTap?.stop();
    this._batchPcmTap = null;
    this.isRecording = false;
    this.isProcessing = true;
    this.onStateChange?.({
      isRecording: false,
      isProcessing: true,
      micCaptureStatus: "inactive",
    });

    const segments = finalSegment ? [...this._batchSegments, finalSegment] : this._batchSegments;
    this._batchSegments = [];
    const segmentsCount = segments.filter((segment) => segment?.size > 0).length;
    let audioBlob = null;
    let salvagedRecording = false;
    try {
      audioBlob = await this.mergeRecordedSegments(segments, recordingQuality);
    } catch (error) {
      if (wasCancelled()) {
        this._settleProcessingPipeline(processingPipeline);
        return;
      }
      logger.error("Failed to assemble recovered recording", { error: error.message }, "audio");
      // Salvage the largest segment rather than dropping the whole recording.
      audioBlob = this.getLargestRecordedSegment(segments);
      salvagedRecording = !!audioBlob;
    }
    if (wasCancelled()) {
      this._settleProcessingPipeline(processingPipeline);
      return;
    }
    audioBlob = audioBlob || new Blob([], { type: this.recordingMimeType || "audio/webm" });
    this.lastAudioBlob = audioBlob;

    logger.info(
      "Recording stopped",
      {
        blobSize: audioBlob.size,
        blobType: audioBlob.type,
        segmentsCount,
      },
      "audio"
    );

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;
    const analyticsOccurredAt = new Date(this.recordingStartTime || Date.now()).toISOString();
    this.recordingStartTime = null;
    const recordingCheck = evaluateFinishedRecording({
      blobSize: audioBlob.size,
      receivedAudioData: this._receivedAudioData,
    });
    if (!recordingCheck.usable) {
      logger.info(
        "Dropping degenerate recording before transcription",
        {
          blobSize: audioBlob.size,
          reason: recordingCheck.reason,
          receivedAudioData: this._receivedAudioData,
        },
        "audio"
      );
      if (!this._settleProcessingPipeline(processingPipeline)) return;
      const gate = getLocalSpeechGateDecision(this._localSpeechGateState);
      this._localSpeechGateState = null;
      // Nothing usable to keep, even as a discarded dictation.
      const emptyDictation = this._endEmptyDictation({
        durationMs: Number.isFinite(durationSeconds) ? durationSeconds * 1000 : null,
        source: "result",
        gate,
      });
      this.onTranscriptionComplete?.({ success: true, text: "", emptyDictation });
      return;
    }
    // A preview policy refusal also forbids decoding the full recording.
    const previewStop = await previewStopPromise;
    if (wasCancelled()) {
      this._settleProcessingPipeline(processingPipeline);
      return;
    }
    this._streamingCommitActive = false;
    const rawWav = await rawWavPromise;

    await this.processAudio(
      audioBlob,
      {
        durationSeconds,
        analyticsOccurredAt,
        ...(salvagedRecording ? { salvagedRecording: true } : {}),
        ...(previewStop?.streamed ? { streamedText: previewStop.text } : {}),
        ...(isTranscriptionPolicyRefusal(previewStop) ? { localPolicyRefusal: previewStop } : {}),
        ...(rawWav ? { rawWav } : {}),
      },
      processingPipeline
    );
    await processingPipeline.resultHandled;
  }

  async replaceBatchMic(replacement) {
    try {
      const recorder = this.mediaRecorder;
      if (!recorder) throw new Error("Batch recorder is no longer active");
      // An auto-stopped recorder (mic track died) already banked its segment in
      // onstop; only a live recorder needs the explicit rotation handshake.
      if (recorder.state === "recording") {
        await new Promise((resolve) => {
          this._rotatingBatchRecorder = recorder;
          this._rotationResolve = resolve;
          recorder.stop();
        });
      }
      if (!this.isRecording) throw new Error("Recording stopped during microphone recovery");

      this._silenceSource?.disconnect();
      if (this._silenceCtx && this._silenceAnalyser) {
        this._silenceSource = this._silenceCtx.createMediaStreamSource(replacement);
        this._silenceSource.connect(this._silenceAnalyser);
      }
      this._previewSource?.disconnect();
      if (this._previewAudioContext && this._previewProcessor) {
        this._previewSource = this._previewAudioContext.createMediaStreamSource(replacement);
        this._previewSource.connect(this._previewProcessor);
      }
      this._batchPcmTap?.attach(replacement);
      this.createBatchRecorder(replacement);
    } finally {
      // Honor a stop/cancel that arrived mid-rotation even when the swap failed —
      // dropping it would leave an unstoppable recording (isRecording stuck true).
      const cancelRequested = this._cancelRequestedDuringMicRecovery;
      const stopRequested = this._stopRequestedDuringMicRecovery;
      this._cancelRequestedDuringMicRecovery = false;
      this._stopRequestedDuringMicRecovery = false;
      if (cancelRequested) this.cancelRecording();
      else if (stopRequested) this.stopRecording();
    }
  }

  stopRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._stopRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
      return true;
    }
    if (this.isRecording && !this.isStreaming) {
      // The mic died mid-recovery, so no live recorder exists; finalize what
      // was captured instead of leaving the recording unstoppable.
      void this.finalizeBatchRecording(null);
      return true;
    }
    return false;
  }

  teardownSpeechGate() {
    if (this._silenceInterval) {
      clearInterval(this._silenceInterval);
      this._silenceInterval = null;
    }
    this._silenceCtx?.close().catch(() => {});
    this._silenceCtx = null;
    this._silenceAnalyser = null;
    this._silenceSource = null;
    this._levelData = null;
  }

  // Live input level (RMS 0..~1) for the waveform, read from whichever
  // pipeline is recording: the batch speech-gate analyser or the streaming
  // path's analyser. Null (waveform rests) when neither is live.
  getRecordingAudioLevel() {
    const pair = this._silenceAnalyser
      ? { ctx: this._silenceCtx, analyser: this._silenceAnalyser }
      : this.streamingAnalyser
        ? { ctx: this.streamingAudioContext, analyser: this.streamingAnalyser }
        : null;
    if (!pair?.ctx) return null;
    if (pair.ctx.state === "suspended") {
      // A suspended context reads flat silence — nudge it awake (not awaited;
      // resume() can hang when the output device is wedged).
      pair.ctx.resume().catch(() => {});
      return null;
    }
    if (pair.ctx.state !== "running") return null;
    const analyser = pair.analyser;
    if (!this._levelData || this._levelData.length !== analyser.fftSize) {
      this._levelData = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteTimeDomainData(this._levelData);
    let sum = 0;
    for (let i = 0; i < this._levelData.length; i++) {
      const v = (this._levelData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this._levelData.length);
  }

  cancelRecording() {
    this._cancelActivationCapture(this._takeActivationCapture());
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._cancelRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      const recorder = this.mediaRecorder;
      const discarded = this.takeDiscardedBatchSnapshot();
      this.mediaRecorder.onstop = () => {
        recorder.stream?.getTracks().forEach((track) => track.stop());
        this.persistDiscardedBatchRecording(discarded);
      };

      // Detach from manager state before recorder.stop(): its final
      // dataavailable/onstop land async and must not block or observe the
      // next recording.
      this.resetDiscardedBatchRecordingState();

      recorder.stop();

      if (recorder.stream) {
        recorder.stream.getTracks().forEach((track) => track.stop());
        this._markCaptureStreamReleased();
      }

      return true;
    }
    if (this.isRecording && !this.isStreaming) {
      // The mic died mid-recovery, so no live recorder exists; discard what was
      // captured instead of leaving the recording uncancelable.
      this.discardBatchRecording();
      return true;
    }
    return false;
  }

  discardBatchRecording() {
    const discarded = this.takeDiscardedBatchSnapshot();
    this.resetDiscardedBatchRecordingState();
    this.persistDiscardedBatchRecording(discarded);
  }

  takeDiscardedBatchSnapshot() {
    return {
      durationSeconds: this.recordingStartTime
        ? (Date.now() - this.recordingStartTime) / 1000
        : null,
      analyticsOccurredAt: new Date(this.recordingStartTime || Date.now()).toISOString(),
      chunks: this.audioChunks,
      segments: this._batchSegments,
      mimeType: this.recordingMimeType,
      recordingQuality: this._recordingQuality,
    };
  }

  resetDiscardedBatchRecordingState() {
    this._takeRecordingSpool()?.finish();
    this.teardownSpeechGate();
    this._localSpeechGateState = null;

    this.cleanupPreview({ dismiss: true });
    this._closeBatchPcmTap();
    this.isRecording = false;
    this.isProcessing = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this._batchSegments = [];
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: false });
  }

  persistDiscardedBatchRecording({
    durationSeconds,
    analyticsOccurredAt,
    chunks,
    segments,
    mimeType,
    recordingQuality,
  }) {
    // This must run after MediaRecorder's final dataavailable event, so decide
    // whether to retain the discarded audio from the snapshot rather than live
    // manager state (which may already belong to a new recording).
    const shouldSave =
      shouldSaveDiscardedRecording(getSettings(), durationSeconds, usePolicyStore.getState()) &&
      (chunks.length > 0 || segments.length > 0);
    if (shouldSave) {
      // Assemble and save in the background — the merge crosses IPC into FFmpeg
      // and must not delay the recorder becoming available again.
      void (async () => {
        try {
          const current = new Blob(chunks, { type: mimeType });
          const blob = await this.mergeRecordedSegments([...segments, current], recordingQuality);
          if (blob)
            await this.saveDiscardedTranscription(blob, durationSeconds, analyticsOccurredAt);
        } catch (error) {
          const fallback = this.getLargestRecordedSegment([
            ...segments,
            new Blob(chunks, { type: mimeType }),
          ]);
          if (fallback) {
            try {
              await this.saveDiscardedTranscription(fallback, durationSeconds, analyticsOccurredAt);
            } catch (fallbackError) {
              logger.warn(
                "Failed to save discarded recording fallback",
                { error: fallbackError.message },
                "audio"
              );
            }
            return;
          }
          logger.warn("Failed to save discarded recording", { error: error.message }, "audio");
        }
      })();
    }
  }

  _startProcessingPipeline() {
    const pipeline = {
      cancellationGeneration: this._processingCancellationGeneration ?? 0,
    };
    this._activeProcessingPipeline = pipeline;
    return pipeline;
  }

  _shouldAbandonProcessingPipeline(pipeline) {
    return (
      pipeline.cancellationGeneration !== (this._processingCancellationGeneration ?? 0) ||
      this._activeProcessingPipeline !== pipeline
    );
  }

  _settleProcessingPipeline(pipeline) {
    if (this._activeProcessingPipeline !== pipeline) return false;
    this._activeProcessingPipeline = null;
    if (this.isProcessing) {
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
    }
    return true;
  }

  cancelProcessing() {
    this._cancelActivationCapture(this._activeProcessingPipeline?.activationCapture);
    if (this.isProcessing) {
      this._processingCancellationGeneration = (this._processingCancellationGeneration ?? 0) + 1;
      this._requestStreamingCancellation();
      // Streaming finalization can be inside a provider or model await that
      // cannot be aborted. Keep the lifecycle truthfully busy until that await
      // observes the generation change and exits; advertising idle while the
      // stop promise still blocks a new recording makes hotkeys appear broken.
      if (this._streamingStopPromise) return true;

      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      // finalizeBatchRecording's earlier cleanupPreview() call (without
      // dismiss:true) already put the live-transcript panel in a "hold"
      // state — meant to keep showing the final/cleanup text, not close it.
      // onError used to be what actually closed the panel on a failure; the
      // processAudio cancel guard means onError never fires for a cancel, so
      // the close has to happen here instead, independent of onError. Only
      // reached when _streamingStopPromise was falsy above, i.e. never for a
      // streaming session (recording or finalizing) — its own preview
      // lifecycle is untouched by this call.
      window.electronAPI?.dismissDictationPreview?.();
      return true;
    }
    return false;
  }

  // The dictation error card's Retry for a failure a second try can fix
  // (failedRecordingRetry.js): runs this dictation pipeline again on the kept
  // recording, with its translation and style intent, so transcription,
  // glossary, cleanup or style, step history and paste behave as for a
  // dictation. It pastes where the user is now (the target is captured
  // afresh) and completes the failed History row; failing again brings the
  // card back for the same row. Cancelled like any processing. False when a
  // recording or another dictation holds the pipeline, or a cancel came first.
  async resendFailedRecording(kept) {
    if (!kept?.blob || !canStartDictation(this.getState())) return false;
    this.setVoiceAgentRequested(false);
    this.setTranslationRequested(kept.translationRequested === true);
    this.setRecordingStyle(kept.style ?? null);
    this.lastAudioBlob = kept.blob;
    this.lastAudioMetadata = null;
    const pipeline = this._startProcessingPipeline();
    this.isProcessing = true;
    this.onStateChange?.({ isRecording: false, isProcessing: true });

    const api = window.electronAPI;
    const capture = api?.captureDictationTarget?.();
    this.recordingTargetPromise = capture
      ? Promise.resolve(capture)
          .then(() => api?.getDictationTargetApp?.() ?? null)
          .catch(() => null)
      : null;
    let rowId = null;
    try {
      rowId = await kept.rowId;
    } catch {
      rowId = null;
    }
    pipeline.resend = { rowId: Number.isInteger(rowId) ? rowId : null };
    this.stepHistoryRunPromise = requestStepHistoryRun(
      pipeline.resend.rowId !== null ? { transcriptionId: pipeline.resend.rowId } : undefined
    );
    if (this._shouldAbandonProcessingPipeline(pipeline)) {
      this._settleProcessingPipeline(pipeline);
      return false;
    }
    logger.info(
      "Re-sending a failed dictation",
      {
        historyId: pipeline.resend.rowId,
        blobSize: kept.blob.size,
        durationSeconds: kept.metadata?.durationSeconds ?? null,
      },
      "audio"
    );
    await this.processAudio(kept.blob, { ...kept.metadata }, pipeline);
    await pipeline.resultHandled;
    return true;
  }

  // Every dictation that ends with no text comes through here once, with its
  // length: one "Empty dictation" line and how it ends (emptyDictation.js),
  // "quiet" when it's shorter than "End empty dictations quietly", else the
  // "We didn't catch that" notice. `source`: the provider answered with no
  // text ("provider"), the speech gate skipped the request ("gate"), or an
  // empty result ("result"). The gate's measurements help tune the threshold;
  // never any text. Returns what the dictation window hears.
  _endEmptyDictation({ durationMs, source, code = null, gate = null }) {
    const thresholdSeconds = normalizeQuietEmptyDictationSeconds(
      getSettings()?.quietEmptyDictationSeconds
    );
    const knownDurationMs = Number.isFinite(durationMs) ? Math.round(durationMs) : null;
    const outcome = emptyDictationOutcome({ durationMs: knownDurationMs, thresholdSeconds });
    logger.info(
      "Empty dictation",
      {
        durationMs: knownDurationMs,
        thresholdSeconds,
        outcome,
        source,
        code: code ?? null,
        ...speechGateMetrics(gate),
      },
      "audio"
    );
    return { durationMs: knownDurationMs, outcome };
  }

  // A quiet empty dictation leaves no row in History, failed or otherwise:
  // only what "Save discarded dictations" keeps of a cancelled recording.
  _saveQuietEmptyDictation(blob, { durationSeconds = null, analyticsOccurredAt = null } = {}) {
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    if (!(blob?.size > 0)) return null;
    if (!shouldSaveDiscardedRecording(getSettings(), durationSeconds, usePolicyStore.getState())) {
      return null;
    }
    return this.saveDiscardedTranscription(blob, durationSeconds, analyticsOccurredAt);
  }

  // A streaming recording that ended without a transcript (its batch fallback
  // or its language re-transcription failed) ends as a batch recording's
  // failure would: its row is saved and its recording kept for the card's
  // Retry, which re-sends it through the batch pipeline with the settings in
  // force then. Silence keeps its recording too, unless the dictation was
  // short enough to end quietly (`emptyDictation`, from _endEmptyDictation).
  // Returns the card's report, or null for silence; `delivery.resultHandled`
  // waits on the save.
  _failStreamingRecording(error, { blob, metadata, delivery, emptyDictation = null }) {
    const outcome = transcriptionFailureOutcome(error);
    if (outcome.noAudio && emptyDictation?.outcome === "quiet") {
      delivery.resultHandled = this._saveQuietEmptyDictation(blob, metadata);
      return null;
    }
    let resolveRowId = null;
    const rowId = outcome.keepAudio
      ? new Promise((resolve) => {
          resolveRowId = resolve;
        })
      : null;
    if (outcome.keepAudio) {
      // A transcript a later step couldn't process stays on the row (#2678):
      // the re-transcription's or fallback's, never a discarded stream's.
      delivery.resultHandled = this.saveFailedTranscription(
        error.message,
        error.code || null,
        metadata,
        {
          onRowSaved: resolveRowId,
          transcript: error.transcript,
          clientTranscriptionId: error.transcriptClientId,
        }
      );
    }
    if (!outcome.report) return null;
    const keptRecording = keptRecordingFor({
      error,
      blob,
      metadata,
      retention: getEffectiveRetentionPreferences(),
      voiceAgentRequested: this.voiceAgentRequested,
      translationRequested: this.translationRequested,
      style: this.getActiveRecordingStyle(),
      rowId,
    });
    return {
      ...outcome.report,
      ...(keptRecording ? { keptRecording } : {}),
      ...(rowId ? { historyRowId: rowId } : {}),
    };
  }

  async processAudio(audioBlob, metadata = {}, processingPipeline = null) {
    const pipeline = processingPipeline ?? this._startProcessingPipeline();
    if (processingPipeline && this._activeProcessingPipeline !== processingPipeline) return;
    const wasCancelled = () => this._shouldAbandonProcessingPipeline(pipeline);
    const pipelineStart = performance.now();
    const settings = getSettings();
    let noAudioDetected = false;
    let emptyDictation = null;
    const speechGateDecision = getLocalSpeechGateDecision(this._localSpeechGateState);
    this._localSpeechGateState = null;

    const shouldUseStrongLocalWhisperGate =
      settings.useLocalWhisper && settings.localTranscriptionProvider === "whisper";
    if (
      speechGateDecision.skip &&
      (speechGateDecision.reason === "silence" || shouldUseStrongLocalWhisperGate)
    ) {
      logger.info(
        "Speech gate skipped transcription",
        {
          reason: speechGateDecision.reason,
          useLocalWhisper: settings.useLocalWhisper,
          localProvider: settings.localTranscriptionProvider,
          peakRms: speechGateDecision.peakRms?.toFixed(4),
          peakAmplitude: speechGateDecision.peakAmplitude?.toFixed(4),
          speechWindowCount: speechGateDecision.speechWindowCount,
          maxConsecutiveSpeechWindows: speechGateDecision.maxConsecutiveSpeechWindows,
        },
        "audio"
      );
      if (!this._settleProcessingPipeline(pipeline)) return;
      emptyDictation = this._endEmptyDictation({
        durationMs: durationMsOf(metadata),
        source: "gate",
        gate: speechGateDecision,
      });
      if (emptyDictation.outcome === "quiet") {
        pipeline.resultHandled = this._saveQuietEmptyDictation(audioBlob, metadata);
      }
      this.onTranscriptionComplete?.({ success: true, text: "", emptyDictation });
      return;
    }

    try {
      const useLocalWhisper = settings.useLocalWhisper;
      const localProvider = settings.localTranscriptionProvider;
      const whisperModel = settings.whisperModel;
      const parakeetModel = settings.parakeetModel || "parakeet-tdt-0.6b-v3";

      const cloudTranscriptionMode = settings.cloudTranscriptionMode;
      const isSignedIn = settings.isSignedIn;

      const isOpenWhisprCloudMode = !useLocalWhisper && cloudTranscriptionMode === "openwhispr";
      const useCloud = isOpenWhisprCloudMode && isSignedIn;
      logger.debug(
        "Transcription routing",
        { useLocalWhisper, useCloud, isSignedIn, cloudTranscriptionMode },
        "transcription"
      );

      let result;
      let activeModel;
      // Managed enterprise STT outranks the local and OpenWhispr Cloud lanes,
      // matching the LLM scopes; users opt out via "Use personal setup" when
      // the administrator allows it. Error resolutions fail closed inside
      // processWithOpenAIAPI with their own code.
      const managedTranscription = getManagedTranscriptionResolution();
      if (managedTranscription) {
        activeModel =
          managedTranscription.kind === "managed" ? managedTranscription.deployment : null;
        result = await this.processWithOpenAIAPI(audioBlob, metadata, wasCancelled);
      } else if (useLocalWhisper) {
        if (isTranscriptionPolicyRefusal(metadata.localPolicyRefusal)) {
          throw errorFromIpcResult(metadata.localPolicyRefusal);
        }
        // Judges the saved model, not parakeetModel: its default is for guests and
        // unmanaged users, so a settled managed policy refuses a blank here.
        const savedLocalModel =
          localProvider === "cohere"
            ? settings.cohereModel
            : isSherpaLocalProvider(localProvider)
              ? settings.parakeetModel
              : whisperModel;
        const policyState = usePolicyStore.getState();
        if (
          settings.policyBlockedLocalScopes?.includes("dictation") ||
          // A lookup in flight decides nothing here: main's gate holds its own verdict.
          (policyState.status !== "loading" &&
            !isLocalModelAllowedByPolicy(policyState, "transcription", savedLocalModel ?? ""))
        ) {
          const { code, messageKey, settingsTarget } = localModelRefusal(
            policyState,
            "transcription"
          );
          throw Object.assign(new Error(i18n.t(messageKey)), {
            code,
            messageKey,
            ...(isLocalChoiceRefusal(code) ? { settingsTarget } : {}),
          });
        }
        if (isSherpaLocalProvider(localProvider)) {
          activeModel = localProvider === "cohere" ? settings.cohereModel : parakeetModel;
          result = await this.processWithLocalParakeet(
            audioBlob,
            activeModel,
            metadata,
            wasCancelled
          );
        } else {
          activeModel = whisperModel;
          result = await this.processWithLocalWhisper(
            audioBlob,
            whisperModel,
            metadata,
            wasCancelled
          );
        }
      } else if (isOpenWhisprCloudMode) {
        if (!isSignedIn) throw cloudSignInRequiredError();
        activeModel = "openwhispr-cloud";
        result = await this.processWithOpenWhisprCloud(audioBlob, metadata, wasCancelled);
      } else {
        activeModel = this.getTranscriptionModel();
        result = await this.processWithOpenAIAPI(audioBlob, metadata, wasCancelled);
      }

      if (wasCancelled() || !this.isProcessing) {
        return;
      }

      this.lastAudioMetadata = {
        durationMs: metadata?.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : Math.round(performance.now() - pipelineStart),
        provider: result?.source || (useLocalWhisper ? localProvider : "cloud"),
        model: activeModel || null,
      };

      // A salvaged WebM only matters to whoever decoded it; the tap's WAV spans
      // the whole recording.
      result = withSalvageWarning(result, metadata.salvagedRecording && !result?.decodedRawWav);

      result = {
        ...result,
        ...(metadata.analyticsOccurredAt
          ? { analyticsOccurredAt: metadata.analyticsOccurredAt }
          : {}),
        ...this._takePendingResultExtras(),
        // A re-sent failed dictation completes its failed History row.
        ...(Number.isInteger(pipeline.resend?.rowId)
          ? { replacesTranscriptionId: pipeline.resend.rowId }
          : {}),
      };
      // A provider that answered with nothing to paste ends as any empty
      // dictation does.
      let quietSave = null;
      if (result.success && !hasTextContent(result.text)) {
        emptyDictation = this._endEmptyDictation({
          durationMs: durationMsOf(metadata),
          source: "result",
          gate: speechGateDecision,
        });
        result = { ...result, emptyDictation };
        if (emptyDictation.outcome === "quiet" && !Number.isInteger(pipeline.resend?.rowId)) {
          quietSave = this._saveQuietEmptyDictation(audioBlob, metadata);
        }
      }
      // Settles once the result is delivered and saved; the recording's spool
      // waits for it, so a main process that hangs on the paste or the save
      // can't take the audio with it.
      await this._completeActivationCapture(pipeline.activationCapture, result);
      if (wasCancelled()) return;
      const delivered = this.onTranscriptionComplete?.(result);
      pipeline.resultHandled = quietSave ? Promise.all([delivered, quietSave]) : delivered;

      if (result?.source === "openwhispr") {
        window.dispatchEvent(new Event("usage-changed"));
      }

      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);

      const timingData = {
        mode: useLocalWhisper ? `local-${localProvider}` : "cloud",
        model: activeModel,
        audioDurationMs: metadata.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : null,
        reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
        roundTripDurationMs,
        audioSizeBytes: audioBlob.size,
        audioFormat: audioBlob.type,
        outputTextLength: result?.text?.length,
      };

      if (useLocalWhisper) {
        timingData.audioConversionDurationMs = result?.timings?.audioConversionDurationMs ?? null;
      }
      timingData.transcriptionProcessingDurationMs =
        result?.timings?.transcriptionProcessingDurationMs ?? null;

      logger.info("Pipeline timing", timingData, "performance");
    } catch (error) {
      const errorAtMs = Math.round(performance.now() - pipelineStart);

      if (wasCancelled()) {
        // The user cancelled mid-pipeline; the aborted request's rejection is
        // the expected outcome, not a failure to report or persist.
        logger.info("Transcription cancelled by user", { errorAtMs }, "performance");
        return;
      }

      const outcome = transcriptionFailureOutcome(error);
      // Nothing heard isn't a problem: its "Empty dictation" line says how it
      // ended, so only real failures reach Problems only.
      logger[outcome.noAudio ? "debug" : "error"](
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
          ...(outcome.noAudio ? { code: error.code ?? null } : {}),
        },
        "performance"
      );

      noAudioDetected = outcome.noAudio;
      // Any failure that kept its recording can be re-sent from the card's
      // Retry (failedRecordingRetry.js). A re-send that fails again keeps its row.
      const completesRow = Number.isInteger(pipeline.resend?.rowId);
      if (outcome.noAudio) {
        emptyDictation = this._endEmptyDictation({
          durationMs: durationMsOf(metadata),
          source: "provider",
          code: error.code,
          gate: speechGateDecision,
        });
      }
      // A short one ends quietly: no failed row, only a discarded one if the
      // user keeps those.
      const quiet = emptyDictation?.outcome === "quiet";
      const savesRow = outcome.keepAudio && Boolean(this.lastAudioBlob) && !completesRow && !quiet;
      let resolveRowId = null;
      // The failed History row, for the card's Retry and its Open in History.
      const rowId = completesRow
        ? Promise.resolve(pipeline.resend.rowId)
        : savesRow
          ? new Promise((resolve) => {
              resolveRowId = resolve;
            })
          : null;
      const keptRecording = outcome.report
        ? keptRecordingFor({
            error,
            blob: audioBlob,
            metadata,
            retention: getEffectiveRetentionPreferences(),
            voiceAgentRequested: this.voiceAgentRequested,
            translationRequested: this.translationRequested,
            style: this.getActiveRecordingStyle(),
            rowId,
          })
        : null;
      if (outcome.report) {
        this.onError?.({
          ...outcome.report,
          ...(keptRecording ? { keptRecording } : {}),
          ...(rowId ? { historyRowId: rowId } : {}),
        });
      }
      if (savesRow) {
        pipeline.resultHandled = this.saveFailedTranscription(
          error.message,
          error.code || null,
          metadata,
          {
            onRowSaved: resolveRowId,
            // A transcript a later step couldn't process stays on the row (#2678).
            transcript: error.transcript,
            clientTranscriptionId: error.transcriptClientId,
          }
        );
      } else if (quiet && !completesRow) {
        pipeline.resultHandled = this._saveQuietEmptyDictation(audioBlob, metadata);
      }
    } finally {
      const shouldNotifyNoAudio =
        !wasCancelled() && noAudioDetected && this._activeProcessingPipeline === pipeline;
      this._settleProcessingPipeline(pipeline);
      // Every provider reports genuine silence through this one post-processing
      // outcome. The pill can now leave thinking before the error surface takes
      // ownership, instead of receiving an IPC event mid-pipeline.
      if (shouldNotifyNoAudio) this.onNoAudio?.(emptyDictation);
    }
  }

  async processWithLocalWhisper(
    audioBlob,
    model = "base",
    metadata = {},
    wasCancelled = neverCancelled
  ) {
    const timings = {};

    try {
      // The PCM tap's WAV skips FFmpeg in the main process; the WebM stays the
      // fallback and is what history and any cloud retry receive.
      const source = metadata.rawWav ?? audioBlob;
      const arrayBuffer = await source.arrayBuffer();
      const language = getBaseLanguageCode(this.getEffectiveSttLanguage(getSettings()));
      const options = { model };
      if (language) {
        options.language = language;
      }

      // Add custom dictionary as initial prompt to help Whisper recognize specific words
      const customDictionaryPrompt = this.getCustomDictionaryPrompt();
      const dictionaryPrompt = this.getWhisperPrompt();
      // Shared words dilute the echo filter's word share, so an echo of the
      // user's own words is checked on its own too (see isDictionaryEcho).
      const personalDictionaryPrompt = this.getPersonalDictionaryPrompt();
      const echoPrompts = [dictionaryPrompt, customDictionaryPrompt];
      if (personalDictionaryPrompt && personalDictionaryPrompt !== customDictionaryPrompt) {
        echoPrompts.push(personalDictionaryPrompt);
      }
      const matchesAnyEchoPrompt = (text) =>
        echoPrompts.some((prompt) => matchesDictionaryPrompt(text, prompt));
      if (dictionaryPrompt) {
        options.initialPrompt = dictionaryPrompt;
      }

      logger.debug(
        "Local transcription starting",
        {
          audioFormat: source.type,
          audioSizeBytes: source.size,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      let result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);
      if (isTranscriptionPolicyRefusal(result)) throw errorFromIpcResult(result);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Local transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        const strictDictionaryEcho = Boolean(dictionaryPrompt && matchesAnyEchoPrompt(result.text));
        const initialFragment = analyzeDictionaryPromptFragment(result.text, dictionaryPrompt);
        const dictionaryPromptFragment = !strictDictionaryEcho && initialFragment.isPromptFragment;
        // A non-repeated fragment can only be replaced by the sparse-recording rule
        // below, so on a short recording the retry would be decoded and then discarded.
        const retryCanBeAdopted =
          strictDictionaryEcho ||
          initialFragment.hasRepeatedWords ||
          (Number.isFinite(metadata.durationSeconds) &&
            metadata.durationSeconds >= MIN_SPARSE_RECORDING_DURATION_SECONDS);

        if ((strictDictionaryEcho || dictionaryPromptFragment) && retryCanBeAdopted) {
          // A prompt-free, VAD-free retry distinguishes real speech from Whisper
          // continuing either the whole dictionary prompt or a short fragment of it.
          const retryStart = performance.now();
          let retry = null;
          try {
            retry = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, {
              model: options.model,
              ...(options.language ? { language: options.language } : {}),
              skipVad: true,
            });
            if (isTranscriptionPolicyRefusal(retry)) throw errorFromIpcResult(retry);
          } catch (retryError) {
            if (isTranscriptionPolicyRefusal(retryError)) throw retryError;
            if (strictDictionaryEcho) throw retryError;
            // A heuristic recovery is best-effort; keep the initial text if it fails.
            logger.warn(
              "Dictionary-fragment retry failed; keeping the initial transcript",
              { message: retryError?.message },
              "audio"
            );
          }

          const retryText = retry?.success && typeof retry.text === "string" ? retry.text : "";
          const hasRetryText = Boolean(retryText.trim());
          const retryFragment = analyzeDictionaryPromptFragment(retryText, dictionaryPrompt);
          const retryStrictDictionaryEcho = Boolean(
            hasRetryText && matchesAnyEchoPrompt(retryText)
          );
          // On the strict path a short, dictionary-spelled retry is the recovered
          // dictation (#1454), not a second echo — only another full-prompt echo
          // disqualifies it. The fragment test applies to the heuristic path alone.
          const retryStillPromptLike = strictDictionaryEcho
            ? retryStrictDictionaryEcho
            : retryStrictDictionaryEcho || retryFragment.isPromptFragment;
          const retryAddsUniqueWords =
            retryFragment.uniqueWordCount > initialFragment.uniqueWordCount;
          const repeatedFragmentRecovered =
            initialFragment.hasRepeatedWords && retryAddsUniqueWords;
          // A non-repeated dictionary term or snippet is valid short-form
          // dictation unless a long recording yields substantially more content.
          const sparseRecordingRecovered =
            Number.isFinite(metadata.durationSeconds) &&
            metadata.durationSeconds >= MIN_SPARSE_RECORDING_DURATION_SECONDS &&
            retryFragment.uniqueWordCount >= initialFragment.uniqueWordCount + MIN_UNIQUE_WORD_GAIN;
          const recovered =
            hasRetryText &&
            !retryStillPromptLike &&
            (strictDictionaryEcho || repeatedFragmentRecovered || sparseRecordingRecovered);

          logger.info(
            "Local dictionary-prompt recovery attempt",
            {
              reason: strictDictionaryEcho ? "strict-echo" : "prompt-fragment",
              retryDurationMs: Math.round(performance.now() - retryStart),
              promptLength: dictionaryPrompt.length,
              initialTextLength: result.text.length,
              retryTextLength: retryText.length,
              recovered,
            },
            "audio"
          );

          timings.transcriptionProcessingDurationMs = Math.round(
            performance.now() - transcriptionStart
          );

          if (recovered) {
            result = retry;
          } else if (strictDictionaryEcho) {
            throw dictionaryEchoError();
          }
        }
        const rawText = result.text;
        const reasoningStart = performance.now();
        const post = await this.processTranscription(result.text, "local", wasCancelled, {
          provider: "local-whisper",
          model,
          ms: timings.transcriptionProcessingDurationMs,
        });
        const text = post.text;
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return {
            success: true,
            text: text || result.text,
            rawText,
            source: "local",
            timings,
            trace: post.trace,
            ...(metadata.rawWav ? { decodedRawWav: true } : {}),
          };
        } else {
          throw emptyTranscriptError("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Local Whisper transcription failed");
      }
    } catch (error) {
      if (isTranscriptionPolicyRefusal(error)) throw error;
      if (error.selectionEditFatal) {
        throw error;
      }
      // Nothing heard is not a failure: no fallback, and its code survives.
      if (error.message === "No audio detected" || error.code === EMPTY_TRANSCRIPT_CODE) {
        throw error;
      }

      const {
        allowOpenAIFallback,
        useLocalWhisper: isLocalMode,
        cloudTranscriptionProvider,
      } = getSettings();
      // A policy-blocked fallback surfaces the local failure, not a policy error.
      const fallbackAllowedByPolicy = isTranscriptionSelectionAllowed(usePolicyStore.getState(), {
        mode: "providers",
        provider: cloudTranscriptionProvider || "openai",
      });

      if (
        allowOpenAIFallback &&
        isLocalMode &&
        fallbackAllowedByPolicy &&
        !isUnknownLocalModelError(error)
      ) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata, wasCancelled);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          if (isTranscriptionPolicyRefusal(fallbackError)) throw fallbackError;
          if (fallbackError.selectionEditFatal) {
            throw fallbackError;
          }
          throw new Error(
            `Local Whisper failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Local Whisper failed: ${error.message}`);
      }
    }
  }

  async processWithLocalParakeet(
    audioBlob,
    model = "parakeet-tdt-0.6b-v3",
    metadata = {},
    wasCancelled = neverCancelled
  ) {
    const timings = {};

    try {
      let result;
      const streamedText =
        typeof metadata.streamedText === "string" ? metadata.streamedText.trim() : null;
      // An empty stream is indistinguishable from silence; let the offline decode settle it.
      if (streamedText) {
        logger.debug("Parakeet using committed streaming transcript", { model }, "performance");
        timings.transcriptionProcessingDurationMs = 0;
        result = { success: true, text: streamedText };
      } else {
        const source = metadata.rawWav ?? audioBlob;
        const arrayBuffer = await source.arrayBuffer();

        logger.debug(
          "Parakeet transcription starting",
          {
            audioFormat: source.type,
            audioSizeBytes: source.size,
            model,
          },
          "performance"
        );

        const transcriptionStart = performance.now();
        result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, {
          model,
          language: getBaseLanguageCode(this.getEffectiveSttLanguage(getSettings())),
        });
        if (isTranscriptionPolicyRefusal(result)) throw errorFromIpcResult(result);
        timings.transcriptionProcessingDurationMs = Math.round(
          performance.now() - transcriptionStart
        );

        logger.debug(
          "Parakeet transcription complete",
          {
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
            success: result.success,
          },
          "performance"
        );
      }

      if (result.success && result.text) {
        const rawText = result.text;
        const reasoningStart = performance.now();
        const post = await this.processTranscription(result.text, "local-parakeet", wasCancelled, {
          provider: "local-parakeet",
          model,
          ms: timings.transcriptionProcessingDurationMs,
        });
        const text = post.text;
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return {
            success: true,
            text: text || result.text,
            rawText,
            source: "local-parakeet",
            timings,
            trace: post.trace,
            ...(result.warning ? { warning: result.warning } : {}),
            ...(metadata.rawWav ? { decodedRawWav: true } : {}),
          };
        } else {
          throw emptyTranscriptError("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Parakeet transcription failed");
      }
    } catch (error) {
      if (isTranscriptionPolicyRefusal(error)) throw error;
      if (error.selectionEditFatal) {
        throw error;
      }
      // Nothing heard is not a failure: no fallback, and its code survives.
      if (error.message === "No audio detected" || error.code === EMPTY_TRANSCRIPT_CODE) {
        throw error;
      }

      const {
        allowOpenAIFallback,
        useLocalWhisper: isLocalMode,
        cloudTranscriptionProvider,
      } = getSettings();
      // A policy-blocked fallback surfaces the local failure, not a policy error.
      const fallbackAllowedByPolicy = isTranscriptionSelectionAllowed(usePolicyStore.getState(), {
        mode: "providers",
        provider: cloudTranscriptionProvider || "openai",
      });

      if (
        allowOpenAIFallback &&
        isLocalMode &&
        fallbackAllowedByPolicy &&
        !isUnknownLocalModelError(error)
      ) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata, wasCancelled);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          if (isTranscriptionPolicyRefusal(fallbackError)) throw fallbackError;
          if (fallbackError.selectionEditFatal) {
            throw fallbackError;
          }
          throw new Error(
            `Parakeet failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Parakeet failed: ${error.message}`);
      }
    }
  }

  async getAPIKey() {
    const s = getSettings();
    if (shouldSkipTranscriptionApiKey(s)) {
      return null;
    }

    const provider = s.cloudTranscriptionProvider || "openai";

    // Check cache (invalidate if provider changed)
    if (this.cachedApiKey !== null && this.cachedApiKeyProvider === provider) {
      return this.cachedApiKey;
    }

    let apiKey = null;

    if (provider === "custom") {
      // Prefer store value (user-entered via UI) over main process (.env)
      apiKey = s.customTranscriptionApiKey || "";
      if (!apiKey.trim()) {
        try {
          apiKey = await window.electronAPI.getCustomTranscriptionKey?.();
        } catch (err) {
          logger.debug(
            "Failed to get custom transcription key via IPC",
            { error: err?.message },
            "transcription"
          );
        }
      }
      apiKey = apiKey?.trim() || "";

      logger.debug(
        "Custom STT API key retrieval",
        {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
        },
        "transcription"
      );

      // For custom, we allow null/empty - the endpoint may not require auth
      if (!apiKey) {
        apiKey = null;
      }
    } else if (provider === "mistral") {
      // Prefer store value (user-entered via UI) over main process (.env)
      // to avoid stale keys in process.env after auth mode transitions
      apiKey = s.mistralApiKey;
      if (!isValidApiKey(apiKey, "mistral")) {
        apiKey = await window.electronAPI.getMistralKey?.();
      }
      if (!isValidApiKey(apiKey, "mistral")) {
        const err = new Error(
          "Mistral API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else if (provider === "corti") {
      // Tokens are minted in the main process; only verify credentials exist here
      let clientId = s.cortiClientId;
      let clientSecret = s.cortiClientSecret;
      if (!clientId?.trim() || !clientSecret?.trim()) {
        [clientId, clientSecret] = await Promise.all([
          window.electronAPI.getCortiClientId?.(),
          window.electronAPI.getCortiClientSecret?.(),
        ]);
      }
      if (!clientId?.trim() || !clientSecret?.trim()) {
        const err = new Error(
          "Corti credentials not found. Please set your Client ID and Client Secret in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
      apiKey = null;
    } else if (provider === "tinfoil") {
      apiKey = s.tinfoilApiKey;
      if (!apiKey?.trim()) {
        apiKey = await window.electronAPI.getTinfoilKey?.();
      }
      if (!apiKey?.trim()) {
        const err = new Error(
          "Tinfoil API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else if (provider === "gemini") {
      apiKey = s.geminiApiKey;
      if (!apiKey?.trim()) {
        apiKey = await window.electronAPI.getGeminiKey?.();
      }
      if (!apiKey?.trim()) {
        const err = new Error(
          "Gemini API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else if (provider === "groq") {
      // Prefer store value (user-entered via UI) over main process (.env)
      apiKey = s.groqApiKey;
      if (!isValidApiKey(apiKey, "groq")) {
        apiKey = await window.electronAPI.getGroqKey?.();
      }
      if (!isValidApiKey(apiKey, "groq")) {
        const err = new Error(
          "Groq API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else if (provider === "xai") {
      apiKey = s.xaiApiKey;
      if (!isValidApiKey(apiKey, "xai")) {
        apiKey = await window.electronAPI.getXaiKey?.();
      }
      if (!isValidApiKey(apiKey, "xai")) {
        const err = new Error(
          "xAI API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else if (provider === AZURE_SPEECH_PROVIDER_ID) {
      apiKey = s.azureSpeechApiKey?.trim();
      if (!apiKey) apiKey = (await window.electronAPI.getAzureSpeechKey?.())?.trim();
      if (!apiKey) {
        throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
          provider: AZURE_SPEECH_NAME,
          surface: "transcription",
        });
      }
    } else if (provider === "openrouter") {
      apiKey = s.openrouterApiKey;
      if (!apiKey?.trim()) {
        apiKey = await window.electronAPI.getOpenrouterKey?.();
      }
      if (!apiKey?.trim()) {
        const err = new Error(
          "OpenRouter API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else {
      // Default to OpenAI
      // Prefer store value (user-entered via UI) over main process (.env)
      // to avoid stale keys in process.env after auth mode transitions
      apiKey = s.openaiApiKey;
      if (!isValidApiKey(apiKey, "openai")) {
        apiKey = await window.electronAPI.getOpenAIKey();
      }
      if (!isValidApiKey(apiKey, "openai")) {
        const err = new Error(
          "OpenAI API key not found. Please set your API key in the .env file or Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    }

    this.cachedApiKey = apiKey;
    this.cachedApiKeyProvider = provider;
    return apiKey;
  }

  async processWithReasoningModel(text, model, agentName, config) {
    if (config?.requiresAgent) this.assertAgentAllowedByPolicy();
    logger.logReasoning("CALLING_REASONING_SERVICE", {
      model,
      agentName,
      textLength: text.length,
      hasOverrides: !!config,
    });

    const startTime = Date.now();

    try {
      const result = await ReasoningService.processText(text, model, agentName, {
        ...config,
        busyWaitMs: DICTATION_MODEL_BUSY_WAIT_MS,
      });

      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_COMPLETE", {
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        success: true,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_ERROR", {
        model,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      // A screenshot the model or transport rejects must not cost the user
      // their command — rerun it text-only, swapping in the pre-built prompt
      // that never had the screen-context suffix. Rebuilding from scratch
      // would drop the selection-edit instructions and completion marker.
      // rawScreenContext/selectionEditReachable are routing-only keys (see
      // processAgentCommand) — keep the retry config clean of them too.
      if (config?.screenContext) {
        const {
          screenContext,
          rawScreenContext,
          selectionEditReachable,
          textOnlySystemPrompt,
          ...textOnlyConfig
        } = config;
        const result = await ReasoningService.processText(text, model, agentName, {
          ...textOnlyConfig,
          busyWaitMs: DICTATION_MODEL_BUSY_WAIT_MS,
          systemPrompt: textOnlySystemPrompt ?? dictationAgentPrompt(getSettings(), agentName),
        });
        this._notifyScreenContextSkipped();
        return result;
      }

      throw error;
    }
  }

  // Assistant-first banking: the command is answered in the agent window with
  // the chat's tools and memory once transcription completes; nothing types
  // at the cursor. The transcript flows back as the result text so history
  // and previews stay truthful.
  _bankAssistantDirective(transcript, config, selectedContext) {
    if (!this.isProcessing) return;
    this.pendingAssistantConversation = {
      transcript,
      // resolveReasoningRoute mirrors an attached screenContext into
      // rawScreenContext (same object), so the raw carry is the single source
      // to read — it also survives when this attach gate dropped the image
      // (the assistant re-decides for its own request).
      screenContext: config?.rawScreenContext ?? null,
      ...(selectedContext ? { selectedContext } : {}),
    };
  }

  // Consume the directives banked during reasoning so that exactly one
  // transcription result — batch or streaming — carries them.
  _takePendingResultExtras() {
    const extras = {
      ...(this.pendingAssistantConversation
        ? { assistantConversation: this.pendingAssistantConversation }
        : {}),
      ...(this.pendingSelectionEdit ? { selectionEdit: this.pendingSelectionEdit } : {}),
      ...(this.pendingCleanupFailure ? { cleanupFailure: this.pendingCleanupFailure } : {}),
    };
    this.pendingAssistantConversation = null;
    this.pendingSelectionEdit = null;
    this.pendingCleanupFailure = null;
    return extras;
  }

  // Assistant-first commands make no LLM call here — the agent window resolves
  // the Voice Assistant scope itself — so the org policy guard must run at bank time.
  _bankPanelAgentCommand(text, agentName, config, { selectedText } = {}) {
    this.assertAgentAllowedByPolicy();
    const settings = getSettings();
    const command = this.voiceAgentRequested
      ? text
      : stripAgentAddress(
          text,
          agentName,
          config?.wakeWordLanguage ?? resolveWakeWordLanguage(settings),
          config?.snippets ?? settings.snippets
        );
    // Text selected in another app goes with the command as its selected
    // context, the way the agent window carries one.
    this._bankAssistantDirective(
      command,
      config,
      selectedText === undefined
        ? undefined
        : { text: selectedText, sourceMessageId: "", source: "external" }
    );
    return text;
  }

  async processAgentCommand(text, model, agentName, config, wasCancelled = neverCancelled) {
    if (wasCancelled()) return text;

    let capture;
    try {
      capture = await this.consumeSelectionCapture();
    } catch (cause) {
      const error = new Error(
        `Selection edit could not safely read the selection: ${cause.message}`
      );
      error.code = "SELECTION_EDIT_CAPTURE_FAILED";
      error.messageKey = "hooks.audioRecording.selectionEditing.unavailable";
      error.selectionEditFatal = true;
      error.cause = cause;
      throw error;
    }
    if (wasCancelled()) return text;

    const captureDisposition = getSelectionCaptureDisposition(capture);

    if (!config?.selectionEditReachable) {
      // No in-place editor: the assistant never types, so only a readable
      // selection rides along; every other capture sends the plain command.
      return this._bankPanelAgentCommand(text, agentName, config, {
        selectedText:
          captureDisposition === "selection" && typeof capture?.text === "string"
            ? capture.text
            : undefined,
      });
    }

    if (capture?.status === "too_large") {
      // A large selection definitely exists, so running the command as plain
      // agent dictation would paste over it — the one capture failure that
      // must not fall through.
      const error = new Error(
        `Selected text exceeds the ${capture.maxCharacters || 6000} character limit`
      );
      error.code = "SELECTION_EDIT_TOO_LARGE";
      error.messageKey = "hooks.audioRecording.selectionEditing.tooLarge";
      error.selectionEditFatal = true;
      throw error;
    }

    if (captureDisposition === "standalone") {
      return this._bankPanelAgentCommand(text, agentName, config);
    }

    if (capture?.status !== "selected") {
      // A captured target changing, a synthetic-copy failure, or an unexpected
      // accessibility result is ambiguous: a normal agent paste could overwrite
      // unrelated selected text. Abort instead of falling through.
      const error = new Error("Selection edit could not safely verify the selected text");
      error.code = "SELECTION_EDIT_CAPTURE_FAILED";
      error.messageKey =
        captureDisposition === "changed"
          ? "hooks.audioRecording.selectionEditing.changed"
          : "hooks.audioRecording.selectionEditing.unavailable";
      error.selectionEditFatal = true;
      throw error;
    }

    const toneStyle = await this.consumeToneStyle();

    // These are routing directives for this method, not reasoning options —
    // strip them before the config reaches ReasoningService.
    const { selectionEditReachable, rawScreenContext, wakeWordLanguage, ...reasoningOptions } =
      config ?? {};
    const selectionConfig = {
      ...reasoningOptions,
      maxTokens: Math.max(config?.maxTokens || 0, 8192),
      contextSize: Math.max(config?.contextSize || 0, 16384),
      temperature: config?.temperature ?? 0.2,
      requireCompleteOutput: true,
    };
    const isLocalSelection = config?.provider === "local";
    const toneSentence = toneStyle ? selectionEditToneSentence(toneStyle) : "";
    const withToneSentence = (prompt) =>
      toneSentence ? `${String(prompt ?? "").trim()}\n\n${toneSentence}` : prompt;
    let userPrompt;
    let completionMarker;
    if (isLocalSelection) {
      const settings = getSettings();
      selectionConfig.systemPrompt = buildLocalSelectionEditSystemPrompt({
        customPrompt: (settings.customPrompts.dictationAgent || "").replace(
          /\{\{agentName\}\}/g,
          agentName?.trim() || "Assistant"
        ),
        dictionary: getLlmDictionaryWords(settings, { includeTriggers: true }),
        toneSentence,
      });
      selectionConfig.responseFormat = SELECTION_EDIT_RESPONSE_FORMAT;
      selectionConfig.disableThinking = true;
      const instruction = this.voiceAgentRequested
        ? text
        : stripAgentAddressPreservingFormatting(
            text,
            agentName,
            wakeWordLanguage ?? resolveWakeWordLanguage(settings),
            config?.snippets ?? settings.snippets
          );
      userPrompt = buildLocalSelectionEditUserPrompt(instruction, capture.text);
    } else {
      completionMarker = createSelectionCompletionMarker();
      selectionConfig.systemPrompt = buildSelectionEditSystemPrompt(
        withToneSentence(config?.systemPrompt),
        completionMarker
      );
      if (selectionConfig.textOnlySystemPrompt) {
        // The text-only retry prompt must carry the same selection-edit
        // instructions and marker, or a rejected screenshot loses the command.
        selectionConfig.textOnlySystemPrompt = buildSelectionEditSystemPrompt(
          withToneSentence(selectionConfig.textOnlySystemPrompt),
          completionMarker
        );
      }
      userPrompt = buildSelectionEditUserPrompt(text, capture.text);
    }

    try {
      const result = await this.processWithReasoningModel(
        userPrompt,
        model,
        agentName,
        selectionConfig
      );
      if (wasCancelled()) return text;
      if (!isSelectionQuestionResponse(result, completionMarker)) {
        const replacement = isLocalSelection
          ? extractLocalSelectionEditReplacement(result)
          : extractSelectionEditReplacement(result, completionMarker);
        this.pendingSelectionEdit = { sessionId: capture.sessionId };
        return replacement;
      }
    } catch (cause) {
      const error = Object.assign(new Error(`Selection edit failed: ${cause.message}`), cause);
      const failure =
        SELECTION_EDIT_FAILURE_COPY[cause.messageKey] || SELECTION_EDIT_FAILURE_COPY[cause.code];
      error.code = cause.code || "SELECTION_EDIT_REASONING_FAILED";
      error.messageKey = failure
        ? `hooks.audioRecording.selectionEditing.${failure}`
        : cause.messageKey || "hooks.audioRecording.selectionEditing.reasoningFailed";
      error.selectionEditFatal = true;
      error.cause = cause;
      throw error;
    }

    // The editor judged the command a question about the selection: answer it
    // in the agent window with the selection as context, leaving it untouched.
    return this._bankPanelAgentCommand(text, agentName, config, {
      selectedText: capture.text,
    });
  }

  async isReasoningAvailable() {
    if (typeof window === "undefined") {
      return false;
    }

    const s = getSettings();
    const useReasoning =
      !!s.useCleanupModel || dictationAgentReachable(s) || translationChainReachable(s);
    const now = Date.now();
    const cacheValid =
      this.reasoningAvailabilityCache &&
      now < this.reasoningAvailabilityCache.expiresAt &&
      this.cachedReasoningPreference === useReasoning;

    if (cacheValid) {
      return this.reasoningAvailabilityCache.value;
    }

    logger.logReasoning("REASONING_STORAGE_CHECK", {
      useReasoning,
    });

    if (!useReasoning) {
      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }

    if (s.useCleanupModel && isCloudCleanupMode()) {
      this.reasoningAvailabilityCache = {
        value: true,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return true;
    }

    try {
      const isAvailable = await ReasoningService.isAvailable();

      logger.logReasoning("REASONING_AVAILABILITY", {
        isAvailable,
        reasoningEnabled: useReasoning,
        finalDecision: useReasoning && isAvailable,
      });

      this.reasoningAvailabilityCache = {
        value: isAvailable,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;

      return isAvailable;
    } catch (error) {
      logger.logReasoning("REASONING_AVAILABILITY_ERROR", {
        error: error.message,
        stack: error.stack,
      });

      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }
  }

  // One cleanup call, recorded as a "cleanup" step. `cleanup.mode` is
  // "cloudReason" (OpenWhispr Cloud's cleanup endpoint, with the path's STT
  // metadata in `cleanup.meta`) or "model" (the cleanup model through
  // ReasoningService with `cleanupConfig`). Resolves the reply, or null when
  // there is nothing to call. Shared by the translation chain and styles.
  async _runCleanupStep(
    currentText,
    { settings, agentName, cleanup, cleanupConfig, recordStep = passthroughStep }
  ) {
    if (cleanup.mode === "cloudReason") {
      // Cloud builds the prompt; the request still carries cleanup's word set:
      // the request's own snapshot, flat (Cloud never gets the grouping), the
      // user's own words in customDictionary and teammates' in sharedDictionary.
      const dictionary = cleanupConfig?.cleanupDictionary ?? selectCleanupDictionary(settings);
      return recordStep(
        "cleanup",
        {
          provider: "openwhispr",
          prompt: SERVER_PROMPT_REF,
          detail: { dictionaryScope: dictionary.scope },
        },
        async (dispatched) => {
          const customPrompt = this.getCustomPrompt();
          const reasonResult = await withSessionRefresh(async () => {
            const res = await window.electronAPI.cloudReason(currentText, {
              agentName,
              promptMode: "cleanup",
              purpose: "cleanup",
              ...toCloudDictionaryFields(dictionary.words, settings),
              customPrompt,
              language: this.getCleanupLanguage(settings),
              locale: settings.uiLanguage || "en",
              ...(cleanup.meta || {}),
            });
            if (!res.success) {
              const err = new Error(res.error || "Cloud reasoning failed");
              err.code = res.code;
              throw err;
            }
            return res;
          });
          dispatched({ model: reasonResult.model });
          if (!customPrompt && hasTextContent(reasonResult.text)) {
            return finishCleanupOutput(currentText, reasonResult.text);
          }
          return reasonResult.success && reasonResult.text ? reasonResult.text : null;
        }
      );
    }
    const cleanupModel = cleanup.model;
    if (cleanupModel) {
      return recordStep("cleanup", cleanupStepMeta(cleanupConfig), (dispatched) =>
        this.processWithReasoningModel(currentText, cleanupModel, agentName, {
          ...cleanupConfig,
          onDispatch: dispatched,
        })
      );
    }
    return null;
  }

  // Cleanup-then-translate chain shared by batch, cloud, and streaming paths: Step 1
  // (optional cleanup) soft-fails to input; Step 2 translates unless source === target.
  // `recordStep` (from the post-transcription boundary) records each call it makes.
  async runTranslationChain({
    text,
    settings,
    agentName,
    route,
    cleanup,
    recordStep = passthroughStep,
  }) {
    const runCleanup = (currentText) =>
      this._runCleanupStep(currentText, {
        settings,
        agentName,
        cleanup,
        cleanupConfig: route.cleanupConfig,
        recordStep,
      });

    const runTranslate = async (currentText) =>
      recordStep("translation", {}, (dispatched) =>
        this.processWithReasoningModel(currentText, route.model, agentName, {
          ...route.config,
          onDispatch: dispatched,
        })
      );

    try {
      const chainResult = await executeTranslationChain({
        text,
        cleanupReachable: route.cleanupReachable,
        cleanupIsCloud: cleanup.mode === "cloudReason",
        runCleanup,
        runTranslate,
        shouldTranslate: shouldRunTranslateStep(
          settings.translationSourceLanguage,
          settings.translationTargetLanguage
        ),
        translateIsCloud: route.config?.provider === "openwhispr",
        onCleanupError: (cleanupError) => {
          const { level = "error", channel, extra } = cleanup.log || {};
          logger[level](
            "Cleanup step failed in translation chain, translating raw transcript",
            { ...(extra || {}), error: cleanupError.message },
            channel
          );
          // The chain translates the raw transcript, so the dropped cleanup has to
          // surface the same toast the cleanup route raises (#2091).
          this.pendingCleanupFailure = cleanupFailureFromError(cleanupError);
        },
        onEmptyTranslate: () => {
          const { channel } = cleanup.log || {};
          logger.warn("Translation step returned empty text, keeping previous text", {}, channel);
          this.notifyTranslationFallback("failed");
        },
        // No fallback toast here: an echoed translation usually means the dictation was
        // already in the target language, which the current app treats as silent success.
        onUnchangedTranslate: () => {
          const { channel } = cleanup.log || {};
          logger.warn("Translation step returned unchanged text, keeping source text", {}, channel);
        },
      });
      this.translationApplied = chainResult.translated;
      return chainResult;
    } catch (translateError) {
      // Translate step threw: raw text is still pasted by the caller. Surface the failure.
      this.notifyTranslationFallback("failed");
      throw translateError;
    }
  }

  // The post-speech-to-text boundary for this manager's dictations (see
  // helpers/postTranscription.ts for the contract). `run` routes on `rawText`
  // and works on `workingText`; it returns the text to paste before the
  // Chinese script pass, which the boundary applies last. Returns
  // `{ text, trace }`; the trace travels on the result object.
  //
  // A styled recording (Stage 3) is its own intent: the path's `run` is
  // replaced by the style route, so batch, Cloud, streaming and the
  // streaming→batch fallback each apply the style exactly once (this boundary
  // runs once per recording). `cleanupRoute` is how the path cleans up:
  // `{ mode: "cloudReason", meta }` on the Cloud and streaming paths that call
  // Cloud's cleanup endpoint directly, otherwise the cleanup model.
  async postTranscribe(
    rawText,
    {
      source,
      settings = getSettings(),
      wasCancelled = neverCancelled,
      stt = null,
      detectedLanguage,
      run,
      cleanupRoute = null,
    }
  ) {
    const agentName = currentAgentName();
    // This recording's run, begun when it started; a path that never began one
    // begins it now, alongside the model call.
    const stepHistoryRun = this.stepHistoryRunPromise || requestStepHistoryRun();
    const targetApp = await this.getRecordingTargetApp();
    const style = this.getActiveRecordingStyle();
    const result = await runPostTranscription(rawText, {
      context: {
        targetApp,
        voiceAgentRequested: this.voiceAgentRequested,
        translationRequested: this.translationRequested,
        ...(style
          ? {
              style: { id: style.id, runMode: style.runMode },
              appScopedGlossary: style.appGlossary !== false,
            }
          : {}),
      },
      glossary: getGlossarySnapshot(),
      snippets: settings?.snippets,
      stt,
      // A styled recording never wakes the assistant, as a translation never does.
      detectWakeWord: style
        ? null
        : (text) =>
            !!agentName &&
            detectAgentName(
              text,
              agentName,
              resolveWakeWordLanguage(settings, detectedLanguage, text),
              settings?.snippets
            ),
      run: style
        ? (args) =>
            this.runStyleRoute(args, { style, settings, source, wasCancelled, cleanupRoute })
        : run,
      finalize: (text) => this.finalizeChineseScript(text, settings),
      wasCancelled,
    });
    const runId = await settleStepHistoryRun(stepHistoryRun);
    if (runId) result.trace.runId = runId;
    // Rule ids and counts only: the trace holds dictated text and never reaches a log.
    const glossary = summarizeGlossaryTrace(result.trace);
    if (glossary.fired > 0) {
      logger.info("Glossary corrections applied", { source, runId, ...glossary }, "transcription");
    } else {
      logger.debug(
        "Glossary: no corrections",
        { source, runId, ...glossary, targetApp: result.trace.context.targetApp },
        "transcription"
      );
    }
    return result;
  }

  // Runs wherever a dictation's route is decided, with the reachability that
  // decision used. The notice reaches the user through the result extras.
  _noteCleanupRoute(settings, { kind, cleanupReachable }) {
    const { forget, notice } = cleanupUnconfiguredNotice(this._shownCleanupSetupKey, {
      // A translation runs its cleanup step first, so a blocked one is skipped too.
      skipped:
        kind === "skip" ||
        (kind === "translation" &&
          !!settings.policyBlockedLocalScopes?.includes("dictationCleanup")),
      cleanupReachable,
      settings,
    });
    if (forget) this._shownCleanupSetupKey = null;
    if (notice && !this.pendingCleanupFailure) this.pendingCleanupFailure = notice;
  }

  // A BYOK cleanup model is selected, but the availability check found no API key
  // for any provider, so this one has none either. Reports the failure the cleanup
  // route raises when it runs, as the Cloud and streaming paths already do.
  _noteMissingCleanupKey(settings) {
    const cleanup = selectResolvedLLMConfig(settings, "dictationCleanup");
    if (cleanup.mode !== "providers" || cleanup.provider === "custom") return;
    this.pendingCleanupFailure = cleanupFailureFromError(
      providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
        provider: getProviderDisplayName(cleanup.provider),
        surface: "llm",
      })
    );
  }

  // The renderer confirms an unconfigured-cleanup notice once it is on screen, so
  // a dictation cancelled or discarded before then never uses up the warning.
  markCleanupNoticeShown(failure) {
    if (failure?.setupKey) this._shownCleanupSetupKey = failure.setupKey;
  }

  // The style route, inside the boundary's `run`: two steps (cleanup with the
  // prompt in use, then the restyle) or one step (the cleanup prompt plus the
  // style), whenever a model is reachable for the cleanup scope, even with
  // cleanup switched off (then it restyles the corrected transcript). A
  // failed restyle pastes the cleaned text and says so; a failed cleanup
  // restyles the corrected transcript; no model keeps today's behaviour (the
  // corrected transcript) with the same notice. Never the wake word or a
  // selection edit: a styled recording is its own intent.
  async runStyleRoute(
    { workingText, recordStep, setRoute },
    { style, settings = getSettings(), source, wasCancelled = neverCancelled, cleanupRoute = null }
  ) {
    const input = typeof workingText === "string" ? workingText.trim() : "";
    if (!input || wasCancelled()) return input;
    if (!isStyleReachable(settings)) {
      logger.logReasoning("STYLE_SKIPPED", { reason: "No model for the cleanup scope", source });
      setRoute("none");
      this.notifyStyleFallback(style, "unreachable");
      return input;
    }
    setRoute("style");
    const agentName = currentAgentName();
    const cleanupConfig = buildDictationCleanupConfig(settings);
    const cleanupModel = getEffectiveCleanupModel() || "";
    const cleanupOn = !!settings.useCleanupModel;
    logger.logReasoning("STYLE_ROUTE", {
      source,
      styleId: style.id,
      runMode: cleanupOn ? style.runMode : "two-step",
      cleanupOn,
      textLength: input.length,
    });
    let styleFailed = false;
    const started = performance.now();
    const result = await runStyledDictation({
      text: input,
      style,
      settings,
      agentName,
      cleanupOn,
      recordStep,
      process: (text, model, name, config) =>
        this.processWithReasoningModel(text, model, name, config),
      runCleanup: (text) =>
        // Cloud's cleanup endpoint only when Cloud is the cleanup provider;
        // otherwise the cleanup model the user chose.
        cleanupRoute?.mode === "cloudReason" && isCloudCleanupMode()
          ? this._runCleanupStep(text, {
              settings,
              agentName,
              cleanup: cleanupRoute,
              cleanupConfig,
              recordStep,
            })
          : recordStep("cleanup", cleanupStepMeta(cleanupConfig), (dispatched) =>
              this.processWithReasoningModel(text, cleanupModel, agentName, {
                ...cleanupConfig,
                onDispatch: dispatched,
              })
            ),
      onCleanupError: (error) => {
        if (wasCancelled()) return;
        logger.warn(
          "Cleanup failed in a styled dictation, restyling the transcript",
          { source, error: error?.message },
          "transcription"
        );
        this.pendingCleanupFailure = cleanupFailureFromError(error);
      },
      onStyleError: (error) => {
        styleFailed = true;
        if (wasCancelled()) return;
        logger.warn(
          "Style not applied, keeping the cleaned text",
          { source, styleId: style.id, error: error?.message ?? "empty reply" },
          "transcription"
        );
      },
      wasCancelled,
    });
    if (styleFailed && !wasCancelled()) this.notifyStyleFallback(style, "failed");
    logger.logReasoning("STYLE_ROUTE_COMPLETE", {
      source,
      styleId: style.id,
      mode: result.mode,
      applied: result.applied,
      cleaned: result.cleaned,
      durationMs: Math.round(performance.now() - started),
      resultLength: result.text.length,
    });
    return hasTextContent(result.text) ? result.text : input;
  }

  // Batch dictation's boundary call: local, BYOK, proxied and local-fallback
  // transcripts. Returns `{ text, trace }`. A selection edit that fails keeps
  // its transcript on the error, for the failed History row (#2678).
  async processTranscription(text, source, wasCancelled = neverCancelled, stt = null) {
    try {
      return await this.postTranscribe(text, {
        source,
        wasCancelled,
        stt,
        run: ({ rawText, workingText, recordStep, setRoute }) =>
          this.processTranscriptionCore(rawText, source, wasCancelled, {
            workingText,
            recordStep,
            setRoute,
          }),
      });
    } catch (error) {
      attachTranscript(error, text);
      throw error;
    }
  }

  // Routes on `text` (the raw transcript: wake word, voice assistant,
  // translation) and runs cleanup, translation or the agent on `workingText`
  // (the glossary-corrected transcript; the raw one when called directly).
  // Every fallback keeps the working text.
  async processTranscriptionCore(
    text,
    source,
    wasCancelled = neverCancelled,
    { workingText, recordStep = passthroughStep, setRoute = () => {} } = {}
  ) {
    const normalizedText = typeof text === "string" ? text.trim() : "";
    const input = typeof workingText === "string" ? workingText.trim() : normalizedText;

    if (!normalizedText) {
      logger.logReasoning("TRANSCRIPTION_EMPTY_SKIPPING_REASONING", {
        source,
        reason: "Empty text after normalization",
      });
      return normalizedText;
    }
    if (wasCancelled()) return input;

    logger.logReasoning("TRANSCRIPTION_RECEIVED", {
      source,
      text: logText(normalizedText),
      timestamp: new Date().toISOString(),
    });

    const cleanupModel = getEffectiveCleanupModel();
    const isCloud = isCloudCleanupMode();
    const settings = getSettings();
    const cleanupProvider = settings.cleanupProvider || "auto";
    const cleanupReachable = !!settings.useCleanupModel && (!!cleanupModel || isCloud);
    const agentReachable = dictationAgentReachable(settings);
    const agentName = currentAgentName();
    const blockedAgentCommand =
      isAgentScopeBlocked(settings) &&
      !this.translationRequested &&
      !!agentName &&
      detectAgentName(
        normalizedText,
        agentName,
        resolveWakeWordLanguage(settings, undefined, normalizedText),
        settings.snippets
      );
    if (
      !cleanupReachable &&
      !agentReachable &&
      !blockedAgentCommand &&
      !(this.translationRequested && translationChainReachable(settings)) &&
      // A voice-assistant command always routes: standalone commands go to the
      // assistant, which reports a missing model in-conversation.
      !this.voiceAgentRequested
    ) {
      logger.logReasoning("REASONING_SKIPPED", {
        reason: "No cleanup or dictation-agent model available",
      });
      setRoute("none");
      this._noteCleanupRoute(settings, { kind: "skip", cleanupReachable });
      return input;
    }

    const useReasoning =
      this.voiceAgentRequested || blockedAgentCommand || (await this.isReasoningAvailable());
    if (wasCancelled()) return input;

    logger.logReasoning("REASONING_CHECK", {
      useReasoning,
      cleanupModel,
      cleanupProvider,
      agentName,
    });
    // Nothing can run cleanup although the assistant could, so no route is decided.
    if (!useReasoning) {
      this._noteCleanupRoute(settings, { kind: "skip", cleanupReachable });
      if (cleanupReachable) this._noteMissingCleanupKey(settings);
    }

    if (useReasoning) {
      let route;
      try {
        const screenContext = this.voiceAgentRequested ? await this.consumeScreenContext() : null;
        route = resolveReasoningRoute(
          normalizedText,
          settings,
          agentName,
          this.voiceAgentRequested,
          this.translationRequested,
          screenContext
        );
        setRoute(route.kind);
        if (this.translationRequested && route.kind !== "translation") {
          this.notifyTranslationFallback("unreachable");
        }
        this._noteCleanupRoute(settings, route);
        if (route.kind === "skip") return input;

        if (route.kind === "translation") {
          const { text: translatedText } = await this.runTranslationChain({
            text: input,
            settings,
            agentName,
            route,
            cleanup: {
              mode: "model",
              model: cleanupModel,
              log: { level: "warn", channel: "notes", extra: { source } },
            },
            recordStep,
          });

          logger.logReasoning("REASONING_SUCCESS", {
            result: logText(translatedText),
            processingTime: new Date().toISOString(),
          });

          return translatedText;
        }

        const targetModel = route.kind === "agent" ? route.model : cleanupModel;
        const reasoningConfig =
          route.kind === "cleanup"
            ? { ...route.config, toneStyle: await this.consumeToneStyle() }
            : route.config;

        logger.logReasoning("SENDING_TO_REASONING", {
          preparedTextLength: input.length,
          model: targetModel,
          provider: route.config?.provider || cleanupProvider,
          path: route.kind,
          disableThinking: reasoningConfig?.disableThinking,
        });

        const result =
          route.kind === "agent"
            ? await recordStep("agent", {}, (dispatched) =>
                this.processAgentCommand(
                  input,
                  targetModel,
                  agentName,
                  {
                    ...reasoningConfig,
                    requiresAgent: true,
                    onDispatch: dispatched,
                  },
                  wasCancelled
                )
              )
            : await recordStep("cleanup", cleanupStepMeta(reasoningConfig), (dispatched) =>
                this.processWithReasoningModel(input, targetModel, agentName, {
                  ...reasoningConfig,
                  onDispatch: dispatched,
                })
              );

        logger.logReasoning("REASONING_SUCCESS", {
          result: logText(result),
          processingTime: new Date().toISOString(),
        });

        // A blank reply must not wipe the dictation — keep the transcript (#1616).
        return hasTextContent(result) ? result : input;
      } catch (error) {
        if (error.selectionEditFatal) throw error;
        if (wasCancelled()) return input;
        logger.logReasoning("REASONING_FAILED", {
          error: error.message,
          stack: error.stack,
          fallbackToCleanup: true,
        });
        logger.warn("Reasoning failed", { source, error: error.message }, "notes");
        if (route?.kind === "cleanup") this.pendingCleanupFailure = cleanupFailureFromError(error);
        if (route?.kind === "agent") this._notifyAgentReasoningFailed();
      }
    } else {
      setRoute("none");
    }

    logger.logReasoning("USING_STANDARD_CLEANUP", {
      reason: useReasoning ? "Reasoning failed" : "Reasoning not enabled",
    });

    // The corrected transcript is the floor: a failed call never undoes the glossary.
    return input;
  }

  shouldStreamTranscription(model, provider) {
    if (provider !== "openai") {
      return false;
    }
    const normalized = typeof model === "string" ? model.trim() : "";
    if (!normalized || normalized === "whisper-1") {
      return false;
    }
    if (
      normalized === "gpt-transcribe" ||
      normalized === "gpt-4o-transcribe" ||
      normalized === "gpt-4o-transcribe-diarize"
    ) {
      return true;
    }
    return normalized.startsWith("gpt-4o-mini-transcribe");
  }

  async processWithOpenWhisprCloud(audioBlob, metadata = {}, wasCancelled = neverCancelled) {
    if (!navigator.onLine) {
      const err = new Error("You're offline. Cloud transcription requires an internet connection.");
      err.code = "OFFLINE";
      err.messageKey = "hooks.audioRecording.errorDescriptions.offline";
      throw err;
    }

    const timings = {};
    const settings = getSettings();
    const isCloudCleanup = isCloudCleanupMode();
    const language = getBaseLanguageCode(this.getEffectiveSttLanguage(settings));

    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioSizeBytes = audioBlob.size;
    const audioFormat = audioBlob.type;
    const opts = {};
    const analyticsOccurredAt = new Date(metadata.analyticsOccurredAt || Date.now());
    if (language) opts.language = language;
    const streamingFallbackReason =
      metadata.streamingFallbackReason ?? this.consumeStreamingFallbackReason(settings);
    if (streamingFallbackReason) opts.streamingFallbackReason = streamingFallbackReason;
    if (metadata.orukeetLanguageRouting)
      opts.orukeetLanguageRouting = metadata.orukeetLanguageRouting;
    if (metadata.orukeetCleanup) opts.orukeetCleanup = metadata.orukeetCleanup;
    // Orukeet's audio estimate rides along for the backend's per-user gate
    // only. It is never the declared `language`: /api/transcribe picks models
    // by declared language, and the fallback must be the request the user
    // would make without Orukeet.
    const detectedLanguageFields = metadata.detectedLanguageFields || {};
    Object.assign(opts, detectedLanguageFields);
    if (analyticsSyncEnabled(settings)) {
      opts.analyticsOccurredAt = analyticsOccurredAt.toISOString();
      opts.localDate = localDateKey(analyticsOccurredAt);
    }
    // Only cloud cleanup writes a combined STT log; translation alone does not.
    // A voice assistant recording never runs cleanup, so this upload is its log.
    if (settings.useCleanupModel && isCloudCleanup && !this.voiceAgentRequested) {
      opts.sendLogs = "false";
    }

    // Cloud picks its model server-side, so the hint list is budgeted to the
    // tightest cap a Whisper backend applies (see resolveHintTarget). Its Gemini
    // route keeps the first PROMPT_HEAD_TERMS terms, which a tail prompt opens
    // with teammates' shared words, so they stop before the total reaches it.
    const hintTarget = resolveHintTarget({ engine: "cloud" });
    const sentHints = this.getSttHintPrompt(settings, {
      maxChars: hintTarget.maxChars,
      order: hintTarget.order,
      shared: { totalTerms: PROMPT_HEAD_TERMS },
    });
    if (sentHints.prompt) opts.prompt = sentHints.prompt;

    // Use withSessionRefresh to handle AUTH_EXPIRED automatically
    const transcriptionStart = performance.now();
    const result = await withSessionRefresh(async () => {
      const res = await window.electronAPI.cloudTranscribe(arrayBuffer, opts);
      if (!res.success) {
        const err = new Error(res.error || "Cloud transcription failed");
        err.code = res.code;
        // The recording is kept by saveFailedTranscription, so point the user
        // at History rather than leaving them with a raw main-process string.
        if (res.code === "CHUNK_LOSS_EXCEEDED") {
          err.messageKey = "hooks.audioRecording.errorDescriptions.chunkLoss";
        }
        throw err;
      }
      return res;
    });
    timings.transcriptionProcessingDurationMs = Math.round(performance.now() - transcriptionStart);

    if (this.isDictionaryEcho(result.text, sentHints.dictionaryPrompt, sentHints.personalPrompt)) {
      throw dictionaryEchoError();
    }
    // A hint list the model recited after the speech is dropped (#2581).
    const rawText = this.stripTrailingDictionaryEcho(result.text, sentHints.prompt);
    const post = await this.postTranscribe(rawText, {
      source: "openwhispr",
      settings,
      wasCancelled,
      detectedLanguage: result.sttLanguage,
      stt: {
        provider: result.sttProvider || "openwhispr",
        model: result.sttModel || null,
        ms: timings.transcriptionProcessingDurationMs,
      },
      // A styled recording cleans up through the same Cloud endpoint, with the
      // same metadata, as the cleanup route below.
      cleanupRoute: isCloudCleanup
        ? {
            mode: "cloudReason",
            meta: {
              streamingFallbackReason,
              orukeetLanguageRouting: metadata.orukeetLanguageRouting,
              orukeetCleanup: metadata.orukeetCleanup,
              ...detectedLanguageFields,
              sttProvider: result.sttProvider,
              sttModel: result.sttModel,
              sttProcessingMs: result.sttProcessingMs,
              sttWordCount: result.sttWordCount,
              sttLanguage: result.sttLanguage,
              audioDurationMs: result.audioDurationMs,
              audioSizeBytes,
              audioFormat,
            },
          }
        : null,
      run: async ({ rawText: routeText, workingText, recordStep, setRoute }) => {
        let processedText = workingText;
        if (!processedText) return processedText;
        const reasoningStart = performance.now();
        const agentName = getAgentName();
        const screenContext = this.voiceAgentRequested ? await this.consumeScreenContext() : null;
        const route = resolveReasoningRoute(
          routeText,
          settings,
          agentName,
          this.voiceAgentRequested,
          this.translationRequested,
          screenContext,
          result.sttLanguage
        );
        setRoute(route.kind);
        if (this.translationRequested && route.kind !== "translation") {
          this.notifyTranslationFallback("unreachable");
        }
        this._noteCleanupRoute(settings, route);
        // A cancelled upload can still resolve after the next dictation started;
        // reading the tone then would take that dictation's app.
        const toneStyle =
          route.kind === "cleanup" && !wasCancelled() ? await this.consumeToneStyle() : null;

        try {
          if (route.kind === "agent") {
            const reasoned = await recordStep("agent", {}, (dispatched) =>
              this.processAgentCommand(
                processedText,
                route.model,
                agentName,
                {
                  ...route.config,
                  requiresAgent: true,
                  onDispatch: dispatched,
                },
                wasCancelled
              )
            );
            if (hasTextContent(reasoned)) processedText = reasoned;
          } else if (route.kind === "cleanup" && isCloudCleanup) {
            // The route's one snapshot of cleanup's word set, flat: Cloud never gets the grouping.
            const dictionary = route.config?.cleanupDictionary ?? selectCleanupDictionary(settings);
            const cleaned = await recordStep(
              "cleanup",
              {
                provider: "openwhispr",
                prompt: SERVER_PROMPT_REF,
                detail: { dictionaryScope: dictionary.scope },
              },
              async (dispatched) => {
                const customPrompt = this.getCustomPrompt();
                const reasonResult = await withSessionRefresh(async () => {
                  const res = await window.electronAPI.cloudReason(processedText, {
                    agentName,
                    promptMode: "cleanup",
                    purpose: "cleanup",
                    ...toCloudDictionaryFields(dictionary.words, settings),
                    customPrompt,
                    ...toneStyle,
                    language: this.getCleanupLanguage(settings),
                    locale: settings.uiLanguage || "en",
                    streamingFallbackReason,
                    orukeetLanguageRouting: metadata.orukeetLanguageRouting,
                    orukeetCleanup: metadata.orukeetCleanup,
                    ...detectedLanguageFields,
                    sttProvider: result.sttProvider,
                    sttModel: result.sttModel,
                    sttProcessingMs: result.sttProcessingMs,
                    sttWordCount: result.sttWordCount,
                    sttLanguage: result.sttLanguage,
                    audioDurationMs: result.audioDurationMs,
                    audioSizeBytes,
                    audioFormat,
                  });
                  if (!res.success) {
                    const err = new Error(res.error || "Cloud reasoning failed");
                    err.code = res.code;
                    throw err;
                  }
                  return res;
                });
                dispatched({ model: reasonResult.model });

                // Cloud cleanup can return success with empty text; keep the
                // transcription instead of wiping it.
                if (!(reasonResult.success && hasTextContent(reasonResult.text))) return null;
                if (!customPrompt) return finishCleanupOutput(processedText, reasonResult.text);
                return reasonResult.text;
              }
            );
            if (hasTextContent(cleaned)) processedText = cleaned;
          } else if (route.kind === "cleanup") {
            const effectiveModel = getEffectiveCleanupModel();
            if (effectiveModel) {
              const reasoned = await recordStep(
                "cleanup",
                cleanupStepMeta(route.config),
                (dispatched) =>
                  this.processWithReasoningModel(processedText, effectiveModel, agentName, {
                    ...route.config,
                    toneStyle,
                    onDispatch: dispatched,
                  })
              );
              if (hasTextContent(reasoned)) processedText = reasoned;
            }
          } else if (route.kind === "translation") {
            const chainResult = await this.runTranslationChain({
              text: processedText,
              settings,
              agentName,
              route,
              cleanup: isCloudCleanup
                ? {
                    mode: "cloudReason",
                    meta: {
                      streamingFallbackReason,
                      orukeetLanguageRouting: metadata.orukeetLanguageRouting,
                      orukeetCleanup: metadata.orukeetCleanup,
                      ...detectedLanguageFields,
                      sttProvider: result.sttProvider,
                      sttModel: result.sttModel,
                      sttProcessingMs: result.sttProcessingMs,
                      sttWordCount: result.sttWordCount,
                      sttLanguage: result.sttLanguage,
                      audioDurationMs: result.audioDurationMs,
                      audioSizeBytes,
                      audioFormat,
                    },
                    log: { level: "error", channel: "transcription" },
                  }
                : {
                    mode: "model",
                    model: getEffectiveCleanupModel(),
                    log: { level: "error", channel: "transcription" },
                  },
              recordStep,
            });
            processedText = resolveTranslatedText(processedText, chainResult);
          }
        } catch (reasonError) {
          if (reasonError.selectionEditFatal) {
            // Cloud already recorded this transcription under its client id; the
            // failed entry reuses it so a later retry syncs onto the same row.
            attachTranscript(reasonError, rawText, result.clientTranscriptionId);
            throw reasonError;
          }
          if (!wasCancelled()) {
            logger.error(
              "Cloud reasoning failed, using the corrected transcription",
              { error: reasonError.message },
              "transcription"
            );
            if (route.kind === "cleanup") {
              this.pendingCleanupFailure = cleanupFailureFromError(reasonError);
            }
            if (route.kind === "agent") this._notifyAgentReasoningFailed();
          }
        }
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);
        return processedText;
      },
    });
    return {
      success: true,
      text: post.text,
      rawText,
      trace: post.trace,
      source: "openwhispr",
      timings,
      limitReached: result.limitReached,
      wordsUsed: result.wordsUsed,
      wordsRemaining: result.wordsRemaining,
      clientTranscriptionId: result.clientTranscriptionId,
      analyticsOccurredAt: analyticsOccurredAt.toISOString(),
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  // Personal words first, then the active workspace's shared words; no snippet
  // triggers, which are phrases rather than terms.
  getCustomDictionaryArray() {
    return getEffectiveDictionaryWords(getSettings());
  }

  getCustomPrompt() {
    return getSettings().customPrompts.cleanup || undefined;
  }

  // Keyterm channels (Gemini, xAI, the streaming providers) cap the list at its
  // head, so they get it priority-first: typed words, the glossary's canonical
  // forms, then learned words, then teammates' shared words within the keyterm
  // providers' limits (#2855). Snippet triggers were never keyterms.
  getKeyterms() {
    return this.getDictionaryHints({
      order: "head",
      includeSnippets: false,
      shared: KEYTERM_SHARED_LIMITS,
    }).terms;
  }

  async processWithOpenAIAPI(audioBlob, metadata = {}, wasCancelled = neverCancelled) {
    const timings = {};
    let requestController = null;
    const apiSettings = getSettings();
    const language = getBaseLanguageCode(this.getEffectiveSttLanguage(apiSettings));
    const allowLocalFallback = apiSettings.allowLocalFallback;
    const fallbackModel = apiSettings.fallbackWhisperModel || "base";

    try {
      const durationSeconds = metadata.durationSeconds ?? null;
      const model = this.getTranscriptionModel();
      const provider = apiSettings.cloudTranscriptionProvider || "openai";

      logger.debug(
        "Transcription request starting",
        {
          provider,
          model,
          blobSize: audioBlob.size,
          blobType: audioBlob.type,
          durationSeconds,
          language,
        },
        "transcription"
      );

      // Managed enterprise STT outranks every personal setting.
      const managedResolution = getManagedTranscriptionResolution();
      if (managedResolution?.kind === "error") {
        throw Object.assign(new Error(managedResolution.message), {
          code: managedResolution.code,
          messageKey: managedResolution.messageKey,
        });
      }

      // Route before reading a key: the resolver's fail-closed guards name the
      // real problem (a realtime-only provider, or its missing key), whereas the
      // key read blames the OpenAI key for a provider that never uses it.
      const route = managedResolution
        ? null
        : this.resolveBatchRoute(apiSettings, model, { effectiveLanguage: language ?? "auto" });
      const apiKey = managedResolution ? null : await this.getAPIKey();
      const optimizedAudio = audioBlob;

      // Dispatch before endpoint resolution (which defaults to OpenAI and would leak
      // the key). Self-hosted wins, so a leftover proxied provider isn't diverted here.
      const proxySpec = managedResolution
        ? MANAGED_TRANSCRIPTION_SPEC
        : PROXY_TRANSCRIPTION_PROVIDERS[provider];
      if (proxySpec && (managedResolution || !isSelfHostedTranscription(apiSettings))) {
        const providerName = managedResolution ? `${managedResolution.provider}-managed` : provider;
        const call = proxySpec.ipc();
        if (!call) {
          throw new Error(`${proxySpec.displayName} transcription is unavailable in this window`);
        }
        const apiCallStart = performance.now();
        // The prompt carries the list in Whisper's tail order (personal words
        // last); Mistral's contextBias keeps the first 100 words, so it reads
        // the list priority-first (personal words first) instead.
        const proxyHints = this.getDictionaryHints({ settings: apiSettings });
        const priorityHints = this.getDictionaryHints({ settings: apiSettings, order: "head" });
        const proxyDictionaryPrompt = this.getWhisperPrompt(apiSettings, proxyHints.prompt);
        const proxyArgs = {
          audioBuffer: await optimizedAudio.arrayBuffer(),
          model,
          language,
          apiSettings,
          managedResolution,
          mimeType: optimizedAudio.type || "audio/webm",
          dictionaryPrompt: proxyDictionaryPrompt,
          priorityDictionaryPrompt: this.getWhisperPrompt(apiSettings, priorityHints.prompt),
          keyterms: this.getKeyterms()
            .map((t) => t.trim().slice(0, 50))
            .filter(Boolean)
            .slice(0, 100),
        };
        const proxyPayload = proxySpec.buildPayload(proxyArgs);
        // Managed Azure is enterprise: its failures keep their own shape.
        const classifyProxyFailure = (err) =>
          managedResolution
            ? err
            : asProviderError(err, { provider: proxySpec.displayName, surface: "transcription" });
        let result;
        try {
          result = await call(proxyPayload);
        } catch (err) {
          throw classifyProxyFailure(err);
        }
        if (result?.error) {
          // Main serialises an unclassified network failure as its bare
          // message (net::ERR_*), so classify the rebuilt error here.
          throw classifyProxyFailure(errorFromIpcResult(result));
        }
        const sendsDictionaryBias = payloadSendsDictionaryBias(proxyPayload);
        // A recital follows the order the list was sent in, which for
        // contextBias and keyterms is personal words first, not Whisper order.
        const proxyEchoPrompt = proxySpec.echoPrompt?.(proxyArgs) ?? proxyDictionaryPrompt;
        const proxyText = this.stripTrailingDictionaryEcho(
          result?.text,
          sendsDictionaryBias ? proxyEchoPrompt : null
        );
        if (!proxyText?.trim()) {
          throw emptyTranscriptError(
            `No text transcribed - ${proxySpec.displayName} response was empty`
          );
        }
        // Echoes are measured against the bias this payload actually carried
        // (Mistral's capped contextBias, the capped keyterms with up to
        // MAX_SHARED_KEYTERMS shared words, or the prompt): an echo of a capped
        // list only clears the bar against that same list. The user's own words
        // are checked on their own too (isDictionaryEcho).
        const sentDictionary = Array.isArray(proxyPayload.contextBias)
          ? proxyPayload.contextBias.join(" ")
          : Array.isArray(proxyPayload.keyterms)
            ? proxyPayload.keyterms.join(", ")
            : proxyHints.prompt;
        if (
          sendsDictionaryBias &&
          this.isDictionaryEcho(result.text, sentDictionary, proxyHints.personalPrompt)
        ) {
          throw dictionaryEchoError();
        }
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
        const reasoningStart = performance.now();
        const post = await this.processTranscription(proxyText, providerName, wasCancelled, {
          provider: providerName,
          model: result?.model || (managedResolution ? null : model),
          ms: timings.transcriptionProcessingDurationMs,
        });
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        const source = (await this.isReasoningAvailable())
          ? `${providerName}-reasoned`
          : providerName;
        return {
          success: true,
          text: post.text,
          rawText: proxyText,
          source,
          timings,
          trace: post.trace,
          // Managed audio over the upload limit is chunked; lost chunks leave a partial transcript.
          ...(result.warning ? { warning: result.warning } : {}),
        };
      }

      // Azure Speech has its own request shape (an `audio` part, a JSON
      // definition, its own key header), so it never reaches the
      // OpenAI-compatible request below.
      if (route?.transport === "azure-speech") {
        return await this.transcribeWithAzureSpeech(audioBlob, {
          route,
          apiKey,
          apiSettings,
          durationSeconds,
          timings,
          wasCancelled,
        });
      }

      // Some Custom endpoints decode the upload and reject anything that isn't
      // WAV/MP3/FLAC (Azure MAI-Transcribe via OpenRouter, for one), which
      // Chromium's WebM/Opus recordings always are. Re-encode for those rather
      // than failing the dictation; a conversion failure falls through to the
      // original bytes so this can only widen what works.
      let uploadAudio = optimizedAudio;
      if (needsWavConversion(provider, optimizedAudio.type, optimizedAudio.size)) {
        try {
          const wavAudio = await convertToWav(optimizedAudio);
          // Keep compressed recordings usable on endpoints that already accept
          // them when PCM expansion would exceed the upload limit.
          if (wavAudio.size <= byokFileSizeLimit(provider)) {
            uploadAudio = wavAudio;
          }
          logger.debug(
            "Prepared recording for custom endpoint",
            {
              fromType: optimizedAudio.type,
              fromSize: optimizedAudio.size,
              toType: uploadAudio.type,
              toSize: uploadAudio.size,
            },
            "transcription"
          );
        } catch (conversionError) {
          logger.warn(
            "WAV re-encode failed; uploading original container",
            { error: conversionError?.message, type: optimizedAudio.type },
            "transcription"
          );
        }
      }

      // Decoding can outlive cancellation and a newer recording's request.
      if (wasCancelled()) throw new DOMException("Transcription cancelled", "AbortError");

      // Main sends the request (dictationTranscriptionRequest.js); the window
      // hands it the form fields, in order, after the file.
      const fields = [];
      // Determine the correct file extension based on the blob type
      const mimeType = uploadAudio.type || "audio/webm";
      const extension = audioExtensionForMime(mimeType);

      logger.debug(
        "FormData preparation",
        {
          mimeType,
          extension,
          optimizedSize: uploadAudio.size,
          hasApiKey: !!apiKey,
        },
        "transcription"
      );

      fields.push(["model", model]);

      if (language && model !== "orukeet-v0.1.0") {
        fields.push(["language", language]);
      }

      const endpoint = this.getTranscriptionEndpoint(route);
      // OpenRouter drops `prompt` on this path (see dictionaryPromptCap), so the
      // dictionary stays on the device there and nothing can echo it back.
      const sendsDictionary = dictionaryReachesTranscriptionModel(endpoint);

      // gpt-transcribe takes the dictionary on its own keywords[] channel (see
      // dictionaryKeywords), highest priority first so the keyword cap only ever
      // drops shared words, of which it gets MAX_SHARED_KEYTERMS at most. Its
      // prompt carries only the Chinese script bias and the terms past the
      // keyword cap.
      const usesKeywords = usesTranscriptionKeywords(model);

      // Prompt budgets follow each provider's real limit (see dictionaryPromptCap):
      // Groq's 896-char request cap, the Whisper decoders' window, and a far
      // larger context guard for the 4o transcribe models, which are LLMs and
      // read the whole thing. The hint builder selects by priority within that
      // budget, leaving room for the script bias, and orders the list so Whisper
      // decoders, which read the tail, read the priority terms; teammates' shared
      // words only fill what the user's own words leave, at most
      // MAX_SHARED_KEYTERMS and on a Whisper decoder only what it reads
      // (getSttHintPrompt). The trim below is only a safety bound.
      const MAX_PROMPT_CHARS = dictionaryPromptLimit({ provider, endpoint, model });
      const hintTarget = resolveHintTarget({ engine: "byok", provider, endpoint, model });
      const sttHints = this.getSttHintPrompt(apiSettings, {
        maxChars: usesKeywords ? Infinity : MAX_PROMPT_CHARS,
        order: hintTarget.order,
      });
      const dictionary = sttHints.dictionaryPrompt;
      const trimmedPrompt = trimDictionaryPrompt(
        this.getWhisperPrompt(
          apiSettings,
          usesKeywords ? dictionaryKeywordOverflow(dictionary) : dictionary
        ),
        MAX_PROMPT_CHARS
      );
      const dictionaryPrompt = trimmedPrompt.prompt;
      // OpenRouter drops `prompt` (see dictionaryPromptCap), so nothing is sent there.
      const promptSent = Boolean(sendsDictionary && dictionaryPrompt && model !== "orukeet-v0.1.0");
      // What this request actually carried, for the echo check below: the
      // dictionary, and the user's own part of it.
      const hintsSent = (usesKeywords && sendsDictionary) || promptSent;
      const sentDictionary = hintsSent ? dictionary : null;
      const sentPersonalDictionary = hintsSent ? sttHints.personalPrompt : null;
      if (promptSent) {
        if (trimmedPrompt.truncated) {
          logger.debug(
            "Custom dictionary prompt truncated",
            {
              originalLength: trimmedPrompt.originalLength,
              truncatedLength: dictionaryPrompt.length,
              maxChars: MAX_PROMPT_CHARS,
            },
            "transcription"
          );
        }
        fields.push(["prompt", dictionaryPrompt]);
      }
      if (usesKeywords && sendsDictionary) {
        for (const keyword of dictionaryKeywords(dictionary)) {
          fields.push(["keywords[]", keyword]);
        }
      }
      // The terms the model could recite (#2581). gpt-transcribe got them as
      // keywords[] plus the prompt's overflow; when the overflow was capped,
      // count only the keywords.
      const sentDictionaryPrompt =
        usesKeywords && sendsDictionary
          ? trimmedPrompt.truncated
            ? dictionaryKeywords(dictionary).join(", ")
            : dictionary
          : promptSent
            ? dictionaryPrompt
            : null;
      const shouldStream = this.shouldStreamTranscription(model, provider);
      if (shouldStream) {
        fields.push(["stream", "true"]);
      }

      const apiCallStart = performance.now();

      logger.debug(
        "Making transcription API request",
        { endpoint, shouldStream, model, provider, hasApiKey: !!apiKey },
        "transcription"
      );

      // Build headers - only include Authorization if we have an API key
      const headers = {};
      if (apiKey) {
        // Azure OpenAI authenticates API keys via the `api-key` header, not a
        // Bearer token (which it reserves for Entra ID access tokens).
        if (isAzureOpenAIEndpoint(endpoint)) {
          headers["api-key"] = apiKey;
        } else {
          headers.Authorization = `Bearer ${apiKey}`;
        }
      }

      logger.debug(
        "STT request details",
        {
          endpoint,
          method: "POST",
          hasAuthHeader: !!apiKey,
          formDataFields: [
            "file",
            "model",
            language && language !== "auto" ? "language" : null,
            shouldStream ? "stream" : null,
          ].filter(Boolean),
        },
        "transcription"
      );

      // Name the resolved route, not cloudTranscriptionProvider: self-hosted
      // dictation keeps that setting (usually "openai") while posting to the
      // user's own server.
      const providerErrorContext = {
        provider: getTranscriptionProvider(route.provider)?.name ?? route.provider,
        selfHosted: route.provider === "self-hosted" || route.provider === "custom",
        model: route.model ?? model,
        surface: "transcription",
      };

      requestController = new AbortController();
      this._activeTranscriptionAbortController = requestController;
      let response;
      try {
        response = await sendDictationTranscription(
          {
            endpoint,
            headers,
            fields,
            file: {
              bytes: await uploadAudio.arrayBuffer(),
              name: `audio.${extension}`,
              type: mimeType,
            },
            audioSeconds: durationSeconds,
            stream: shouldStream,
            selfHosted: route.provider === "self-hosted",
            errorContext: providerErrorContext,
            // Main records how it ended (Settings › AI Connections, "Last recorded use").
            outcome: transcriptionOutcomeTag(route, apiSettings, "recognition"),
          },
          requestController.signal
        );
      } catch (err) {
        throw asProviderError(err, providerErrorContext);
      }

      const responseContentType = response.headers.get("content-type") || "";

      logger.debug(
        "Transcription API response received",
        {
          status: response.status,
          statusText: response.statusText,
          contentType: responseContentType,
          ok: response.ok,
          attempts: response.attempts,
        },
        "transcription"
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          "Transcription API error response",
          {
            status: response.status,
            errorText: redactProviderBody(errorText),
          },
          "transcription"
        );
        throw Object.assign(
          providerHttpError({
            ...providerErrorContext,
            status: response.status,
            body: errorText,
            headers: response.headers,
          }),
          batchTranscriptionHttpError(response.status, endpoint)
        );
      }

      let result;
      const contentType = responseContentType;

      if (response.streamed) {
        // Main read the stream to its terminal event (transcriptionEventStream.js).
        const streamedText = response.streamedText;
        result = { text: streamedText };
        logger.debug(
          "Streaming response parsed",
          {
            contentType,
            hasText: !!streamedText,
            textLength: streamedText?.length,
            ...(response.streamStats || {}),
          },
          "transcription"
        );
      } else {
        const rawText = await response.text();
        // The body is the transcript: its size only.
        logger.debug("Raw API response body", { fullLength: rawText.length }, "transcription");

        try {
          result = JSON.parse(rawText);
        } catch (parseError) {
          // A JSON.parse message quotes the text it choked on: its name only.
          logger.error(
            "Failed to parse JSON response",
            {
              parseError: parseError.name,
              fullLength: rawText.length,
            },
            "transcription"
          );
          throw new Error(`Failed to parse API response: ${parseError.name}`);
        }

        logger.debug(
          "Parsed transcription result",
          {
            hasText: !!result.text,
            textLength: result.text?.length,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
      }

      // Check for text - handle both empty string and missing field. ElevenLabs
      // Scribe answers silence with "[pause]" instead of an empty string.
      const spokenText = result.text?.trim();
      if (spokenText && spokenText !== "[pause]") {
        if (this.isDictionaryEcho(result.text, sentDictionary, sentPersonalDictionary)) {
          throw dictionaryEchoError();
        }
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
        const rawText = this.stripTrailingDictionaryEcho(
          result.text,
          model === "orukeet-v0.1.0" || !sendsDictionary ? null : sentDictionaryPrompt
        );

        const reasoningStart = performance.now();
        const post = await this.processTranscription(rawText, "openai", wasCancelled, {
          provider: route?.provider || provider,
          model: route?.model ?? model,
          ms: timings.transcriptionProcessingDurationMs,
        });
        const text = post.text;
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        const source = (await this.isReasoningAvailable()) ? "openai-reasoned" : "openai";
        logger.debug(
          "Transcription successful",
          {
            originalLength: result.text.length,
            processedLength: text.length,
            source,
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          },
          "transcription"
        );
        return { success: true, text, rawText, source, timings, trace: post.trace };
      } else {
        // Log at info level so it shows without debug mode
        logger.info(
          "Transcription returned empty - check audio input",
          {
            model,
            provider,
            endpoint,
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            mimeType,
            extension,
            resultText: logText(result.text),
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        throw emptyTranscriptError(
          "No text transcribed - audio may be too short, silent, or in an unsupported format"
        );
      }
    } catch (error) {
      if (error.name === "AbortError" || isTranscriptionPolicyRefusal(error)) throw error;
      if (error.selectionEditFatal) {
        throw error;
      }
      // Nothing heard is not a failure: no local fallback (Whisper invents
      // words in silence), and its code survives.
      if (error.message === "No audio detected" || error.code === EMPTY_TRANSCRIPT_CODE) {
        throw error;
      }

      const isOpenAIMode = !getSettings().useLocalWhisper;
      // A policy-blocked fallback surfaces the cloud failure, not a policy error.
      const fallbackAllowedByPolicy = isTranscriptionSelectionAllowed(usePolicyStore.getState(), {
        mode: "local",
        provider: "",
        model: fallbackModel,
      });

      if (allowLocalFallback && isOpenAIMode && fallbackAllowedByPolicy) {
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const options = { model: fallbackModel };
          if (language && language !== "auto") {
            options.language = language;
          }

          const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);

          if (result.success && result.text) {
            const post = await this.processTranscription(
              result.text,
              "local-fallback",
              wasCancelled,
              { provider: "local-whisper", model: fallbackModel }
            );
            if (post.text) {
              return {
                success: true,
                text: post.text,
                source: "local-fallback",
                trace: post.trace,
              };
            }
          }
          throw error;
        } catch (fallbackError) {
          if (isTranscriptionPolicyRefusal(fallbackError)) throw fallbackError;
          if (fallbackError.selectionEditFatal) {
            throw fallbackError;
          }
          const wrapped = new Error(
            `OpenAI API failed: ${error.message}. Local fallback also failed: ${fallbackError.message}`
          );
          // The toast renders the cloud failure, so its message params and details
          // must survive the wrap, or the copy shows a bare "{{provider}}".
          for (const key of IPC_ERROR_FIELDS) {
            if (error[key] !== undefined) wrapped[key] = error[key];
          }
          throw wrapped;
        }
      }
      throw error;
    } finally {
      if (this._activeTranscriptionAbortController === requestController) {
        this._activeTranscriptionAbortController = null;
      }
    }
  }

  // Azure Speech's fast transcription (MAI-Transcribe-2), sent through main's
  // dictation request: the same deadline, retry and Esc cancel as the
  // OpenAI-compatible providers. MAI takes WAV, MP3 or FLAC only, so a
  // recording that can't be converted fails here instead of uploading WebM.
  // The dictionary travels as its phrase list, a bias the model never
  // continues: no dictionary-echo check, which would discard a correctly
  // heard one-word dictation that equals the list.
  async transcribeWithAzureSpeech(
    audioBlob,
    { route, apiKey, apiSettings, durationSeconds = null, timings, wasCancelled }
  ) {
    const errorContext = {
      provider: AZURE_SPEECH_NAME,
      providerId: AZURE_SPEECH_PROVIDER_ID,
      selfHosted: false,
      model: route.model,
      surface: "transcription",
    };

    let uploadAudio = audioBlob;
    if (needsWavConversion(AZURE_SPEECH_PROVIDER_ID, audioBlob.type, audioBlob.size)) {
      try {
        uploadAudio = await convertToWav(audioBlob);
      } catch (conversionError) {
        logger.warn(
          "WAV re-encode failed; Azure Speech takes WAV, MP3 or FLAC only",
          { error: conversionError?.message, type: audioBlob.type },
          "transcription"
        );
        throw Object.assign(
          new Error(
            "The recording couldn't be converted for Azure Speech, which takes WAV, MP3 or FLAC."
          ),
          {
            code: "AZURE_SPEECH_CONVERSION_FAILED",
            messageKey: "hooks.audioRecording.errorDescriptions.azureSpeechConversionFailed",
          }
        );
      }
    }
    // Decoding can outlive cancellation and a newer recording's request.
    if (wasCancelled()) throw new DOMException("Transcription cancelled", "AbortError");
    // The cap is on what's sent, after conversion.
    if (uploadAudio.size > route.sizeCapBytes) {
      throw providerError(PROVIDER_ERROR_CODES.PAYLOAD_TOO_LARGE, errorContext);
    }

    const hintTarget = resolveHintTarget({ engine: "byok", provider: AZURE_SPEECH_PROVIDER_ID });
    // A phrase list counts entries, not characters: teammates' shared words
    // (#2855) fill what the user's own words leave of its 199, at most
    // MAX_SHARED_KEYTERMS of them, as on every other STT path.
    const hints = this.getDictionaryHints({
      settings: apiSettings,
      maxChars: hintTarget.maxChars,
      maxTerms: hintTarget.maxTerms,
      order: hintTarget.order,
      shared: { sharedWords: MAX_SHARED_KEYTERMS, maxTerms: hintTarget.maxTerms },
    });
    const request = buildAzureSpeechRequest({
      endpoint: route.endpoint,
      apiKey,
      model: route.model,
      locale: route.locale,
      phrases: hints.terms,
    });
    if (!request) {
      throw Object.assign(new Error("Azure Speech endpoint is invalid"), {
        code: "AZURE_SPEECH_ENDPOINT_INVALID",
      });
    }

    const { unsupported } = resolveMaiLocale(route.language);
    if (unsupported) {
      logger.info(
        "MAI-Transcribe doesn't list this language; sent without a locale (auto-detect)",
        { language: unsupported },
        "transcription"
      );
    }
    const mimeType = uploadAudio.type || "audio/wav";
    // Counts only: the phrase list is the user's dictionary.
    logger.debug(
      "Making Azure Speech transcription request",
      {
        endpoint: request.endpoint,
        model: route.model,
        locale: route.locale,
        phrases: hints.terms.length,
        phrasesNotSent: hints.entries.length - hints.terms.length,
        audioType: mimeType,
        audioBytes: uploadAudio.size,
        hasApiKey: !!apiKey,
      },
      "transcription"
    );

    const requestController = new AbortController();
    this._activeTranscriptionAbortController = requestController;
    try {
      const apiCallStart = performance.now();
      let response;
      try {
        response = await sendDictationTranscription(
          {
            ...request,
            file: {
              bytes: await uploadAudio.arrayBuffer(),
              name: `audio.${audioExtensionForMime(mimeType)}`,
              type: mimeType,
            },
            audioSeconds: durationSeconds,
            stream: false,
            selfHosted: false,
            errorContext,
            outcome: transcriptionOutcomeTag(route, apiSettings, "recognition"),
          },
          requestController.signal
        );
      } catch (err) {
        throw asProviderError(err, errorContext);
      }

      logger.debug(
        "Transcription API response received",
        { status: response.status, ok: response.ok, attempts: response.attempts },
        "transcription"
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          "Transcription API error response",
          { status: response.status, errorText: redactProviderBody(errorText) },
          "transcription"
        );
        throw providerHttpError({
          ...errorContext,
          status: response.status,
          body: errorText,
          headers: response.headers,
        });
      }

      const rawBody = await response.text();
      let answer;
      try {
        answer = JSON.parse(rawBody);
      } catch (parseError) {
        // A JSON.parse message quotes the text it choked on: its name only.
        logger.error(
          "Failed to parse JSON response",
          { parseError: parseError.name, fullLength: rawBody.length },
          "transcription"
        );
        throw new Error(`Failed to parse API response: ${parseError.name}`);
      }
      const text = parseAzureSpeechAnswer(answer);
      timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);

      if (!text) {
        // The same path as any provider's empty answer (MAI returns none for silence).
        logger.info(
          "Transcription returned empty - check audio input",
          {
            model: route.model,
            provider: AZURE_SPEECH_PROVIDER_ID,
            endpoint: request.endpoint,
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            resultKeys: Object.keys(answer || {}),
          },
          "transcription"
        );
        throw emptyTranscriptError(
          "No text transcribed - audio may be too short, silent, or in an unsupported format"
        );
      }

      const reasoningStart = performance.now();
      const post = await this.processTranscription(text, AZURE_SPEECH_PROVIDER_ID, wasCancelled, {
        provider: AZURE_SPEECH_PROVIDER_ID,
        model: route.model,
        ms: timings.transcriptionProcessingDurationMs,
      });
      timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);
      const source = (await this.isReasoningAvailable())
        ? `${AZURE_SPEECH_PROVIDER_ID}-reasoned`
        : AZURE_SPEECH_PROVIDER_ID;
      logger.debug(
        "Transcription successful",
        {
          originalLength: text.length,
          processedLength: post.text?.length ?? 0,
          source,
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
        },
        "transcription"
      );
      return { success: true, text: post.text, rawText: text, source, timings, trace: post.trace };
    } finally {
      if (this._activeTranscriptionAbortController === requestController) {
        this._activeTranscriptionAbortController = null;
      }
    }
  }

  getTranscriptionModel() {
    try {
      const s = getSettings();
      const selfHostedModel = resolveSelfHostedTranscriptionModel(s);
      if (selfHostedModel) return selfHostedModel;
      const provider = s.cloudTranscriptionProvider || "openai";
      // A streaming selection needs the provider's batch fallback. A selected
      // compatible batch model must retain its own ID, including live additions.
      const batchModel = getBatchTranscriptionModel(provider);
      const selectedModel = getTranscriptionProvider(provider)?.models.find(
        (model) => model.id === s.cloudTranscriptionModel?.trim()
      );
      if (batchModel && (!selectedModel || selectedModel.streaming)) return batchModel;
      return resolveByokModel(provider, s.cloudTranscriptionModel);
    } catch (error) {
      return "gpt-transcribe";
    }
  }

  // Local-vs-cloud is decided upstream, so useLocalWhisper is forced off here:
  // the local→cloud fallback resolves its cloud endpoint through this too.
  // `effectiveLanguage` is the translation-aware one ("auto" sends none), so a
  // translation from Auto never carries the ordinary preferred language.
  resolveBatchRoute(settings, deploymentName = "", { effectiveLanguage } = {}) {
    const route = resolveTranscriptionRoute({
      settings: {
        ...settings,
        useLocalWhisper: false,
        transcriptionMode:
          settings.transcriptionMode === "local" ? "providers" : settings.transcriptionMode,
      },
      policy: usePolicyStore.getState(),
      providers: getTranscriptionProviders(),
      hasProviderKey: Boolean(
        getTranscriptionApiKey(settings.cloudTranscriptionProvider || "openai", settings)
      ),
      request: {
        model: deploymentName,
        ...(effectiveLanguage !== undefined ? { effectiveLanguage } : {}),
      },
    });
    if (route.transport === "error") {
      const error = new Error(route.message);
      if (route.code) error.code = route.code;
      if (route.messageKey) error.messageKey = route.messageKey;
      if (route.settingsTarget) error.settingsTarget = route.settingsTarget;
      throw error;
    }
    return route;
  }

  getTranscriptionEndpoint(route) {
    if (route.transport !== "http-batch") {
      // Proxied providers are dispatched before endpoint resolution; reaching
      // here means that guard was bypassed — never fall open to a default.
      throw new Error(
        route.provider === "tinfoil"
          ? TINFOIL_PROXY_REQUIRED_ERROR
          : `${route.provider} transcription must go through the main-process proxy`
      );
    }
    logger.debug(
      "STT endpoint resolved",
      { endpoint: route.endpoint, provider: route.provider },
      "transcription"
    );
    return route.endpoint;
  }

  // `report` (default: the manager's onError) hears a paste that failed, so
  // the dictation hook can tie the card to the dictation it belongs to.
  async safePaste(text, options = {}, { report = (error) => this.onError?.(error) } = {}) {
    try {
      const result = await window.electronAPI.pasteText(text, options);
      if (
        result?.success === false &&
        result.code === "ACCESSIBILITY_PERMISSION_REQUIRED" &&
        result.clipboardCopied === true
      ) {
        report({
          title: "Paste Error",
          code: result.code,
          clipboardCopied: true,
          transcript: text,
        });
        return { pasted: false };
      }
      return {
        pasted: result?.pasted === true,
        ...(result?.reason ? { reason: result.reason } : {}),
      };
    } catch (error) {
      const message =
        error?.message ??
        (typeof error?.toString === "function" ? error.toString() : String(error));
      report({
        title: "Paste Error",
        code: "PASTE_FAILED",
        // Keep the platform's guidance, without Electron's IPC wrapper around it.
        description: message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ""),
      });
      return { pasted: false };
    }
  }

  async _beginActivationCapture() {
    if (this._activationCapture || this.voiceAgentRequested) return true;
    const generation = this._activationCaptureGeneration ?? 0;
    try {
      const id = await window.electronAPI?.beginActivationCapture?.();
      if (generation !== (this._activationCaptureGeneration ?? 0)) {
        this._cancelActivationCapture(id);
        return false;
      }
      this._activationCapture = id;
    } catch {
      // Marketing capture must never interrupt dictation.
    }
    return generation === (this._activationCaptureGeneration ?? 0);
  }

  _takeActivationCapture() {
    this._activationCaptureGeneration = (this._activationCaptureGeneration ?? 0) + 1;
    const id = this._activationCapture;
    this._activationCapture = null;
    return id;
  }

  _cancelActivationCapture(id) {
    if (id) void window.electronAPI?.cancelActivationCapture?.(id).catch(() => {});
  }

  async _completeActivationCapture(id, result) {
    if (!id) return;
    const words =
      result?.success && !result.assistantConversation && !result.selectionEdit
        ? countSpokenWords(result.rawText)
        : 0;
    try {
      await window.electronAPI?.finishActivationCapture?.(id, words);
    } catch {
      // The main-process pending capture fences completeness after write failure.
    }
  }

  // `onRowSaved(id)` hears the History row this dictation was saved to (the
  // re-sent failed row it completed, or its new row), or null when none was:
  // a card's Open in History opens that row, never "the newest".
  async saveTranscription(
    text,
    rawText = null,
    { clientTranscriptionId, analyticsOccurredAt, trace, replacesTranscriptionId, onRowSaved } = {}
  ) {
    let savedId = null;
    try {
      return await this._saveTranscriptionRow(text, rawText, {
        clientTranscriptionId,
        analyticsOccurredAt,
        trace,
        replacesTranscriptionId,
        onRowId: (id) => {
          savedId = Number.isInteger(id) ? id : null;
        },
      });
    } finally {
      try {
        onRowSaved?.(savedId);
      } catch {
        // A listener must never cost the save.
      }
    }
  }

  async _saveTranscriptionRow(
    text,
    rawText,
    { clientTranscriptionId, analyticsOccurredAt, trace, replacesTranscriptionId, onRowId }
  ) {
    const { dataRetentionEnabled, audioRetentionDays } = getEffectiveRetentionPreferences();
    if (!dataRetentionEnabled) {
      logger.debug("Skipping transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return true;
    }

    // A re-sent failed dictation completes its failed History row, which
    // already has the recording. A Cloud result names its own cloud row, so
    // it is saved as a new one.
    if (Number.isInteger(replacesTranscriptionId) && !clientTranscriptionId) {
      const completed = await this._completeResentDictation(
        replacesTranscriptionId,
        text,
        rawText,
        trace
      );
      if (completed !== null) {
        onRowId(replacesTranscriptionId);
        return completed;
      }
    }

    const eventId = clientTranscriptionId || crypto.randomUUID();
    const occurredAt = analyticsOccurredAt ? new Date(analyticsOccurredAt) : new Date();
    const metadata = this.lastAudioMetadata || {};
    try {
      await window.electronAPI.recordAnalyticsEvent({
        eventId,
        wordCount: countSpokenWords(rawText || text),
        occurredAt: occurredAt.toISOString(),
        localDate: localDateKey(occurredAt),
        spokenDurationMs: metadata.durationMs || null,
        mode: resolveAnalyticsMode(getSettings(), metadata.provider),
        provider: metadata.provider || null,
        model: metadata.model || null,
      });
    } catch (analyticsError) {
      logger.warn(
        "Failed to record local analytics event",
        { error: analyticsError.message, clientTranscriptionId: eventId },
        "analytics"
      );
    }

    try {
      const result = await window.electronAPI.saveTranscription(text, rawText, {
        clientTranscriptionId: eventId,
        // A styled dictation's style comes from its own trace: the recording
        // it belongs to, even if another one has started since.
        routeKind: this.translationRequested
          ? "translation"
          : trace
            ? styleRouteKind(traceStyle(trace)?.id)
            : this.getRecordingRouteKind(),
        analyticsOccurredAt: occurredAt.toISOString(),
        // Main writes its steps in the row's transaction, if ownership and the
        // history setting still allow them when it arrives.
        ...(trace ? { trace } : {}),
      });
      onRowId(result?.id);
      if (result?.id) syncService.debouncedPush("transcription", result.id);
      // Joins this dictation's log lines to its History entry (no text).
      logger.debug(
        "Dictation saved",
        {
          historyId: result?.id ?? null,
          clientTranscriptionId: eventId,
          runId: trace?.runId ?? null,
        },
        "audio"
      );

      // Save audio if we have a captured blob and the transcription was saved successfully
      if (result?.id && this.lastAudioBlob) {
        if (audioRetentionDays > 0) {
          try {
            const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
            await window.electronAPI.saveTranscriptionAudio(
              result.id,
              arrayBuffer,
              this.lastAudioMetadata
            );
          } catch (audioErr) {
            // Non-blocking: transcription is saved even if audio save fails
            logger.warn(
              "Failed to save transcription audio",
              { error: audioErr.message, historyId: result.id },
              "audio"
            );
          }
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  // The failed row becomes the re-sent dictation (main's
  // completeFailedDictation): true when written or overtaken (nothing to
  // save), false on failure, null when the row is gone and the dictation
  // should be saved as a new one.
  async _completeResentDictation(id, text, rawText, trace) {
    const metadata = this.lastAudioMetadata || {};
    const complete = window.electronAPI?.completeFailedDictationRetry;
    if (!complete) return null;
    try {
      const result = await complete(id, text, rawText, {
        ...(trace ? { trace } : {}),
        provider: metadata.provider ?? null,
        model: metadata.model ?? null,
      });
      if (result?.code === "NOT_FOUND") return null;
      if (result?.success) syncService.debouncedPush("transcription", id);
      logger.debug(
        "Re-sent dictation saved",
        {
          historyId: id,
          replaced: result?.success === true,
          stale: result?.stale === true,
          runId: trace?.runId ?? null,
        },
        "audio"
      );
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return result?.success === true || result?.stale === true;
    } catch (error) {
      logger.warn(
        "Failed to complete a re-sent dictation's row",
        { error: error.message, historyId: id },
        "audio"
      );
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return false;
    }
  }

  // `onRowSaved(id)` hears the failed row's id once it exists (null when none
  // was saved), so the error card's Retry can complete that row. `transcript`:
  // empty when transcription itself failed; otherwise the transcript a later
  // step could not process (#2678), kept as both the row's text and its raw
  // text, under Cloud's `clientTranscriptionId` when Cloud already recorded it.
  async saveFailedTranscription(errorMessage, errorCode = null, metadata = {}, options = {}) {
    const { transcript = "", clientTranscriptionId } = options ?? {};
    let rowReported = false;
    const reportRow = (id) => {
      if (rowReported) return;
      rowReported = true;
      options?.onRowSaved?.(Number.isInteger(id) ? id : null);
    };
    const { dataRetentionEnabled, audioRetentionDays } = getEffectiveRetentionPreferences();
    if (!dataRetentionEnabled) {
      logger.debug("Skipping failed transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      reportRow(null);
      return;
    }

    let savedId = null;
    try {
      const keptTranscript = typeof transcript === "string" ? transcript : "";
      const result = await window.electronAPI.saveTranscription(
        keptTranscript,
        keptTranscript || null,
        {
          status: "failed",
          errorMessage,
          errorCode,
          routeKind: this.getRecordingRouteKind(),
          ...(clientTranscriptionId ? { clientTranscriptionId } : {}),
          ...(metadata?.analyticsOccurredAt
            ? { analyticsOccurredAt: metadata.analyticsOccurredAt }
            : {}),
        }
      );
      // Failed rows stay local (#2678): a re-send or retry that completes one
      // is what reaches sync.
      savedId = result?.id ?? null;

      if (result?.id && this.lastAudioBlob) {
        if (audioRetentionDays > 0) {
          try {
            const durationMs = metadata?.durationSeconds
              ? Math.round(metadata.durationSeconds * 1000)
              : null;
            const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
            await window.electronAPI.saveTranscriptionAudio(result.id, arrayBuffer, {
              durationMs,
              provider: null,
              model: null,
            });
          } catch (audioErr) {
            logger.warn(
              "Failed to save audio for failed transcription",
              {
                error: audioErr.message,
              },
              "audio"
            );
          }
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }
    } catch (error) {
      logger.error(
        "Failed to save failed transcription record",
        {
          error: error.message,
        },
        "audio"
      );
    } finally {
      // After the audio: a Retry that completes the row must not race its save.
      reportRow(savedId);
    }
  }

  async saveDiscardedTranscription(blob, durationSeconds, analyticsOccurredAt = null) {
    let savedId = null;
    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "discarded",
        routeKind: this.getRecordingRouteKind(),
        ...(analyticsOccurredAt ? { analyticsOccurredAt } : {}),
      });
      if (!result?.id) return;
      savedId = result.id;

      if (blob) {
        const durationMs = durationSeconds ? Math.round(durationSeconds * 1000) : null;
        const arrayBuffer = await blob.arrayBuffer();
        await window.electronAPI.saveTranscriptionAudio(savedId, arrayBuffer, {
          durationMs,
          provider: null,
          model: null,
        });
      }

      syncService.debouncedPush("transcription", savedId);
    } catch (error) {
      logger.error(
        "Failed to save discarded transcription record",
        { error: error.message },
        "audio"
      );
      // A discarded row is only recoverable through its audio; if the audio save
      // failed, drop the dead row instead of leaving an empty unrecoverable entry. See #907.
      if (savedId != null) {
        try {
          await window.electronAPI.deleteTranscription(savedId);
        } catch (cleanupError) {
          logger.warn(
            "Failed to clean up discarded row after audio save failure",
            { error: cleanupError.message },
            "audio"
          );
        }
      }
    }
  }

  // Recordings a hung or crashed app never saved come back as failed entries
  // the user can retry. One that fails to save stays spooled for the next
  // launch. Runs at launch, which also opens the spool before any recording.
  async recoverInterruptedRecordings(errorMessage) {
    let recordings;
    try {
      recordings = await takeInterruptedRecordings();
    } catch (error) {
      logger.warn("Failed to read interrupted recordings", { error: error.message }, "audio");
      return;
    }
    const { dataRetentionEnabled, audioRetentionDays } = getEffectiveRetentionPreferences();
    const keepAudio = dataRetentionEnabled && audioRetentionDays > 0;
    for (const recording of recordings) {
      if (!keepAudio || (await this._saveInterruptedRecording(recording, errorMessage))) {
        recording.discard();
      }
    }
  }

  async _saveInterruptedRecording(
    { segments, startedAt, durationMs, routeKind, recordingQuality },
    errorMessage
  ) {
    let audio;
    try {
      audio = await this.mergeRecordedSegments(segments, recordingQuality);
    } catch (error) {
      logger.warn("Failed to merge interrupted recording", { error: error.message }, "audio");
      audio = this.getLargestRecordedSegment(segments);
    }
    // Header-only chunks: the app hung before any audio was captured.
    if (!audio) return true;

    let savedId = null;
    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "failed",
        errorMessage,
        errorCode: "CRASH_RECOVERY",
        routeKind,
        analyticsOccurredAt: new Date(startedAt).toISOString(),
      });
      savedId = result?.id ?? null;
      if (savedId === null) return false;
      const audioResult = await window.electronAPI.saveTranscriptionAudio(
        savedId,
        await audio.arrayBuffer(),
        { durationMs, provider: null, model: null }
      );
      if (!audioResult?.success) throw new Error("Failed to save recovered audio");
      syncService.debouncedPush("transcription", savedId);
      logger.info("Recovered interrupted recording", { id: savedId, durationMs }, "audio");
      return true;
    } catch (error) {
      logger.error("Failed to save interrupted recording", { error: error.message }, "audio");
      // Without its audio the row can't be retried; the next launch tries again.
      if (savedId !== null) {
        await window.electronAPI.deleteTranscription(savedId).catch(() => {});
      }
      return false;
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      isPreparing: this.preparedMicCapture.active,
      isStreamingStartInProgress: this.streamingStartInProgress,
      isFinalizingStreaming: Boolean(this._streamingStopPromise),
      micCaptureStatus: this.micCaptureStatus,
    };
  }

  shouldUseStreaming(isSignedInOverride) {
    const s = getSettings();
    if (s.useLocalWhisper) return false;

    // Managed enterprise STT is batch-only and outranks personal streaming
    // setups; an error resolution must fail closed on the batch path too.
    if (getManagedTranscriptionResolution()) return false;

    if (isOrukeetStreaming(s)) return Boolean(s.customTranscriptionApiKey);

    // Self-hosted transcription is batch HTTP to the user's server, never cloud realtime WS.
    if (isSelfHostedTranscription(s)) return false;

    if (
      s.cloudTranscriptionMode === "openwhispr" &&
      this.sttConfig?.streamingProvider === "orukeet"
    ) {
      // A language the model does not cover takes the batch path, which
      // carries the language, instead of a socket that would ignore it.
      const route = resolveManagedOrukeetRoute({
        settings: s,
        sttConfig: this.sttConfig,
        language: this.getEffectiveSttLanguage(s),
      });
      return route === "orukeet" && Boolean(isSignedInOverride ?? s.isSignedIn);
    }

    // Corti (BYOK) streams over its own WSS — independent of OpenWhispr Cloud.
    if (s.cloudTranscriptionProvider === "corti" && s.cloudTranscriptionMode === "byok") {
      return !!(s.cortiClientId && s.cortiClientSecret);
    }

    // Tinfoil realtime streams without an OpenWhispr account.
    if (s.cloudTranscriptionProvider === "tinfoil") {
      const provider = getTranscriptionProvider("tinfoil");
      const model = provider?.models.find((m) => m.id === s.cloudTranscriptionModel);
      return !!model?.streaming && !!s.tinfoilApiKey;
    }

    // Gemini Live streams over its own WSS on either credential; the batch
    // Gemini model on the same provider stays on HTTP.
    if (s.cloudTranscriptionProvider === "gemini") {
      if (!isGeminiLiveSelection(s)) return false;
      if (s.cloudTranscriptionMode === "byok") return !!s.geminiApiKey;
      return !!(isSignedInOverride ?? s.isSignedIn);
    }

    // Realtime-only providers (BYOK) stream over their own WSS and have no batch
    // endpoint at all — transcriptionRoute fails those closed — so gate on the
    // key instead of letting them fall through to the HTTP path.
    if (
      s.cloudTranscriptionMode === "byok" &&
      STREAMING_ONLY_PROVIDERS.has(s.cloudTranscriptionProvider)
    ) {
      return Boolean(getTranscriptionApiKey(s.cloudTranscriptionProvider, s));
    }

    // The managed-cloud bootstrap only controls OpenWhispr Cloud. A user's
    // BYOK realtime model must not be downgraded because managed dictation is
    // configured for batch processing.
    if (s.cloudTranscriptionMode === "openwhispr" && this.sttConfig?.dictation?.mode === "batch") {
      return false;
    }

    if (isOpenAiRealtimeSelection(s)) {
      // Realtime WS is OpenAI-only — other providers fall through to HTTP.
      if ((s.cloudTranscriptionProvider || "openai") !== "openai") return false;
      if (s.cloudTranscriptionMode === "byok") return !!s.openaiApiKey;
      if (s.cloudTranscriptionMode === "openwhispr") return !!(isSignedInOverride ?? s.isSignedIn);
      return false;
    }

    if (s.cloudTranscriptionMode !== "openwhispr" || !(isSignedInOverride ?? s.isSignedIn)) {
      return false;
    }
    if (!this.sttConfig) return false;
    return this.sttConfig.dictation?.mode === "streaming";
  }

  // Orukeet's combined cleanup (#2436): the cleanup options its session is
  // minted with, or undefined when the stream must not clean up. A styled
  // recording runs its own cleanup and restyle (runStyleRoute), so it mints
  // none. The words are cleanup's word set (selectCleanupDictionary), as
  // /api/reason would get them.
  getPipelineCleanupOptions(
    settings,
    {
      voiceAgentRequested = this.voiceAgentRequested,
      translationRequested = this.translationRequested,
      appCategory = null,
      style = this.getActiveRecordingStyle(),
    } = {}
  ) {
    if (
      this.sttConfig?.orukeetPipeline !== "gemma12" ||
      settings.useLocalWhisper ||
      settings.cloudTranscriptionMode !== "openwhispr" ||
      !settings.useCleanupModel ||
      !isCloudCleanupMode() ||
      !isLlmSelectionAllowed(usePolicyStore.getState(), { mode: "openwhispr" }) ||
      voiceAgentRequested ||
      translationRequested ||
      style
    )
      return undefined;
    return {
      agentName: getAgentName() || "",
      ...toCloudDictionaryFields(selectCleanupDictionary(settings).words, settings),
      customPrompt: this.getCustomPrompt(),
      ...(settings.toneStyleEnabled
        ? resolveDictationToneStyle(settings.toneStyles, appCategory)
        : {}),
      language: this.getCleanupLanguage(settings) || undefined,
      locale: settings.uiLanguage || "en",
    };
  }

  async warmupStreamingConnection({ isSignedIn: isSignedInOverride, warmMic = true } = {}) {
    if (!this.isRecordingAllowedByPolicy()) {
      logger.debug("Streaming warmup skipped by workspace policy", {}, "streaming");
      return false;
    }
    if (!this.shouldUseStreaming(isSignedInOverride)) {
      logger.debug("Streaming warmup skipped - not in streaming mode", {}, "streaming");
      return false;
    }

    try {
      const providerName = this.getStreamingProviderName();
      const provider = STREAMING_PROVIDERS[providerName];
      const [, wsResult] = await Promise.all([
        this.cacheMicrophoneDeviceId(),
        withSessionRefresh(async () => {
          const settings = getSettings();
          const res = await provider.warmup(
            buildStreamingSessionOptions({
              providerName,
              settings,
              language: settings.preferredLanguage,
              keyterms: this.getKeyterms(),
              voiceAgentRequested: this.voiceAgentRequested,
              // Warmup runs while idle, so the socket is for an ordinary
              // dictation into the app the last start learned in time (Tone &
              // Style). With no app known, a start mints no combined cleanup,
              // so neither does warmup.
              pipelineOptions:
                settings.toneStyleEnabled && !this.lastToneAppCategory
                  ? undefined
                  : this.getPipelineCleanupOptions(settings, {
                      voiceAgentRequested: false,
                      translationRequested: false,
                      appCategory: this.lastToneAppCategory,
                      style: null,
                    }),
            })
          );
          // Throw error to trigger retry if AUTH_EXPIRED
          if (!res.success && res.code) {
            const err = new Error(res.error || "Warmup failed");
            err.code = res.code;
            throw err;
          }
          return res;
        }),
      ]);

      if (wsResult.success) {
        // Pre-load AudioWorklet module so first recording is faster
        try {
          const audioContext = await this.getOrCreateAudioContext();
          if (!this.workletModuleLoaded) {
            await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
            this.workletModuleLoaded = true;
            logger.debug("AudioWorklet module pre-loaded during warmup", {}, "streaming");
          }
        } catch (e) {
          logger.debug(
            "AudioWorklet pre-load failed (will retry on recording)",
            { error: e.message },
            "streaming"
          );
        }

        // Warm up the OS audio driver by briefly acquiring the mic, then
        // releasing. TTL-gated: drivers go cold again after idle, so this must
        // re-fire once the warm window lapses (#845).
        if (warmMic) await this._warmMicDriverIfCold("streaming");

        this.warmupFailureStreak = 0;
        logger.info(
          "Streaming connection warmed up",
          { alreadyWarm: wsResult.alreadyWarm, micCached: !!this.cachedMicDeviceId },
          "streaming"
        );
        return true;
      } else if (wsResult.code === "NO_API") {
        logger.debug("Streaming warmup skipped - API not configured", {}, "streaming");
        return false;
      } else {
        this._reportWarmupFailure(providerName, wsResult.error, wsResult.code);
        return false;
      }
    } catch (error) {
      this._reportWarmupFailure(this.getStreamingProviderName(), error.message, error.code);
      return false;
    }
  }

  // Warmup exercises the same connect that recording start will make, so a
  // failing warmup predicts a guaranteed user-facing failure at the next
  // keypress — #1624 logged exactly this on every idle cycle for days at warn
  // level and nobody saw it. Error level, provider named, streak counted.
  _reportWarmupFailure(provider, error, code) {
    this.warmupFailureStreak += 1;
    logger.error(
      "Streaming warmup failed",
      { provider, error, code, consecutiveFailures: this.warmupFailureStreak },
      "streaming"
    );
  }

  async getOrCreateAudioContext() {
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      if (this.persistentAudioContext.state === "suspended") {
        await this.persistentAudioContext.resume();
      }
      return this.persistentAudioContext;
    }
    this.persistentAudioContext = new AudioContext({ sampleRate: 16000 });
    this.workletModuleLoaded = false;
    return this.persistentAudioContext;
  }

  startStreamingFallbackRecorder(stream) {
    try {
      const chunks = [];
      const recorder = createDictationRecorder(stream, this._recordingQuality);
      const spoolChunk = this._recordingSpool?.addSegment(recorder.mimeType || "audio/webm");
      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) {
          chunks.push(event.data);
          spoolChunk?.(event.data);
        }
      };
      recorder.start(RECORDING_TIMESLICE_MS);
      this.streamingFallbackRecorder = recorder;
      this.streamingFallbackChunks = chunks;
      return recorder;
    } catch (error) {
      logger.debug("Fallback recorder failed to start", { error: error.message }, "streaming");
      this.streamingFallbackRecorder = null;
      return null;
    }
  }

  async finishStreamingFallbackSegment() {
    const recorder = this.streamingFallbackRecorder;
    if (!recorder) return null;
    const chunks = this.streamingFallbackChunks;
    const collect = () => new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    let blob;
    if (recorder.state === "recording") {
      blob = await new Promise((resolve) => {
        recorder.onstop = () => resolve(collect());
        recorder.stop();
      });
    } else {
      // The recorder auto-stops when its track dies; its chunks still hold the
      // audio captured up to that point.
      blob = collect();
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    if (blob?.size > 0) this._streamingFallbackSegments.push(blob);
    return blob;
  }

  async replaceStreamingMic(replacement, previous) {
    if (!this.streamingProcessor || !this.streamingAudioContext) {
      throw new Error("Streaming audio pipeline is unavailable");
    }
    const swap = (async () => {
      const nextSource = this.streamingAudioContext.createMediaStreamSource(replacement);
      nextSource.connect(this.streamingProcessor);
      this.streamingSource?.disconnect();
      this.streamingSource = nextSource;
      if (this.streamingAnalyser) this.streamingSource.connect(this.streamingAnalyser);
      await this.finishStreamingFallbackSegment();
      if (!this.isStreaming || !this.isRecording) {
        throw new Error("Streaming stopped during microphone recovery");
      }
      this.startStreamingFallbackRecorder(replacement);
      previous?.getTracks().forEach((track) => track.stop());
      this.streamingStream = replacement;
    })();
    // Expose the swap so stopStreamingRecording can wait for it instead of
    // racing it (losing the newest fallback segment / orphaning a recorder).
    this._streamingMicSwapPromise = swap.catch(() => {});
    try {
      await swap;
    } finally {
      this._streamingMicSwapPromise = null;
    }
  }

  _waitForStreamingStartSettlement() {
    if (!this.streamingStartInProgress) return Promise.resolve();
    return new Promise((resolve) => {
      this._streamingStartSettlementWaiters.push(resolve);
    });
  }

  _settleStreamingStart() {
    this.streamingStartInProgress = false;
    for (const resolve of this._streamingStartSettlementWaiters.splice(0)) resolve();
  }

  // Turns a failed dictation-realtime-start result into a batch fallback or
  // the error the user must see.
  classifyStreamingStartResult(res, { useLocalWhisper }) {
    if (res.success) return res;
    if (res.code === "NO_API") return { needsFallback: true };
    if (res.code === "NETWORK_ERROR" && useLocalWhisper) {
      this.onError?.({
        code: "NETWORK_ERROR",
        title: "streaming.errors.cloudUnreachable.title",
        description: "Cloud unreachable — using local engine for this recording.",
        messageKey: "streaming.errors.cloudUnreachable.fallback",
      });
      return { needsFallback: true };
    }
    const fallbackReason = resolveStreamingStartFallback({
      providerName: this.getActiveStreamingProviderName(),
      cloudTranscriptionMode: getSettings().cloudTranscriptionMode,
      result: res,
    });
    if (fallbackReason) {
      // The cached config advertised a route the server no longer grants: drop
      // it so the next recording refetches instead of retrying a denied route.
      if (res.code === "FEATURE_NOT_ENABLED") this.invalidateSttConfig();
      this.streamingFallbackReason = fallbackReason;
      logger.warn(
        "Managed Orukeet session unavailable, falling back to batch recording",
        { code: res.code, status: res.status, reason: fallbackReason, error: res.error },
        "streaming"
      );
      return { needsFallback: true };
    }
    if (res.code === "LIMIT_REACHED" && Number.isFinite(res.details?.wordsUsed)) {
      // Same upgrade prompt a batch upload opens when it crosses the quota.
      window.electronAPI?.notifyLimitReached?.({
        wordsUsed: res.details.wordsUsed,
        limit: Number.isFinite(res.details.limit) ? res.details.limit : 2000,
      });
    }
    const err = new Error(res.error || "Failed to start streaming session");
    err.code = res.code;
    err.messageKey = res.messageKey;
    err.networkCode = res.networkCode;
    throw err;
  }

  // Why this cloud upload is batch instead of the managed Orukeet stream, for
  // the rollout's fallback-rate metric. Cleared on read: it describes one recording.
  consumeStreamingFallbackReason(settings) {
    const reason = this.streamingFallbackReason;
    this.streamingFallbackReason = null;
    if (reason) return reason;
    const route = resolveManagedOrukeetRoute({
      settings,
      sttConfig: this.sttConfig,
      language: this.getEffectiveSttLanguage(settings),
    });
    return route === "language_unsupported" ? route : undefined;
  }

  async startStreamingRecording(forceDefaultMic = false) {
    let acquiredStream = null;
    let usedPreparedCapture = false;
    let sessionId = null;
    let providerName = null;
    let startWasCancelled = () => false;
    const trace = this.startTrace;
    this.startTrace = null;
    this._startInProgress = true;
    try {
      if (!this.isRecordingAllowedByPolicy()) {
        logger.warn("Streaming recording blocked by workspace policy", {}, "audio");
        return false;
      }
      if (this.streamingStartInProgress) {
        return false;
      }
      this.streamingStartInProgress = true;

      if (this.isRecording || this.isStreaming || this.isProcessing || this._streamingStopPromise) {
        this._settleStreamingStart();
        return false;
      }

      this.stopRequestedDuringStreamingStart = false;
      const activationGeneration = this._activationCaptureGeneration ?? 0;
      if (
        !(await this._beginActivationCapture()) ||
        activationGeneration !== (this._activationCaptureGeneration ?? 0)
      ) {
        this._settleStreamingStart();
        return false;
      }
      sessionId = (this._streamingSessionGeneration || 0) + 1;
      this._streamingSessionGeneration = sessionId;
      this.streamingFallbackReason = null;
      this._streamingFailoverReason = null;
      this._streamingSpeechGateState = createLocalSpeechGateState();
      this._activeStreamingSessionId = sessionId;
      providerName = this.getStreamingProviderName();
      this._activeStreamingProviderName = providerName;
      this._activeStreamingConfig = { ...this.sttConfig };
      const ownsSession = () => this._activeStreamingSessionId === sessionId;
      const cancellationGeneration = this._streamingCancellationGeneration;
      startWasCancelled = () => cancellationGeneration !== this._streamingCancellationGeneration;

      const t0 = performance.now();
      const prepared = forceDefaultMic ? null : await this.preparedMicCapture.take();
      // Prepared while batch mode was expected; keep the stream, drop the pre-roll
      // (the streaming transcript comes from the PCM worklet, not these chunks).
      discardPreRoll(prepared);
      usedPreparedCapture = !!prepared;
      const constraints =
        prepared?.constraints ?? (await this.getAudioConstraints(forceDefaultMic));
      const tConstraints = performance.now();

      // 1. Get mic stream (can take 10-15s on a cold driver — unless a prepared
      //    capture or a held master stream already opened the device).
      const stream = prepared?.stream ?? (await this._acquireCaptureStream(constraints, trace));
      acquiredStream = stream;
      const tMedia = performance.now();
      if (!prepared) markStartTrace(trace, "micReady");

      const audioTrack = stream.getAudioTracks()[0];

      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Streaming recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            usedCachedId: !!this.cachedMicDeviceId,
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
          },
          "audio"
        );
      }

      // Start fallback recorder in case streaming produces no results.
      this._streamingFallbackSegments = [];
      this._recordingQuality = currentRecordingQuality();
      this._recordingSpool = this._startRecordingSpool();
      this.startStreamingFallbackRecorder(stream);

      // 2. Set up audio pipeline so frames flow the instant WebSocket is ready.
      //    Frames sent before the connection is open are buffered (bounded) by
      //    sendAudio(), not dropped. Managed Orukeet's wait in heldFrames instead.
      const audioContext = await this.getOrCreateAudioContext();
      this.streamingAudioContext = audioContext;
      this.streamingSource = audioContext.createMediaStreamSource(stream);
      this.streamingStream = stream;

      // Level source for the live waveform: the batch path reads the
      // speech-gate analyser, which never attaches to streaming recordings.
      this.streamingAnalyser = audioContext.createAnalyser();
      this.streamingAnalyser.fftSize = 2048;
      this.streamingSource.connect(this.streamingAnalyser);

      if (!this.workletModuleLoaded) {
        await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
        this.workletModuleLoaded = true;
      }

      this.streamingProcessor = new AudioWorkletNode(audioContext, "pcm-streaming-processor");
      const provider = this.getStreamingProvider(providerName);
      // Decided once, with the provider, so a config refresh mid-recording
      // cannot change how this session's stream errors are handled. Only a
      // session whose fallback recorder started has a capture to fail over
      // to; stop finishes that recorder before a refused commit can arrive.
      const managedOrukeet = isManagedOrukeetStream({
        providerName,
        cloudTranscriptionMode: getSettings().cloudTranscriptionMode,
      });
      const failsOver = Boolean(this.streamingFallbackRecorder) && managedOrukeet;
      // Managed Orukeet cues the user before its session exists, and main can drop
      // what reaches a connection it replaces (a warmup for another route, a failed
      // one, a session retry). So its audio waits here until the session has started.
      let heldFrames = managedOrukeet ? [] : null;

      this.streamingProcessor.port.onmessage = (event) => {
        // The worklet posts its remaining PCM followed by a "flushed" sentinel
        // on stop; the sentinel must not be sent as audio (realtime backends
        // reject the odd-length non-PCM bytes with "Invalid audio data").
        if (!ownsSession() || !this.isStreaming) return;
        if (event.data === "flushed") {
          this._streamingFlushResolve?.();
          return;
        }
        // Measured from the first chunk: a recording that fails over later
        // still has its opening words in the gate.
        recordPcm16SpeechWindow(this._streamingSpeechGateState, event.data);
        if (this._streamingFailoverReason) return;
        if (heldFrames) heldFrames.push(event.data);
        else provider.send(event.data);
      };

      this.isStreaming = true;
      this.streamingSource.connect(this.streamingProcessor);

      const tPipeline = performance.now();

      // 3. Register IPC event listeners BEFORE connecting, so no transcript
      //    events are lost during the connect handshake.
      this.streamingFinalText = "";
      this.streamingPartialText = "";
      this.streamingTextBump = null;
      this.streamingTextDebounce = null;

      const partialCleanup = provider.onPartial((text) => {
        if (!ownsSession()) return;
        this.streamingPartialText = text;
        this.streamingTextBump?.();
        this.onPartialTranscript?.(text);
      });

      const finalCleanup = provider.onFinal((text) => {
        if (!ownsSession()) return;
        // text = accumulated final text from streaming provider.
        // Extract just the new segment (delta from previous accumulated final).
        const prevLen = this.streamingFinalText.length;
        this.streamingFinalText = text;
        this.streamingPartialText = "";
        this.streamingTextBump?.();
        const newSegment = text.slice(prevLen);
        if (newSegment) {
          this.onStreamingCommit?.(newSegment);
        }
      });

      const errorCleanup = provider.onError((error) => {
        if (!ownsSession()) return;
        logger.error("Streaming provider error", { error }, "streaming");
        // Managed Orukeet refuses a second concurrent recording on the account
        // and can drop a socket mid-recording. The fallback recorder has the
        // whole capture, so keep recording and let stop upload it to Cloud
        // rather than cutting the user off behind an error.
        if (failsOver) {
          this._streamingFailoverReason ??= "stream_no_final";
          return;
        }
        this.onError?.({
          title: "Streaming Error",
          description: error,
        });
        if (this.isStreaming) {
          logger.warn("Connection lost during streaming, auto-stopping", {}, "streaming");
          this.stopStreamingRecording().catch((e) => {
            logger.error(
              "Auto-stop after connection loss failed",
              { error: e.message },
              "streaming"
            );
          });
        }
      });

      const sessionEndCleanup = provider.onSessionEnd((data) => {
        if (!ownsSession()) return;
        logger.debug(
          "Streaming session ended",
          { keys: Object.keys(data || {}), text: logText(data?.text) },
          "streaming"
        );
        if (data.text) {
          this.streamingFinalText = data.text;
        }
      });

      this.streamingCleanupFns = [partialCleanup, finalCleanup, errorCleanup, sessionEndCleanup];
      if (startWasCancelled()) {
        // Cancelled while the mic was opening: never flip to recording.
        await this.cleanupStreaming();
        // cancelStreamingRecording may already be awaiting this start's
        // settlement before it can disconnect the provider.
        this._settleStreamingStart();
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        return false;
      }
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      markStartTrace(trace, "recorderActive");
      this.onStateChange?.({ isRecording: true, isProcessing: false, isStreaming: true });
      await this.beginMicRecovery(stream);

      // A combined cleanup's prompt is fixed when its session is minted, so with
      // Tone & Style on the start waits briefly for the app being dictated into
      // before minting. Audio from the wait is held until the session has
      // started: with no warm socket main has nowhere to buffer it, and a warm
      // one minted for another app is replaced. An app not known by then (a
      // Wayland AT-SPI target takes about a second) gets no combined cleanup:
      // /api/reason cleans up in its tone at stop.
      const pipelineSettings = getSettings();
      if (
        providerName === "orukeet" &&
        pipelineSettings.toneStyleEnabled &&
        this.getPipelineCleanupOptions(pipelineSettings)
      ) {
        heldFrames ??= [];
        const waitMs = Math.max(0, this.toneStyleStartDeadline - performance.now());
        this.lastToneAppCategory = await Promise.race([
          this.toneStylePromise,
          new Promise((resolve) => setTimeout(() => resolve(null), waitMs)),
        ]);
      }
      if (startWasCancelled()) {
        // cancelStreamingRecording waits for this settlement before it
        // releases the capture; minting a session now would only waste one.
        this._settleStreamingStart();
        return false;
      }
      this._activePipelineOptions =
        pipelineSettings.toneStyleEnabled && !this.lastToneAppCategory
          ? undefined
          : this.getPipelineCleanupOptions(pipelineSettings, {
              appCategory: this.lastToneAppCategory,
            });

      // 4. Connect WebSocket.
      const result = await withSessionRefresh(async () => {
        const streamingSettings = getSettings();
        const { useLocalWhisper } = streamingSettings;
        const sessionOptions = buildStreamingSessionOptions({
          providerName,
          settings: streamingSettings,
          language: this.getEffectiveSttLanguage(streamingSettings),
          keyterms: this.getKeyterms(),
          voiceAgentRequested: this.voiceAgentRequested,
          pipelineOptions: this._activePipelineOptions,
        });
        // Decided from the credentials this session opens with, so a mode
        // switch before stop cannot move its words in or out of Cloud usage.
        this._streamingMeteredByCloud = isCloudMeteredStream(sessionOptions);
        const res = await provider.start(sessionOptions);
        // The user is gone: no upgrade prompt, session refresh or retry for this answer.
        if (startWasCancelled()) return res;

        return this.classifyStreamingStartResult(res, { useLocalWhisper });
      });
      const tWs = performance.now();
      this._settleStreamingStart();
      if (startWasCancelled()) return false;

      // A managed Orukeet start failure (refused socket, account cap, outage)
      // keeps this capture: the fallback recorder has held the audio since the
      // mic opened, and reopening the mic for a batch recording would lose it.
      if (result.needsFallback && this.streamingFallbackReason && this.streamingFallbackRecorder) {
        this._streamingFailoverReason = this.streamingFallbackReason;
        this.streamingFallbackReason = null;
        heldFrames = null;
        logger.info(
          "Managed Orukeet unavailable, recording for the Cloud upload",
          { reason: this._streamingFailoverReason },
          "streaming"
        );
        if (this.stopRequestedDuringStreamingStart) {
          this.stopRequestedDuringStreamingStart = false;
          return this.stopStreamingRecording();
        }
        return true;
      }

      if (result.needsFallback) {
        this.isRecording = false;
        this.recordingStartTime = null;
        this.stopRequestedDuringStreamingStart = false;
        await this.cleanupStreaming();
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        logger.debug("Streaming unavailable, falling back to regular recording", {}, "streaming");
        return this.startRecording();
      }

      if (!this._streamingFailoverReason) heldFrames?.forEach((frame) => provider.send(frame));
      heldFrames = null;

      logger.info(
        "Streaming start timing",
        {
          constraintsMs: Math.round(tConstraints - t0),
          getUserMediaMs: Math.round(tMedia - tConstraints),
          pipelineMs: Math.round(tPipeline - tMedia),
          wsConnectMs: Math.round(tWs - tPipeline),
          totalMs: Math.round(tWs - t0),
          usedWarmConnection: result.usedWarmConnection,
          usedPreparedCapture,
          micWarm: isMicWarm(this._micWarmedAt, Date.now()),
        },
        "streaming"
      );

      if (this.stopRequestedDuringStreamingStart) {
        this.stopRequestedDuringStreamingStart = false;
        logger.debug("Applying deferred streaming stop requested during startup", {}, "streaming");
        return this.stopStreamingRecording();
      }
      return true;
    } catch (error) {
      const stopRequested = this.stopRequestedDuringStreamingStart;
      this._cancelActivationCapture(this._takeActivationCapture());
      this._settleStreamingStart();
      this.stopRequestedDuringStreamingStart = false;

      // A stream the pipeline never took ownership of would leak the device
      // (and, when prepared, keep the mic indicator lit) — release it here.
      if (acquiredStream && this.streamingStream !== acquiredStream) {
        acquiredStream.getTracks().forEach((track) => track.stop());
        this._markCaptureStreamReleased();
      }

      if (startWasCancelled()) {
        // The cancel ran before this start created its spool, and this path
        // skips cleanupStreaming.
        this._takeRecordingSpool()?.finish();
        return false;
      }

      if (isStaleDeviceError(error) && !forceDefaultMic && !stopRequested) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn(
          "Pinned microphone unavailable, retrying streaming on default mic",
          {},
          "streaming"
        );
        this.cachedMicDeviceId = null;
        await this.cleanupStreaming();
        this.isRecording = false;
        this.recordingStartTime = null;
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        return this.startStreamingRecording(true);
      }

      logger.error(
        "Failed to start streaming recording",
        { provider: providerName, error: error.message, code: error.code },
        "streaming"
      );

      let errorTitle = "Streaming Error";
      let errorDescription = `Failed to start streaming: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.code === "AUTH_EXPIRED" || error.code === "AUTH_REQUIRED") {
        errorTitle = "Sign-in Required";
        errorDescription =
          "Your OpenWhispr Cloud session is unavailable. Please sign in again from Settings.";
      } else if (error.code === "NETWORK_ERROR") {
        errorTitle = "streaming.errors.cloudUnreachable.title";
        errorDescription = error.messageKey || "streaming.errors.cloudUnreachable.generic";
      } else if (error.code === "LIMIT_REACHED") {
        // Titled by getRecordingErrorTitle, like the batch upload's limit error.
        errorDescription = error.message;
      } else if (error.name === "MicUnusableError") {
        errorTitle = "Microphone Muted";
        errorDescription =
          "Your microphones stayed muted and produced no audio. Please check your sound input settings and try again.";
      }

      this.onError?.({
        code: error.code,
        messageKey: error.messageKey,
        title: errorTitle,
        description: errorDescription,
      });

      await this.cleanupStreaming();
      this.isRecording = false;
      this.recordingStartTime = null;
      this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
      return false;
    } finally {
      this._startInProgress = false;
    }
  }

  // Resolves once the transcript stops moving. An outstanding partial proves its
  // final is still in flight, so only the ceiling ends the wait until it lands —
  // a plain debounce would expire on the very tail this exists to catch.
  awaitStreamingTextSettled(ceilingMs = STREAMING_FINAL_CEILING_MS) {
    return new Promise((resolve) => {
      const settle = () => {
        clearTimeout(this.streamingTextDebounce);
        clearTimeout(ceiling);
        this.streamingTextBump = null;
        this.streamingTextDebounce = null;
        resolve();
      };
      const ceiling = setTimeout(settle, ceilingMs);
      const arm = () => {
        clearTimeout(this.streamingTextDebounce);
        if (this.streamingPartialText) return;
        this.streamingTextDebounce = setTimeout(settle, STREAMING_FINAL_QUIET_MS);
      };
      this.streamingTextBump = arm;
      arm();
    });
  }

  async stopStreamingRecording() {
    if (this.streamingStartInProgress) {
      this.stopRequestedDuringStreamingStart = true;
      logger.debug("Streaming stop requested while start is in progress", {}, "streaming");
      return true;
    }

    if (this._streamingStopPromise) {
      return this._streamingStopPromise;
    }
    if (!this.isStreaming) return false;

    const sessionId = this._activeStreamingSessionId;
    const spool = this._takeRecordingSpool();
    const delivery = { activationCapture: this._takeActivationCapture() };
    if (delivery.activationCapture)
      void window.electronAPI?.stopActivationCapture?.(delivery.activationCapture).catch(() => {});
    const stopPromise = this._finalizeStreamingRecording(sessionId, delivery);
    this._streamingStopPromise = stopPromise;
    this._streamingStopMode = "finalize";
    try {
      return await stopPromise;
    } finally {
      // The stop settles at delivery; the spool waits until the result is saved.
      this._cancelActivationCapture(delivery.activationCapture);
      if (spool) void Promise.resolve(delivery.resultHandled).finally(() => spool.finish());
      if (this._streamingStopPromise === stopPromise) {
        this._streamingStopPromise = null;
        this._streamingStopMode = null;
      }
      this._endStreamingSession(sessionId);

      // Finalization has several provider/reasoning awaits. A thrown error must
      // never leave the renderer or main process stuck in a busy lifecycle.
      const needsIdleNotification = this.isRecording || this.isProcessing || this.isStreaming;
      this.isRecording = false;
      this.isProcessing = false;
      this.isStreaming = false;
      if (needsIdleNotification) {
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
      }
    }
  }

  _requestStreamingCancellation() {
    this._streamingCancellationGeneration += 1;
    ReasoningService.cancelAllRequests();
    window.electronAPI?.cancelCloudTranscription?.();
    this._activeTranscriptionAbortController?.abort();
    this._activeTranscriptionAbortController = null;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    this.screenContextPromise = null;
    this.toneStylePromise = null;
    this.selectionCapturePromise = null;
  }

  async cancelStreamingRecording() {
    this._cancelActivationCapture(this._takeActivationCapture());
    if (this._streamingStopPromise) {
      if (this._streamingStopMode === "finalize") {
        this._requestStreamingCancellation();
      }
      return this._streamingStopPromise;
    }
    if (!this.isStreaming && !this.streamingStartInProgress) {
      return false;
    }

    const sessionId = this._activeStreamingSessionId;
    const spool = this._takeRecordingSpool();
    const providerName = this.getActiveStreamingProviderName();
    const cancelPromise = (async () => {
      this._requestStreamingCancellation();
      this.stopRequestedDuringStreamingStart = false;
      this.recordingStartTime = null;
      this.isRecording = false;
      this._activeProcessingPipeline = null;
      this.isProcessing = true;
      this.micRecovery.stop();
      this.cleanupStreamingAudio();
      this.cleanupStreamingListeners(sessionId);
      this._streamingFallbackSegments = [];
      this.onStateChange?.({ isRecording: false, isProcessing: true, isStreaming: false });

      // Esc is live during managed Orukeet's cold connect, which can take seconds.
      // Stopping aborts its mint and socket, so the start settles now and the pill
      // doesn't sit busy until the connect times out.
      if (
        this.streamingStartInProgress &&
        isManagedOrukeetStream({
          providerName,
          cloudTranscriptionMode: getSettings().cloudTranscriptionMode,
        })
      ) {
        void this.getStreamingProvider(providerName)
          .stop()
          .catch(() => {});
      }

      const providerStop = this._waitForStreamingStartSettlement()
        .then(() => {
          // Startup may have attached replacement capture resources after the
          // first synchronous cleanup. Reclaim them once startup can no longer
          // mutate the session, then disconnect its provider.
          this.micRecovery.stop();
          this.cleanupStreamingAudio();
          this.cleanupStreamingListeners(sessionId);
          return this.getStreamingProvider(providerName).stop?.();
        })
        .catch((error) => {
          logger.debug(
            "Streaming disconnect after cancellation failed",
            { error: error.message },
            "streaming"
          );
        });
      await Promise.all([providerStop, this.cleanupPreview({ dismiss: true })]);
      return true;
    })();

    this._streamingStopPromise = cancelPromise;
    this._streamingStopMode = "cancel";
    try {
      return await cancelPromise;
    } finally {
      spool?.finish();
      if (this._streamingStopPromise === cancelPromise) {
        this._streamingStopPromise = null;
        this._streamingStopMode = null;
      }
      this._endStreamingSession(sessionId);
      this.isRecording = false;
      this.isProcessing = false;
      this.isStreaming = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
    }
  }

  async _finalizeStreamingRecording(sessionId, delivery = {}) {
    if (
      sessionId !== null &&
      sessionId !== undefined &&
      this._activeStreamingSessionId !== sessionId
    ) {
      return false;
    }

    const providerName = this.getActiveStreamingProviderName();
    const cancellationGeneration = this._streamingCancellationGeneration;
    const wasCancelled = () => cancellationGeneration !== this._streamingCancellationGeneration;
    const recordingQuality = this._recordingQuality;
    const abandonFinalization = async () => {
      this.cleanupStreamingAudio();
      this.cleanupStreamingListeners(sessionId);
      this._streamingFallbackSegments = [];
      try {
        await this.getStreamingProvider(providerName).stop?.();
      } catch (error) {
        logger.debug(
          "Streaming disconnect after cancellation failed",
          { error: error.message },
          "streaming"
        );
      }
      return true;
    };

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;
    const analyticsOccurredAt = new Date(this.recordingStartTime || Date.now());

    // Enter processing synchronously, before any mic/provider await. This is
    // the authoritative guard that makes a second hotkey a no-op for the full
    // finalization and reasoning interval.
    // Supersede cancelled batch work that may still be settling in the background.
    this._activeProcessingPipeline = null;
    this.isRecording = false;
    this.isProcessing = true;
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: true, isStreaming: false });

    this.micRecovery.stop();
    // Let an in-flight mic swap settle so its fallback segment isn't lost and
    // its replacement recorder doesn't outlive this stop.
    if (this._streamingMicSwapPromise) await this._streamingMicSwapPromise;
    if (wasCancelled()) return abandonFinalization();

    const t0 = performance.now();
    let finalText = this.streamingFinalText || "";

    const provider = this.getStreamingProvider(providerName);
    let acknowledgedFinal = null;
    let finalAcknowledged = false;
    let orukeetFinal = null;
    // The worklet emits PCM followed by "flushed" on the same message port.
    // IPC sends and the finalize invoke preserve that order in the main process.
    if (this.streamingProcessor && provider.finalizeAcknowledged) {
      const processor = this.streamingProcessor;
      let watchdog;
      const flushed = new Promise((resolve, reject) => {
        this._streamingFlushResolve = resolve;
        watchdog = setTimeout(
          () => reject(new Error("Audio worklet did not flush")),
          PREVIEW_FLUSH_WATCHDOG_MS
        );
      });
      processor.port.postMessage("stop");
      try {
        await flushed;
      } catch (error) {
        // Incomplete capture must use the retained recording, never commit a
        // truncated stream. Keep cleanup running so the microphone is released.
        acknowledgedFinal = Promise.resolve({ success: false, error: error.message });
      } finally {
        clearTimeout(watchdog);
        this._streamingFlushResolve = null;
        processor.disconnect();
        this.streamingProcessor = null;
      }
      if (wasCancelled()) return abandonFinalization();
      acknowledgedFinal ||= provider.finalize().catch((error) => ({
        success: false,
        error: error.message,
      }));
    } else if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch {
        /* Capture is already stopped. */
      }
      this.streamingProcessor = null;
    }
    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }
    this.streamingAnalyser = null;
    this.streamingAudioContext = null;

    // Stop fallback recorder before stopping media tracks
    let fallbackBlob = null;
    await this.finishStreamingFallbackSegment();
    if (wasCancelled()) return abandonFinalization();
    try {
      fallbackBlob = await this.mergeRecordedSegments(
        this._streamingFallbackSegments,
        recordingQuality
      );
    } catch (error) {
      logger.warn(
        "Failed to merge streaming fallback audio",
        { error: error.message },
        "streaming"
      );
      fallbackBlob = this.getLargestRecordedSegment(this._streamingFallbackSegments);
    }
    if (wasCancelled()) return abandonFinalization();
    if (fallbackBlob) {
      this.lastAudioBlob = fallbackBlob;
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this._streamingFallbackSegments = [];

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
      this._markCaptureStreamReleased();
    }
    const tAudioCleanup = performance.now();

    // 2. Wait for flushed buffer to travel: port -> main thread -> IPC -> WebSocket -> server.
    //    Then mark streaming done so no further audio is forwarded.
    if (!provider.finalizeAcknowledged) await new Promise((resolve) => setTimeout(resolve, 120));
    if (wasCancelled()) return abandonFinalization();
    this.isStreaming = false;
    const tFlush = performance.now();

    // 3. Finalize tells the provider to process any buffered audio and send final results.
    //    Wait for the transcript to settle before disconnecting.
    if (provider.finalizeAcknowledged) {
      const result = await (acknowledgedFinal || provider.finalize());
      finalAcknowledged = result?.success === true;
      if (finalAcknowledged) orukeetFinal = result;
      if (finalAcknowledged && typeof result.text === "string") {
        this.streamingFinalText = result.text;
      }
      if (!result?.success) {
        logger.warn("Streaming finalization failed", { error: result?.error }, "streaming");
      }
    } else if (provider.awaitsFinalTranscript) {
      provider.finalize?.();
      await this.awaitStreamingTextSettled(provider.finalCeilingMs);
    } else {
      provider.finalize?.();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (wasCancelled()) return abandonFinalization();
    const tForceEndpoint = performance.now();

    const stopResult = await provider.stop().catch((e) => {
      logger.debug("Streaming disconnect error", { error: e.message }, "streaming");
      return { success: false };
    });
    const tTerminate = performance.now();

    finalText =
      (provider.preferStopTranscript && stopResult?.text) || this.streamingFinalText || "";

    if (!finalText && this.streamingPartialText) {
      finalText = this.streamingPartialText;
      logger.debug("Using partial text as fallback", { textLength: finalText.length }, "streaming");
    }

    if (!finalText && stopResult?.text) {
      finalText = stopResult.text;
      logger.debug(
        "Using disconnect result text as fallback",
        { textLength: finalText.length },
        "streaming"
      );
    }

    this.cleanupStreamingListeners(sessionId);
    if (wasCancelled()) return true;

    logger.info(
      "Streaming stop timing",
      {
        durationSeconds,
        audioCleanupMs: Math.round(tAudioCleanup - t0),
        flushWaitMs: Math.round(tForceEndpoint - tAudioCleanup),
        finalSettleMs: Math.round(tForceEndpoint - tFlush),
        terminateRoundTripMs: Math.round(tTerminate - tForceEndpoint),
        totalStopMs: Math.round(tTerminate - t0),
        textLength: finalText.length,
      },
      "streaming"
    );

    const stSettings = getSettings();
    const meteredByCloud = this._streamingMeteredByCloud;
    const streamingSttModel = stopResult?.model || "nova-3";
    const streamingSttProcessingMs = Number.isFinite(orukeetFinal?.asrFinalMs)
      ? Math.round(orukeetFinal.asrFinalMs)
      : Math.round(tTerminate - t0);
    const streamingAudioBytesSent = stopResult?.audioBytesSent || 0;
    const streamingSttLanguage =
      getBaseLanguageCode(this.getEffectiveSttLanguage(stSettings)) || undefined;
    const streamingSttWordCount = countSpokenWords(finalText);
    // Reasoning below reassigns `finalText` to the cleaned-up/agent output, so
    // snapshot the pre-reasoning transcript now to report as `rawText` — matching
    // the batch path, which already keeps raw and processed text separate.
    const rawStreamingText = finalText;

    let usedBatchFallback = false;
    let batchWarning = null;
    let batchFallbackResult = null;
    let failureReport = null;
    const isOrukeetStream = providerName === "orukeet";
    const detectedLanguageFields = isOrukeetStream
      ? orukeetDetectedLanguageFields(orukeetFinal)
      : {};
    const recordingMetadata = {
      durationSeconds,
      analyticsOccurredAt: analyticsOccurredAt.toISOString(),
    };
    // How this recording ends if it ends with no text, decided once: when a
    // re-transcription heard nothing, or at the end.
    let emptyDictation = null;
    const endEmptyDictation = (source, code = null) => {
      emptyDictation ??= this._endEmptyDictation({
        durationMs: Number.isFinite(durationSeconds) ? durationSeconds * 1000 : null,
        source,
        code,
        gate: getLocalSpeechGateDecision(this._streamingSpeechGateState),
      });
      return emptyDictation;
    };
    const failStreamingRecording = (error) =>
      this._failStreamingRecording(error, {
        blob: fallbackBlob,
        metadata: recordingMetadata,
        delivery,
        emptyDictation: transcriptionFailureOutcome(error).noAudio
          ? endEmptyDictation("provider", error.code)
          : null,
      });
    const languageRouting = evaluateOrukeetLanguageRouting({
      language: streamingSttLanguage,
      final: orukeetFinal,
      mode:
        isOrukeetStream && stSettings.cloudTranscriptionMode === "openwhispr"
          ? (this._activeStreamingConfig || this.sttConfig)?.orukeetLanguageRouting
          : undefined,
    });
    const orukeetLanguageRouting = languageRouting.comparison
      ? {
          ...languageRouting.comparison,
          fallbackAvailable:
            fallbackBlob?.size > 0 && resolveStreamingFallbackTarget(stSettings) === "cloud",
        }
      : undefined;
    const orukeetCleanup = orukeetFinal?.cleanup;
    const orukeetTelemetry = { orukeetLanguageRouting, orukeetCleanup };
    // A request whose text isn't the combined cleanup (a language fallback, a
    // cleanup redone through /api/reason, an agent command) must not report a
    // completed Gemma cleanup as its own.
    const uncombinedTelemetry = {
      orukeetLanguageRouting,
      orukeetCleanup: orukeetCleanup?.status === "complete" ? undefined : orukeetCleanup,
    };
    if (isOrukeetStream && languageRouting.comparison) {
      logger.info(
        "Orukeet language routing comparison",
        {
          ...languageRouting.comparison,
          fallbackAvailable:
            fallbackBlob?.size > 0 && resolveStreamingFallbackTarget(stSettings) === "cloud",
        },
        "streaming"
      );
    }

    // Orukeet renders speech outside its 25 languages as confident nonsense.
    // With a confident final estimate, send the kept recording through Cloud
    // as the same "auto" request the user makes without Orukeet, before any
    // cleanup spends a call on the discarded text.
    if (
      isOrukeetStream &&
      fallbackBlob?.size > 0 &&
      resolveStreamingFallbackTarget(stSettings) === "cloud" &&
      languageRouting.fallback
    ) {
      logger.info(
        "Orukeet detected an unsupported language, re-transcribing through Cloud",
        detectedLanguageFields,
        "streaming"
      );
      // Orukeet's text is the nonsense this path exists to catch, so it is
      // never kept: a failed re-transcription ends as a batch recording's would.
      const failLanguageFallback = (error) => {
        logger.error(
          "Language re-transcription failed, discarding the Orukeet transcript",
          { error: error.message, code: error.code },
          "streaming"
        );
        finalText = "";
        failureReport = failStreamingRecording(error);
      };
      try {
        const batchResult = await this.processWithOpenWhisprCloud(
          fallbackBlob,
          {
            durationSeconds,
            analyticsOccurredAt: analyticsOccurredAt.toISOString(),
            streamingFallbackReason:
              languageRouting.comparison && !languageRouting.comparison.legacyFallback
                ? "language_supported_score_low"
                : "language_detected_unsupported",
            detectedLanguageFields,
            ...uncombinedTelemetry,
          },
          wasCancelled
        );
        if (wasCancelled()) return true;
        if (batchResult?.text) {
          finalText = batchResult.text;
          usedBatchFallback = true;
          batchFallbackResult = batchResult;
          batchWarning = batchResult.warning || null;
        } else {
          failLanguageFallback(
            Object.assign(new Error("No speech detected in audio"), { code: "NO_SPEECH_DETECTED" })
          );
        }
      } catch (languageFallbackErr) {
        if (wasCancelled()) return true;
        failLanguageFallback(languageFallbackErr);
      }
    }

    let usedCloudReasoning = false;
    let combinedCleanup = false;
    let streamingTrace = null;
    // The Cloud batch path already ran its own boundary (glossary, cleanup,
    // agent or translation); the streamed text gets exactly one here.
    if (finalText && !usedBatchFallback) {
      const isCloudCleanup = isCloudCleanupMode();
      // The metadata a Cloud cleanup of the streamed text carries.
      const cloudCleanupMeta = {
        sttProvider: providerName,
        sttModel: streamingSttModel,
        sttProcessingMs: streamingSttProcessingMs,
        sttWordCount: streamingSttWordCount,
        sttLanguage: streamingSttLanguage,
        ...detectedLanguageFields,
        ...uncombinedTelemetry,
        audioDurationMs: durationSeconds ? Math.round(durationSeconds * 1000) : undefined,
        audioSizeBytes: streamingAudioBytesSent || undefined,
        audioFormat: "linear16",
      };
      let post;
      try {
        post = await this.postTranscribe(finalText, {
          source: "streaming",
          settings: stSettings,
          wasCancelled,
          detectedLanguage: streamingSttLanguage,
          stt: {
            provider: providerName,
            model: streamingSttModel,
            ms: streamingSttProcessingMs,
          },
          // A styled recording cleans up through the same Cloud endpoint, with
          // the same metadata, as the cleanup route below.
          cleanupRoute: isCloudCleanup ? { mode: "cloudReason", meta: cloudCleanupMeta } : null,
          run: async ({ rawText: routeText, workingText, recordStep, setRoute }) => {
            let text = workingText;
            const reasoningStart = performance.now();
            const agentName = getAgentName();
            const screenContext = this.voiceAgentRequested
              ? await this.consumeScreenContext()
              : null;
            if (wasCancelled()) return text;
            const route = resolveReasoningRoute(
              routeText,
              stSettings,
              agentName,
              this.voiceAgentRequested,
              this.translationRequested,
              screenContext,
              streamingSttLanguage
            );
            setRoute(route.kind);
            if (this.translationRequested && route.kind !== "translation") {
              this.notifyTranslationFallback("unreachable");
            }
            this._noteCleanupRoute(stSettings, route);
            const toneStyle = route.kind === "cleanup" ? await this.consumeToneStyle() : null;

            try {
              if (route.kind === "agent") {
                const reasoned = await recordStep("agent", {}, (dispatched) =>
                  this.processAgentCommand(
                    text,
                    route.model,
                    agentName,
                    {
                      ...route.config,
                      requiresAgent: true,
                      onDispatch: dispatched,
                    },
                    wasCancelled
                  )
                );
                if (hasTextContent(reasoned)) text = reasoned;
                logger.info(
                  "Streaming dictation-agent complete",
                  { reasoningDurationMs: Math.round(performance.now() - reasoningStart) },
                  "streaming"
                );
              } else if (route.kind === "cleanup" && isCloudCleanup) {
                let cloudModel = null;
                // The route's one snapshot of cleanup's word set, flat (never the grouping).
                const dictionary =
                  route.config?.cleanupDictionary ?? selectCleanupDictionary(stSettings);
                // Orukeet's combined cleanup (#2436) cleaned what it heard, with
                // the options its session was minted with: it stands for this
                // cleanup only when those are this dictation's and the glossary
                // changed nothing, else /api/reason cleans up the corrected text.
                // ASR finished but the combined cleanup didn't: the corrected
                // text is pasted, as for any other failed cleanup.
                if (orukeetFinal?.cleanupError) {
                  throw Object.assign(
                    new Error(`Combined cleanup did not finish: ${orukeetFinal.cleanupError}`),
                    { messageKey: "app.toasts.cleanupFailed.title" }
                  );
                }
                combinedCleanup =
                  orukeetFinal?.cleanupStatus === "complete" &&
                  JSON.stringify(orukeetFinal.cleanupOptions) ===
                    JSON.stringify(this._activePipelineOptions) &&
                  typeof orukeetFinal.cleanupText === "string" &&
                  hasTextContent(orukeetFinal.cleanupText) &&
                  text.trim() === String(routeText ?? "").trim();
                const cleaned = await recordStep(
                  "cleanup",
                  {
                    provider: "openwhispr",
                    prompt: SERVER_PROMPT_REF,
                    detail: { dictionaryScope: dictionary.scope },
                  },
                  async (dispatched) => {
                    const customPrompt = this.getCustomPrompt();
                    const reasonResult = combinedCleanup
                      ? {
                          success: true,
                          text: orukeetFinal.cleanupText,
                          model: orukeetCleanup?.model,
                        }
                      : await withSessionRefresh(async () => {
                          const res = await window.electronAPI.cloudReason(text, {
                            agentName,
                            promptMode: "cleanup",
                            purpose: "cleanup",
                            ...toCloudDictionaryFields(dictionary.words, stSettings),
                            customPrompt,
                            ...toneStyle,
                            language: this.getCleanupLanguage(stSettings),
                            locale: stSettings.uiLanguage || "en",
                            ...cloudCleanupMeta,
                          });
                          if (!res.success) {
                            const err = new Error(res.error || "Cloud reasoning failed");
                            err.code = res.code;
                            throw err;
                          }
                          return res;
                        });

                    usedCloudReasoning = !combinedCleanup;
                    cloudModel = reasonResult.model;
                    dispatched({ model: reasonResult.model });
                    if (!(reasonResult.success && hasTextContent(reasonResult.text))) return null;
                    if (!customPrompt) return finishCleanupOutput(text, reasonResult.text);
                    return reasonResult.text;
                  }
                );
                if (hasTextContent(cleaned)) text = cleaned;

                logger.info(
                  "Streaming reasoning complete",
                  {
                    reasoningDurationMs: Math.round(performance.now() - reasoningStart),
                    model: cloudModel,
                    combinedCleanup,
                  },
                  "streaming"
                );
              } else if (route.kind === "cleanup") {
                const effectiveModel = getEffectiveCleanupModel();
                if (effectiveModel) {
                  const reasoned = await recordStep(
                    "cleanup",
                    cleanupStepMeta(route.config),
                    (dispatched) =>
                      this.processWithReasoningModel(text, effectiveModel, agentName, {
                        ...route.config,
                        toneStyle,
                        onDispatch: dispatched,
                      })
                  );
                  if (hasTextContent(reasoned)) text = reasoned;
                  logger.info(
                    "Streaming BYOK reasoning complete",
                    { reasoningDurationMs: Math.round(performance.now() - reasoningStart) },
                    "streaming"
                  );
                }
              } else if (route.kind === "translation") {
                const chainResult = await this.runTranslationChain({
                  text,
                  settings: stSettings,
                  agentName,
                  route,
                  cleanup: isCloudCleanup
                    ? {
                        mode: "cloudReason",
                        meta: cloudCleanupMeta,
                        log: { level: "error", channel: "streaming" },
                      }
                    : {
                        mode: "model",
                        model: getEffectiveCleanupModel(),
                        log: { level: "error", channel: "streaming" },
                      },
                  recordStep,
                });
                text = resolveTranslatedText(text, chainResult);
                usedCloudReasoning = chainResult.usedCloudReasoning || usedCloudReasoning;
              }
            } catch (reasonError) {
              if (wasCancelled()) return text;
              if (reasonError.selectionEditFatal) throw reasonError;
              logger.error(
                "Streaming reasoning failed, using the corrected text",
                { error: reasonError.message },
                "streaming"
              );
              if (route.kind === "cleanup") {
                this.pendingCleanupFailure = cleanupFailureFromError(reasonError);
              }
              if (route.kind === "agent") this._notifyAgentReasoningFailed();
            }
            return text;
          },
        });
      } catch (reasonError) {
        if (wasCancelled()) return true;
        if (!reasonError?.selectionEditFatal) throw reasonError;
        this.pendingSelectionEdit = null;
        // The streamed transcript stays on the failed row (#2678), which the
        // card's Open in History opens.
        attachTranscript(reasonError, rawStreamingText);
        let resolveRowId = null;
        const rowId = new Promise((resolve) => {
          resolveRowId = resolve;
        });
        delivery.resultHandled = this.saveFailedTranscription(
          reasonError.message,
          reasonError.code || null,
          recordingMetadata,
          { onRowSaved: resolveRowId, transcript: reasonError.transcript }
        );
        this.onError?.({
          ...transcriptionFailureOutcome(reasonError).report,
          historyRowId: rowId,
        });
        this.isProcessing = false;
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        return false;
      }
      if (wasCancelled()) return true;
      finalText = post.text;
      streamingTrace = post.trace;
      // A styled recording's Cloud cleanup ran inside the style route.
      if (
        traceStyle(post.trace) &&
        post.trace.steps.some(
          (step) =>
            step.kind === "cleanup" && step.provider === "openwhispr" && step.outcome === "ok"
        )
      ) {
        usedCloudReasoning = true;
      }
    }
    // If streaming produced no text, fall back to batch — routed so BYOK audio
    // and cloud audio never cross over (see resolveStreamingFallbackTarget).
    const failoverReason = this._streamingFailoverReason;
    // No stream will transcribe a failed-over recording, so it uploads at any
    // length, unless it was the silence the batch speech gate skips.
    const failoverSilent =
      Boolean(failoverReason) &&
      getLocalSpeechGateDecision(this._streamingSpeechGateState).reason === "silence";
    if (failoverSilent) {
      logger.info("Speech gate skipped the failed-over upload", { failoverReason }, "streaming");
    }
    // A failed-over recording has no other transcript, so a failure to
    // transcribe it ends as a batch recording's would, its recording kept for
    // the card's Retry. A stream that produced no text still ends quietly on a
    // real failure, but keeps a recording that reads as silence for a retry,
    // as batch does.
    const failBatchFallback = (error) => {
      // A transcript the fallback produced before a later step failed is
      // reported and kept like the batch pipeline's (#2678).
      if (!failoverReason && transcriptionFailureOutcome(error).report && !error.transcript) {
        return;
      }
      failureReport = failStreamingRecording(error);
    };
    if (
      !finalText &&
      (failoverReason ? !failoverSilent : !finalAcknowledged && durationSeconds > 2) &&
      fallbackBlob?.size > 0
    ) {
      const target = resolveStreamingFallbackTarget(getSettings());
      if (target === "skip") {
        logger.warn(
          "Skipping batch fallback: OpenWhispr Cloud session signed out",
          {},
          "streaming"
        );
        failBatchFallback(cloudSignInRequiredError());
      } else {
        logger.info(
          "Streaming produced no text, falling back to batch transcription",
          { durationSeconds, blobSize: fallbackBlob.size, target },
          "streaming"
        );
        try {
          // Cloud records usage server-side via /api/transcribe; BYOK has no metering.
          const batchResult =
            target === "cloud"
              ? await this.processWithOpenWhisprCloud(
                  fallbackBlob,
                  {
                    durationSeconds,
                    analyticsOccurredAt: analyticsOccurredAt.toISOString(),
                    // The tag feeds the Orukeet rollout's fallback rate; other
                    // providers still fall back, just untagged. Only managed
                    // Orukeet fails over, and its reason outlives the cached
                    // config a refused start drops.
                    ...(failoverReason || isOrukeetStream
                      ? { streamingFallbackReason: failoverReason || "stream_no_final" }
                      : {}),
                  },
                  wasCancelled
                )
              : await this.processWithOpenAIAPI(fallbackBlob, { durationSeconds }, wasCancelled);
          if (wasCancelled()) return true;
          if (batchResult?.text) {
            finalText = batchResult.text;
            usedBatchFallback = true;
            batchFallbackResult = batchResult;
            batchWarning = batchResult.warning || null;
            logger.info("Batch fallback succeeded", { textLength: finalText.length }, "streaming");
          }
        } catch (fallbackErr) {
          // The cancelled upload's rejection is the expected outcome.
          if (wasCancelled()) return true;
          logger.error("Batch fallback failed", { error: fallbackErr.message }, "streaming");
          failBatchFallback(fallbackErr);
        }
      }
    }

    if (finalText) {
      // Both the streamed text (above) and the batch fallback (inside its own
      // boundary) are already finalized, Chinese script included.
      const tBeforePaste = performance.now();
      const clientTotalMs = Math.round(tBeforePaste - t0);
      const clientTranscriptionId =
        batchFallbackResult?.clientTranscriptionId || crypto.randomUUID();
      const resultAnalyticsOccurredAt =
        batchFallbackResult?.analyticsOccurredAt || analyticsOccurredAt.toISOString();
      this.lastAudioMetadata = {
        durationMs: durationSeconds
          ? Math.round(durationSeconds * 1000)
          : Math.round(tBeforePaste - t0),
        provider: batchFallbackResult?.source || `${providerName}-streaming`,
        model: batchFallbackResult ? null : streamingSttModel || null,
      };
      if (wasCancelled()) return true;
      const recordingTrace = batchFallbackResult ? batchFallbackResult.trace : streamingTrace;
      await this._completeActivationCapture(delivery.activationCapture, {
        success: true,
        rawText: batchFallbackResult?.rawText ?? rawStreamingText,
        assistantConversation: this.pendingAssistantConversation,
        selectionEdit: this.pendingSelectionEdit,
      });
      if (wasCancelled()) return true;
      delivery.resultHandled = this.onTranscriptionComplete?.({
        success: true,
        text: finalText,
        rawText: batchFallbackResult?.rawText || rawStreamingText || finalText,
        // Exactly one boundary ran for this recording: the batch fallback's or
        // the stream's.
        ...(recordingTrace ? { trace: recordingTrace } : {}),
        source: batchFallbackResult?.source || `${providerName}-streaming`,
        clientTranscriptionId,
        analyticsOccurredAt: resultAnalyticsOccurredAt,
        // The upgrade prompt opens on these, as after a batch recording.
        ...(batchFallbackResult?.limitReached
          ? {
              limitReached: true,
              wordsUsed: batchFallbackResult.wordsUsed,
              wordsRemaining: batchFallbackResult.wordsRemaining,
            }
          : {}),
        ...this._takePendingResultExtras(),
        ...(batchWarning ? { warning: batchWarning } : {}),
      });

      // Only a stream on OpenWhispr Cloud credentials draws on the account's
      // word allowance; opted-in history and insights sync push the local row
      // of every other stream themselves.
      if (!usedBatchFallback && meteredByCloud) {
        (async () => {
          try {
            await withSessionRefresh(async () => {
              const res = await window.electronAPI.cloudStreamingUsage(
                combinedCleanup ? rawStreamingText : finalText,
                durationSeconds ?? 0,
                {
                  sendLogs: !usedCloudReasoning,
                  sttProvider: providerName,
                  sttModel: streamingSttModel,
                  sttProcessingMs: streamingSttProcessingMs,
                  sttLanguage: streamingSttLanguage,
                  ...detectedLanguageFields,
                  ...(combinedCleanup ? orukeetTelemetry : uncombinedTelemetry),
                  audioSizeBytes: streamingAudioBytesSent || undefined,
                  audioFormat: "linear16",
                  clientTotalMs,
                  // Always sent, like the batch cloud path: this id is what
                  // makes the row the server writes and the local one the same
                  // event. Held back until opt-in, a later sync would push the
                  // local copy under a second id and double every total.
                  clientTranscriptionId,
                  ...(analyticsSyncEnabled()
                    ? {
                        localDate: localDateKey(analyticsOccurredAt),
                        analyticsOccurredAt: analyticsOccurredAt.toISOString(),
                        analyticsWordCount: streamingSttWordCount,
                        analyticsCounterVersion: ANALYTICS_COUNTER_VERSION,
                      }
                    : {}),
                }
              );
              if (!res.success) {
                const err = new Error(res.error || "Streaming usage recording failed");
                err.code = res.code;
                throw err;
              }
            });
          } catch (err) {
            logger.error(
              "Failed to report streaming usage",
              { error: err.message, clientTranscriptionId },
              "streaming"
            );
          }
          window.dispatchEvent(new Event("usage-changed"));
        })();
      } else if (batchFallbackResult?.source === "openwhispr") {
        // /api/transcribe recorded the Cloud upload's words.
        window.dispatchEvent(new Event("usage-changed"));
      }

      logger.info(
        "Streaming total processing",
        {
          totalProcessingMs: Math.round(tBeforePaste - t0),
          hasReasoning: stSettings.useCleanupModel || stSettings.useDictationAgent,
        },
        "streaming"
      );
    }

    this.isProcessing = false;
    this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });

    if (wasCancelled()) return true;

    if (failureReport) {
      this.onError?.(failureReport);
    } else if (!finalText) {
      // Match the batch pipeline: settle processing first, then publish the
      // empty outcome so the warning cannot interrupt the thinking transition.
      const ended = emptyDictation ?? endEmptyDictation(failoverSilent ? "gate" : "result");
      // A failed re-transcription that heard nothing already saved what it keeps.
      if (ended.outcome === "quiet" && !delivery.resultHandled) {
        delivery.resultHandled = this._saveQuietEmptyDictation(fallbackBlob, recordingMetadata);
      }
      this.onTranscriptionComplete?.({ success: true, text: "", emptyDictation: ended });
    }

    if (this.shouldUseStreaming()) {
      this.warmupStreamingConnection().catch((e) => {
        logger.debug("Background re-warm failed", { error: e.message }, "streaming");
      });
    }

    return true;
  }

  shouldShowPreviewCleanupState() {
    const settings = getSettings();
    return (
      !!settings.useCleanupModel ||
      !!settings.useDictationAgent ||
      (this.translationRequested && !!settings.useDictationTranslation)
    );
  }

  async cleanupPreview(options = {}) {
    const { dismiss = false, showCleanup = false } = options;

    // Claim the session's nodes synchronously so a recording started during the
    // flush await can never have its fresh nodes torn down by this cleanup.
    const processor = this._previewProcessor;
    const source = this._previewSource;
    const audioContext = this._previewAudioContext;
    this._previewProcessor = null;
    this._previewSource = null;
    this._previewAudioContext = null;

    let flushed = true;
    if (processor) {
      // The worklet posts all PCM before "flushed", and the PCM sends share the
      // renderer->main pipe with the stop invoke (FIFO), so the final chunk precedes finish.
      let resolveFlush;
      const flushSentinel = new Promise((resolve) => {
        resolveFlush = () => resolve(true);
      });
      let watchdogTimer;
      const watchdogFired = new Promise((resolve) => {
        watchdogTimer = setTimeout(() => resolve(false), PREVIEW_FLUSH_WATCHDOG_MS);
      });
      this._previewFlushResolve = resolveFlush;
      processor.port.postMessage("stop");
      flushed = await Promise.race([flushSentinel, watchdogFired]);
      clearTimeout(watchdogTimer);
      if (this._previewFlushResolve === resolveFlush) this._previewFlushResolve = null;
      processor.disconnect();
    }
    source?.disconnect();
    audioContext?.close().catch(() => {});
    if (dismiss) {
      window.electronAPI?.dismissDictationPreview?.();
      return null;
    }
    return (await window.electronAPI?.stopDictationPreview?.({ showCleanup, flushed })) || null;
  }

  cleanupStreamingAudio() {
    this._streamingFlushResolve?.();
    this._streamingFlushResolve = null;
    if (this.streamingFallbackRecorder?.state === "recording") {
      try {
        this.streamingFallbackRecorder.stop();
      } catch {}
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];

    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingProcessor = null;
    }

    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }

    this.streamingAnalyser = null;
    this.streamingAudioContext = null;

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
      this._markCaptureStreamReleased();
    }

    this.isStreaming = false;
  }

  cleanupStreamingListeners(sessionId = null) {
    if (
      sessionId !== null &&
      sessionId !== undefined &&
      this._activeStreamingSessionId !== sessionId
    ) {
      return;
    }
    for (const cleanup of this.streamingCleanupFns) {
      try {
        cleanup?.();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextBump = null;
    clearTimeout(this.streamingTextDebounce);
    this.streamingTextDebounce = null;
  }

  async cleanupStreaming() {
    const sessionId = this._activeStreamingSessionId;
    this.micRecovery.stop();
    this._takeRecordingSpool()?.finish();
    this.cleanupStreamingAudio();
    this.cleanupStreamingListeners(sessionId);
    this._endStreamingSession(sessionId);
  }

  cleanup() {
    // Read before cleanupStreaming ends the session below.
    const streamingProviderName = this.getActiveStreamingProviderName();
    this.micRecovery.stop();
    this._unsubscribeSettings?.();
    this.preparedMicCapture.cancel();
    this._closeBatchPcmTap();
    this.micStreamHold.drop();
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    if (this.isStreaming) {
      this.cleanupStreaming();
    }
    const recorder = this.mediaRecorder;
    if (recorder?.state === "recording") {
      this.stopRecording();
    }
    // onstop may run after the owner unmounts and releases its reservation.
    recorder?.stream?.getTracks().forEach((track) => track.stop());
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      this.persistentAudioContext.close().catch(() => {});
      this.persistentAudioContext = null;
      this.workletModuleLoaded = false;
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    try {
      this.getStreamingProvider(streamingProviderName).stop?.();
    } catch (e) {
      // Ignore errors during cleanup (page may be unloading)
    }
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.onStreamingCommit = null;
    if (this._onApiKeyChanged) {
      window.removeEventListener("api-key-changed", this._onApiKeyChanged);
    }
    if (this._onDeviceChange) {
      navigator.mediaDevices?.removeEventListener?.("devicechange", this._onDeviceChange);
    }
  }
}

export { resolveReasoningRoute, copilotPrewarmWanted };
export default AudioManager;

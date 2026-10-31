import type { ModelDefinition } from "../models/ModelRegistry";
import type { ReasoningConfig } from "../services/BaseReasoningService";
import type { PermissionGuideState, PermissionGuideAction } from "./permissionGuide";
import type { TinfoilCatalogModel } from "../models/tinfoilModels";
import type { UsageResponse } from "../lib/usageStore";
import type { OrgPolicy } from "./policy";
import type { TechnicalErrorDetailsData } from "../components/ui/useToast";
import type { ProviderSettingsTarget } from "../utils/describeProviderError";
import type {
  ManagedEnterpriseConfig,
  ManagedEnterpriseRequestContext,
} from "./enterpriseIdentity";
import type {
  CalendarAvailabilityRequest,
  CalendarAvailabilityResult,
  MicrosoftCalendarAccount,
} from "./calendar";
import type {
  ConnectorActionRecord,
  ConnectorCancelConnectResult,
  ConnectorCancelReason,
  ConnectorCommitResult,
  ConnectorConnectProgress,
  ConnectorConnectResult,
  ConnectorDirectResult,
  ConnectorDisconnectResult,
  ConnectorEdits,
  ConnectorPrepareResult,
  ConnectorQueryResult,
  ConnectorStatus,
  ContactMatch,
  NoteAttendee,
  NoteAttendeesRequest,
} from "./connectors";
import type { GlossaryRule, GlossarySnapshot, GlossarySpelling } from "../utils/glossary";
import type { PostTranscriptionTrace } from "../helpers/postTranscription";
import type { StyleHotkeyResult, StyleHotkeyState } from "../config/styles/library";
import type { CustomConnectionSlot } from "../config/customConnection";

export type LocalTranscriptionProvider = "whisper" | "nvidia" | "cohere";

/** Check connection on the custom connection: reachability and key, never a key or body. */
export interface CustomConnectionCheckResult {
  status: "ok" | "auth" | "network" | "invalid" | "blocked";
  httpStatus?: number;
  /** Azure deployments, when the resource listed them. */
  deployments?: Array<{ id: string; model: string }>;
  discovery: "listed" | "unavailable";
}

export type DictionaryEntrySource = "manual" | "learned";

export interface DictionaryEntry {
  word: string;
  source: DictionaryEntrySource;
  /** When the word was added (SQLite's UTC format or ISO); null for a row without one. */
  createdAt?: string | null;
  /** When it last changed (a rename, a source change); falls back to createdAt. */
  updatedAt?: string | null;
}

/** "Learn from your corrections" (Settings › Dictation › Output). */
export type AutoLearnMode = "suggest" | "add" | "off";

/**
 * What Re-transcribe sends its speech-to-text hints from: the stored words in
 * stored order, pinned keys in pin order, the glossary's canonical forms,
 * snippet triggers, the Chinese script preference, the order of the unpinned
 * words and their usage scores (`[key, missedRows, written]`, bounded; main
 * validates them: sttHintFields.js). Main reads the learned words itself.
 */
export interface RetryHintDictionary {
  words: string[];
  pinned: string[];
  glossaryTerms: string[];
  snippets: Array<{ trigger: string }>;
  chineseScriptPreference: string | null;
  hintOrder?: "evidence" | "added";
  scores?: Array<[key: string, missedRows: number, written: number]>;
}

/** What a suggested word replaced, in which app (exe name), for which dictation. */
export interface DictionarySuggestionEvidence {
  replaced: string;
  app: string | null;
  createdAt: string;
  transcriptionId: number;
}

/** A word auto-learn suggested (Suggest mode), with this owner's evidence. */
export interface DictionarySuggestion {
  id: number;
  word: string;
  /** How many times it was learned while pending. */
  times: number;
  createdAt: string;
  updatedAt: string;
  evidence: DictionarySuggestionEvidence[];
}

export interface DictionarySuggestionList {
  success?: boolean;
  suggestions: DictionarySuggestion[];
  /** How many words were dismissed (never suggested again). */
  dismissed: number;
}

/** One dictionary word's counts over local History (dictionaryUsage.js). */
export interface DictionaryWordUsage {
  word: string;
  /** Rows whose raw transcript has it. */
  heard: number;
  /** Rows whose final text has it ("used"). */
  written: number;
  /** Rows where the final text has it and the raw transcript doesn't ("fixed after speech"). */
  missedRows: number;
  /** Rows whose raw transcript and final text both have it ("speech got it"). */
  bothRows?: number;
}

export type DictionaryUsageResult =
  | {
      available: true;
      computedAt: string;
      days: number;
      rows: number;
      words: DictionaryWordUsage[];
      /** Dictations a day over the last 30 days (the monthly token estimate). */
      pace?: { perDay: number };
    }
  | { available: false; reason?: string };

/** One week of a word's counts (the word detail's chart). */
export interface DictionaryUsageWeek {
  /** The week's first moment (ISO). */
  start: string;
  /** Its end (ISO), exclusive: the week is `[start, end)`. The click filter uses these bounds. */
  end?: string;
  heard: number;
  /** "Used": rows whose final text has it. */
  written: number;
  /** "Fixed after speech". */
  missedRows: number;
  /** "Speech got it": raw and final both have it. */
  both?: number;
  /** "Changed after speech": raw has it, final doesn't. */
  changed?: number;
}

export type DictionaryWordUsageResult =
  | { available: true; days: number; weeks: DictionaryUsageWeek[] }
  | { available: false; reason?: string };

/** What happened to a dictionary word at one place in a dictation (dictionaryOccurrences.js). */
export type DictionaryAppearanceKind = "ok" | "fix" | "chg";
/** Who fixed it, only when this owner's recorded steps show it. */
export type DictionaryFixedBy = "glossary" | "cleanup" | "style";

/** A dictation's text around one appearance: final text, or the raw transcript for "chg". */
export interface DictionaryOccurrenceSnippet {
  kind: DictionaryAppearanceKind;
  before: string;
  match: string;
  after: string;
}

/** One dictation a word appeared in ("Where it appeared"). */
export interface DictionaryOccurrence {
  id: number;
  /** History's timestamp. */
  at: string | null;
  /** From this owner's steps; null without them. */
  app: string | null;
  /** The kinds of its appearances; several when the dictation is mixed. */
  kinds: DictionaryAppearanceKind[];
  /** For a fix: what speech wrote there, as written; null when ambiguous. */
  speechWrote: string | null;
  by: DictionaryFixedBy | null;
  snippet: DictionaryOccurrenceSnippet;
}

export interface DictionaryOccurrencesRequest {
  /** One kind, or all of them. */
  kind?: DictionaryAppearanceKind | null;
  /** A histogram week's bounds, `[start, end)`. */
  range?: { start: string; end: string } | null;
  cursor?: HistoryCursor | null;
  /** 1–50, 20 by default. */
  limit?: number;
}

export type DictionaryOccurrencesResult =
  | {
      available: true;
      generation: number | null;
      items: DictionaryOccurrence[];
      nextCursor: HistoryCursor | null;
      /** Dictations with an appearance of each kind (a mixed one in each); `all`: with any. */
      totals: { all: number; ok: number; fix: number; chg: number };
      /** Dictations with the word too long to align: counted by the row summaries only. */
      unaligned?: number;
    }
  | { available: false; reason?: string };

/** A spelling speech wrote where the final text has the word ("Speech writes it as"). */
export interface DictionarySpeechVariant {
  spelling: string;
  /** Dictations it was fixed from. */
  count: number;
  /** Dictations whose final text still has this spelling: a rule could harm them. */
  keptInFinal: number;
}

export type DictionarySpeechVariantsResult =
  | {
      available: true;
      generation: number | null;
      variants: DictionarySpeechVariant[];
      /** The spelling asked for (`options.spelling`), whether or not it's among the top. */
      requested?: DictionarySpeechVariant | null;
    }
  | { available: false; reason?: string };

/** A dictionary word in one History row: `start`/`end` into the final text, or the raw transcript for "chg". */
export interface HistoryDictionaryAppearance {
  kind: DictionaryAppearanceKind;
  start: number;
  end: number;
  speechWrote: string | null;
  by: DictionaryFixedBy | null;
}

export interface HistoryDictionaryWord {
  word: string;
  appearances: HistoryDictionaryAppearance[];
}

export type DictionaryWordEvidenceResult = {
  available: boolean;
  reason?: string;
  evidence: DictionarySuggestionEvidence[];
};

/** How this owner's cleanups ran with one dictionary word set (counts only). */
export interface CleanupScopeCount {
  applied: string;
  dictations: number;
  avgWords: number;
}

export type CleanupScopeCountsResult =
  | { available: true; days: number; sets: CleanupScopeCount[] }
  | { available: false; reason?: string };

export type DictionaryRenameResult =
  | { success: true; changed: boolean; word: string }
  | { success: false; code: string; existing?: string };

export type DictionaryMergeResult =
  { success: true; word: string; source: DictionaryEntrySource } | { success: false; code: string };

/** A History token and the rows of the last 90 days it appears in (Tidy up). */
export interface DictionaryTidyToken {
  token: string;
  rows: number;
}

/** Two dictionary words seen side by side: `a` the one that usually comes first. */
export interface DictionaryTidyPair {
  a: string;
  b: string;
  /** Rows with them next to each other, in either order. */
  together: number;
  /** Rows containing the rarer of the two. */
  rarerRows: number;
}

/** Tidy up's History aggregates (dictionaryUsage.js): words and counts only. */
export type DictionaryTidyInputsResult =
  | {
      available: true;
      days: number;
      rows: number;
      frequentTokens: DictionaryTidyToken[];
      adjacency: DictionaryTidyPair[];
    }
  | { available: false; reason?: string };

/** One Tidy up choice, applied by main through the dictionary's own operations. */
export type DictionaryTidyOp =
  | { kind: "remove"; words: string[] }
  | { kind: "merge"; from: string; into: string }
  | { kind: "respell"; from: string; to: string }
  | { kind: "add-phrase"; phrase: string; parts: string[] };

/** A removed word as it was: what an Undo puts back. */
export interface DictionaryRestoreEntry {
  word: string;
  source: DictionaryEntrySource;
  createdAt: string | null;
  pinned: boolean;
  /** Its place in the pin order when it was pinned (0 first); null when unknown. */
  pinPosition?: number | null;
}

/** One step that reverses part of a Tidy up action (database.js undoDictionaryTidy). */
export type DictionaryTidyUndoStep =
  | { rename: { from: string; to: string } }
  | {
      restore: DictionaryRestoreEntry[];
      /** Words the restored ones were merged into: they must still be there. */
      into?: string[];
      /** Words the action left that must still be spelled so. */
      expect?: string[];
      /** Words to take out again (a phrase Tidy up added). */
      remove?: string[];
      /** Words to unpin (what a merge pinned). */
      unpin?: string[];
      /** Pins a merge moved up, back to their own place. */
      repin?: Array<{ word: string; position: number }>;
    };

export interface DictionaryTidyOpResult {
  ok: boolean;
  kind: DictionaryTidyOp["kind"] | null;
  code?: string;
  removed?: number;
  merged?: number;
  renamed?: number;
  added?: number;
  undo?: DictionaryTidyUndoStep[];
}

export type DictionaryTidyApplyResult =
  { success: true; results: DictionaryTidyOpResult[] } | { success: false; code: string };

export type DictionaryTidyUndoResult =
  | { success: true; steps?: number }
  | { success: false; code: string; word?: string; existing?: string };

/** A glossary rule as the editor saves it: no id creates one. */
export interface GlossaryRuleInput {
  id?: string;
  canonical: string;
  spellings: GlossarySpelling[];
  apps: string[];
  enabled: boolean;
}

export interface GlossarySaveResult {
  success: boolean;
  rule?: GlossaryRule;
  snapshot?: GlossarySnapshot;
  error?: string;
  code?: string | null;
}

// Where the floating icon rests; "center" is the legacy spelling of
// bottom-center. Values come from src/helpers/floatingIconPlacement.js.
export type PanelPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "center"
  | "bottom-right";

// A connected display as offered by the floating icon's Display setting.
export interface FloatingIconDisplayInfo {
  id: string;
  label: string;
  primary: boolean;
  bounds: Electron.Rectangle;
  workArea: Electron.Rectangle;
  scaleFactor: number;
}

// How OpenWhispr shows that the microphone is live. Values come from
// src/helpers/recordingIndicator.js.
export type RecordingIndicatorStyle = "classic" | "tinted" | "solid" | "beacon" | "rec";
export type RecordingEdgeStripMode = "off" | "short" | "full" | "frame";
export type RecordingEdgeStripDisplays = "pill" | "all";
export type RecordingInputKind = "dictation" | "assistant" | "translation";
export type RecordingReminderMinutes = 0 | 2 | 3 | 5 | 10;

export interface RecordingIndicatorSettings {
  color: string;
  strip: RecordingEdgeStripMode;
  displays: RecordingEdgeStripDisplays;
  tray?: boolean;
  colorByMode?: boolean;
  assistantColor?: string;
  translationColor?: string;
  reminderMinutes?: RecordingReminderMinutes;
}

export interface MainWindowInputRegion {
  viewportWidth: number;
  viewportHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Live dictation's OpenAI-compatible transcription request, handed to main. */
export interface DictationTranscriptionRequest {
  /** The dictation window's id for it: its cancel names this id. */
  requestId: string;
  endpoint: string;
  /**
   * Only `Authorization`, `api-key` and `Ocp-Apim-Subscription-Key` are sent;
   * main sends the last only to an Azure Speech resource's transcribe URL.
   */
  headers: Record<string, string>;
  /** Form fields after the file, in order (`keywords[]` repeats). */
  fields: Array<[string, string]>;
  /** The audio part's name: `file` (default) or `audio` (Azure Speech). */
  audioPart?: "file" | "audio";
  file: { bytes: ArrayBuffer; name: string; type: string };
  audioSeconds: number | null;
  stream: boolean;
  /** The self-hosted route: the local deadline whatever its host. */
  selfHosted: boolean;
  errorContext: {
    provider: string;
    /** "azure-speech" reads Azure Speech's error shapes. */
    providerId?: string;
    selfHosted: boolean;
    model: string | null;
    surface: "transcription";
  };
}

/** Main's answer: the response (`body`, or a streamed `text`), a cancel, or a classified error. */
export interface DictationTranscriptionReply {
  success: boolean;
  cancelled?: boolean;
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  streamed?: boolean;
  text?: string;
  stats?: { eventCount: number; eventTypes: Record<string, number>; usedFinalText: boolean };
  attempts?: number;
  error?: string;
  code?: string;
  messageKey?: string;
  messageParams?: Record<string, string>;
  settingsTarget?: string;
  technicalDetails?: Record<string, unknown>;
  surface?: string;
}

// Epoch-ms stamps for one push-to-talk press, set by the main process.
export interface DictationPressTrace {
  pressId: number;
  keyAt: number;
  keyTimeSource: "os" | "main";
  hookAt?: number;
  mainAt: number;
  prepareSentAt?: number;
  startSentAt?: number;
}

export type ChineseScriptPreference = "simplified" | "traditional" | "as-transcribed";

export type InferenceMode = "openwhispr" | "providers" | "local" | "self-hosted" | "enterprise";

export type CopilotAuthState = "signedOut" | "waiting" | "checking" | "signedIn" | "error";

export type CopilotAuthError =
  | "not_configured"
  | "code_expired"
  | "oauth_denied"
  | "device_flow_disabled"
  | "token_exchange_failed"
  | "rate_limited"
  | "network"
  | "no_access"
  | "policy_blocked"
  | "check_failed"
  | "runtime_failed"
  | "persist_failed";

export interface CopilotAuthStatus {
  configured: boolean;
  state: CopilotAuthState;
  login: string;
  error?: CopilotAuthError;
  tokenRejected?: boolean;
  flowId?: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  canRetry?: boolean;
}

export interface CopilotModel {
  id: string;
  name: string;
  supportsVision: boolean;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  policyState: string | null;
  inputPrice: number | null;
  outputPrice: number | null;
}

/** Each LLM scope's resolved mode and model, from which the main process decides the shared llama-server. */
export interface LocalServerPrefs {
  useCleanupModel: boolean;
  cleanupMode: InferenceMode;
  cleanupModel: string;
  useDictationAgent: boolean;
  dictationAgentMode: InferenceMode;
  dictationAgentModel: string;
  noteFormattingMode: InferenceMode;
  noteFormattingModel: string;
  chatAgentMode: InferenceMode;
  chatAgentModel: string;
  useDictationTranslation: boolean;
  translationMode: InferenceMode;
  translationModel: string;
}

export type SelfHostedType = "openai-compatible" | "lan";

export type TranscriptionStatus = "completed" | "failed" | "pending" | "discarded";

export interface PolicyFailureMetadata {
  error?: string;
  code?: string;
  status?: number;
  minAppVersion?: string;
  details?: unknown;
}

export interface NoteRecordingProviderModel {
  id: string;
  name: string;
  default?: boolean;
}

export interface NoteRecordingProvider {
  id: string;
  name: string;
  models: NoteRecordingProviderModel[];
}

// Session options every dictation streaming channel takes — the shared
// dictation-realtime-* set and the per-provider ones. `provider` is
// what fetchRealtimeToken's allowlist keys on — the renderer must always send
// it (built by dictationStreamingRouting.buildStreamingSessionOptions); the
// main process defaults a missing value to "openai-realtime" for pre-1.8.4
// renderers (#1624).
export interface DictationRealtimeSessionOptions {
  provider: string;
  baseUrl?: string;
  model?: string;
  mode?: "byok" | "openwhispr";
  language?: string;
  sampleRate?: number;
  keyterms?: string[];
  environment?: string;
  tenant?: string;
  preview?: boolean;
}

export interface DictationLanguageMetadata {
  language: string | null;
  languageConfidence: number | null;
  languageAudioSeconds?: number;
}

export type NoteRecordingConfigFailure = { success: false } & PolicyFailureMetadata;

export type NoteRecordingConfigResult =
  { success: true; providers: NoteRecordingProvider[] } | NoteRecordingConfigFailure;

export type TranscriptionErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER_ERROR"
  | "OFFLINE"
  | "AUTH_EXPIRED"
  | "AUTH_REQUIRED"
  | "LIMIT_REACHED"
  | "PROVIDER_RATE_LIMITED"
  | "API_KEY_MISSING"
  | "INVALID_KEY"
  | "MODEL_NOT_AVAILABLE"
  | "CUSTOM_ENDPOINT_INVALID"
  | "AZURE_SPEECH_ENDPOINT_INVALID"
  | "AZURE_SPEECH_CONVERSION_FAILED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_ACCESS_DENIED"
  | "PROVIDER_QUOTA_EXHAUSTED"
  | "PROVIDER_MODEL_NOT_FOUND"
  | "PROVIDER_PAYLOAD_TOO_LARGE"
  | "PROVIDER_BAD_REQUEST"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_NO_RESPONSE"
  | "PROVIDER_ERROR"
  | "CRASH_RECOVERY"
  | null;

export type MeetingPromptVariant = "detected" | "starting" | "underway";

export interface MeetingNotificationData {
  detectionId: string;
  source: string;
  key: string;
  event: { summary?: string | null } | null;
  variant: MeetingPromptVariant;
  joinUrl: string | null;
}

export interface MeetingFolderRef {
  folderId: number;
  spaceId: number;
}
export interface MeetingExistingNote {
  noteId: number;
  spaceId: number;
  folderId: number | null;
  spaceName: string;
  folderName: string | null;
  shared: boolean;
}
export interface MeetingDestinationContext {
  folders: FolderItem[];
  spaces: SpaceItem[];
  defaultDestination: MeetingFolderRef | null;
  selectedDestination: MeetingFolderRef | null;
  recentDestinations: MeetingFolderRef[];
  existingNote: MeetingExistingNote | null;
}

export interface MeetingSurfaceState {
  revision: number;
  mode: "closed" | "list" | "form";
  contentHeight: number;
  regions: { x: number; y: number; width: number; height: number }[];
  focus: "request" | "release" | "keep";
}

export type MeetingError =
  | "STALE_NOTIFICATION"
  | "INVALID_REQUEST"
  | "FOLDERS_UNAVAILABLE"
  | "FOLDER_UNAVAILABLE"
  | "SPACE_UNAVAILABLE"
  | "FOLDER_NAME_REQUIRED"
  | "FOLDER_NAME_TAKEN"
  | "CREATE_FAILED"
  | "LINKED_NOTE_CHANGED"
  | "NOTE_UNAVAILABLE"
  | "START_FAILED";

export type MeetingResult<T> =
  | { success: true; value: T }
  | { success: false; code: MeetingError; context?: MeetingDestinationContext };

/** Why auto-end concluded the meeting is over. */
export type MeetingAutoEndReason = "mic-released" | "silence" | "process-exit";

export interface MeetingAutoEndRequest {
  sessionId: string;
  reason?: MeetingAutoEndReason;
}

/** Fields a main-process handler resolves with in place of a rejected Error. */
export interface IpcErrorFields {
  error: string;
  code?: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  settingsTarget?: string;
  technicalDetails?: TechnicalErrorDetailsData;
  status?: number;
  surface?: "transcription" | "llm";
}

/**
 * Proxied-transcription IPC results. `ipcMain.handle` drops custom error props on
 * rejection, so these handlers resolve with a serialized error instead of throwing.
 */
export type ProxyTranscriptionResult =
  { text: string; model?: string; error?: undefined } | (IpcErrorFields & { text?: undefined });

export interface AuthTokenState {
  token: string | null;
  generation: number;
}

export interface AuthTokenMutationResult extends AuthTokenState {
  success: boolean;
  code?: string;
}

/** The validated account scope the main process holds, as seen by any window. */
export interface ActiveAccountScope {
  accountId: string;
  authGeneration: number;
}

export interface TranscriptionItem {
  id: number;
  text: string;
  raw_text: string | null;
  timestamp: string;
  created_at: string;
  has_audio: number;
  audio_duration_ms: number | null;
  provider: string | null;
  model: string | null;
  status: TranscriptionStatus;
  error_message: string | null;
  error_code: TranscriptionErrorCode;
  route_kind?: string | null;
  client_transcription_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

/** One stored stage of a dictation (main's transcription_steps), as History shows it. */
export interface TranscriptionStepRecord {
  kind: string;
  outcome: "ok" | "failed" | "skipped" | "fallback";
  output: string | null;
  provider: string | null;
  model: string | null;
  ms: number | null;
  errorCode: string | null;
  /** "server": OpenWhispr Cloud built the prompt, so it isn't available. */
  prompt: {
    source: "resolved" | "server";
    hash: string | null;
    entryId: string | null;
    text?: string | null;
  } | null;
  /**
   * Glossary steps: `{ revision, rulesFired }`; snippet finalize: `{ snippets: true }`;
   * style steps: `{ styleId, runMode }`; a carried-over speech-to-text step:
   * `{ reused }`; cleanup and one-step style steps: `{ dictionaryScope }`; a
   * failed step adds `failure` (why, allowlisted).
   */
  detail: {
    revision?: number | null;
    rulesFired?: Array<{
      ruleId: string | null;
      from: string | null;
      to: string | null;
      /** Offset of `from` in the speech-to-text text; null when it wasn't recorded. */
      index?: number | null;
    }>;
    snippets?: boolean;
    styleId?: string | null;
    runMode?: "two-step" | "one-step" | null;
    /** Re-run cleanup reused this speech-to-text step: from the dictation's step, or unknown. */
    reused?: "stored" | "unknown";
    /** Cleanup (or a one-step style) step: which dictionary words its prompt carried. */
    dictionaryScope?: CleanupDictionaryScopeRecord;
    failure?: StepFailureRecord;
  } | null;
}

/**
 * The dictionary word set a cleanup request ran with: the setting, the set
 * actually applied ("all" when "words speech misses" had no counts), and how
 * many dictionary words it carried.
 */
export interface CleanupDictionaryScopeRecord {
  setting: "all" | "typedPinnedMissed" | "typedPinned" | "none";
  applied: "all" | "typedPinnedMissed" | "typedPinned" | "none";
  words: number;
}

/**
 * Why a step failed (helpers/stepFailure.js): its code ("unknown" when the
 * error had none), the message the error card showed and where to fix it.
 * Never provider text.
 */
export interface StepFailureRecord {
  code: string;
  messageKey?: string;
  messageParams?: { provider?: string; model?: string };
  settingsTarget?: ProviderSettingsTarget;
}

export interface TranscriptionStepsResult {
  success: boolean;
  /** "otherOwner": saved under another account, or while signed out. */
  status: "captured" | "none" | "otherOwner";
  route?: string | null;
  context?: {
    targetApp: string | null;
    /** What the recording was for: the voice assistant, a translation, a wake word. */
    intents?: { voiceAgent?: boolean; translation?: boolean; wakeWord?: boolean };
    /** A styled dictation's style. */
    style?: { id: string | null; runMode: "two-step" | "one-step" | null };
  } | null;
  steps: TranscriptionStepRecord[];
}

export interface ExportDictationsResult {
  success: boolean;
  /** Rows written, and how many of them carried this owner's steps. */
  dictations?: number;
  withSteps?: number;
  canceled?: boolean;
  code?: "OWNER_UNKNOWN" | "ACCOUNT_CHANGED" | "EXPORT_FAILED";
}

/** What a saved step did to the text it received (utils/stepChanges.js). */
export type HistoryStepChange = "changed" | "same" | "failed" | "skipped" | "fallback";

/** One step after speech-to-text, as a History list row marks it. */
export interface HistoryStepMark {
  kind: string;
  /** Null when there was nothing to compare it with. */
  change: HistoryStepChange | null;
  /** A finalize step that expanded snippets. */
  snippets?: boolean;
}

/** Where the next History page starts: the last row's sort timestamp and id. */
export interface HistoryCursor {
  timestamp: string;
  id: number;
}

export interface HistoryListFilters {
  /** Failed dictations, and those whose cleanup, style or translation step failed. */
  failed?: boolean;
  /** The current owner's Cleanup step changed the text. */
  cleanupChanged?: boolean;
  /** The app the current owner's trace was sent to. */
  app?: string | null;
  /** The current owner marked it bad. */
  flagged?: boolean;
  /** A dictionary word in the final text and not in the raw transcript (the row summaries). */
  dictionaryFixed?: boolean;
  /** Rows whose raw transcript or final text has this word ("Show in History"). */
  dictionaryWord?: string | null;
}

export interface HistoryListRequest {
  cursor?: HistoryCursor | null;
  /** 1–100, 50 by default. */
  limit?: number;
  query?: string;
  filters?: HistoryListFilters;
  /** The dictionary generation the first page came with (later pages of a dictionary filter). */
  generation?: number | null;
}

/** A History list row: lightweight, the text cut to a preview. */
export interface HistoryListRow {
  id: number;
  timestamp: string | null;
  status: "completed" | "failed";
  errorCode: string | null;
  preview: string | null;
  hasAudio: boolean;
  audioDurationMs: number | null;
  routeKind: string | null;
  /** From the current owner's steps; null without them. */
  app: string | null;
  marks: HistoryStepMark[] | null;
  /**
   * The current owner's cleanup, style or translation step failed or fell
   * back: its kind (the first one), for the row's badge. Null otherwise.
   */
  stepFailure?: "cleanup" | "style" | "translation" | null;
  /** The current owner's review of it, if any. */
  rating: HistoryVerdict | null;
  /** Dictionary words its final text has and its raw transcript doesn't (the "📖 n fixed" badge). */
  dictionaryFixes?: number;
}

export interface HistoryListResult {
  success: boolean;
  rows: HistoryListRow[];
  nextCursor: HistoryCursor | null;
  code?: "INVALID_CURSOR" | "FAILED";
  /** The dictionary generation the filters and badges were read with. */
  generation?: number | null;
  /** A later page of a dictionary filter under an older generation: start over. */
  stale?: boolean;
}

export interface HistoryDictionaryFixesResult {
  success: boolean;
  generation?: number | null;
  /** Row id → its "📖 n fixed" count. */
  fixes: Record<string, number>;
}

export interface HistoryAppsResult {
  success: boolean;
  /** Most used first. */
  apps: string[];
}

/** One dictation, in full, for the History detail. */
export interface HistoryItem {
  id: number;
  timestamp: string | null;
  status: TranscriptionStatus;
  text: string;
  rawText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  hasAudio: boolean;
  audioDurationMs: number | null;
  routeKind: string | null;
  provider: string | null;
  model: string | null;
}

export type HistoryItemResult =
  | {
      success: true;
      item: HistoryItem;
      /** As history-get-steps: the current owner's steps, or why there are none. */
      status: TranscriptionStepsResult["status"];
      route?: string | null;
      context?: TranscriptionStepsResult["context"];
      steps: TranscriptionStepRecord[];
      /** The version of the row a review is of; saving needs the one the form opened on. */
      revision: string | null;
      /** The current owner, as an opaque tag (drafts are kept per owner); null when unknown. */
      owner: string | null;
      /** The current owner's review of this version of it. */
      feedback: HistoryFeedback | null;
      /**
       * Your dictionary words in it, as the dictionary is now (none for a
       * translation or the assistant's row). `by` only from the current
       * owner's steps.
       */
      dictionary?: HistoryDictionaryWord[];
      /** False: too long to align, so no words are shown. */
      dictionaryAligned?: boolean;
      dictionaryGeneration?: number | null;
    }
  | { success: false; code: "NOT_FOUND" | "FAILED" };

export type HistoryVerdict = "good" | "bad";

/**
 * The step a review blames: one of the row's recorded steps (its kind and
 * seq), the paste ("delivery", no seq) or "unsure".
 */
export interface HistoryReviewStage {
  kind: string;
  seq: number | null;
}

/** The current owner's review of one dictation, local only. */
export interface HistoryFeedback {
  revision: string;
  verdict: HistoryVerdict;
  stage: HistoryReviewStage | null;
  /** What it should have said; null when not corrected. */
  expectedText: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryFeedbackSaveRequest {
  id: number;
  revision: string;
  verdict: HistoryVerdict;
  stage: HistoryReviewStage | null;
  expectedText: string | null;
  note: string | null;
}

export type HistoryFeedbackSaveResult =
  | { success: true; feedback: HistoryFeedback }
  | {
      success: false;
      code:
        | "OWNER_UNKNOWN"
        | "INVALID"
        | "INVALID_STAGE"
        | "TOO_LONG"
        | "HISTORY_OFF"
        | "UNAVAILABLE"
        | "NOT_FOUND"
        | "STALE"
        | "FAILED";
      reason?: string;
    };

/** "Review last dictation": open History on this dictation (null: none was found). */
export interface HistoryReviewRequest {
  requestId: number;
  id: number | null;
}

/** "Open in History" from a dictation error card: one row, no review. */
export interface HistoryItemRequest {
  requestId: number;
  id: number;
}

/**
 * A style case's structure checks: how many bullet lines and numbered items
 * the output may have. Null: not checked.
 */
export interface PromptTestStyleChecks {
  bulletsMin: number | null;
  bulletsMax: number | null;
  numberedMin: number | null;
  numberedMax: number | null;
}

/** A test set case (main's prompt_test_cases, or kept for this session only). */
export interface PromptTestCase {
  id: string;
  /** What the case tests: "cleanup", or a style ("style:<id>"). */
  target: string;
  label: string | null;
  /** The input, copied: a pinned dictation's raw transcript, or text typed in Test. */
  rawText: string;
  /** The text pasted at the time, for reference only; never a pass/fail target. */
  referenceText: string | null;
  /** The app the dictation was made in (exe name), for app-scoped glossary rules. */
  targetApp: string | null;
  mustContain: string[];
  mustNotContain: string[];
  matchCase: boolean;
  /** Style cases: bullet and numbered-item counts. */
  styleChecks: PromptTestStyleChecks;
  source: "history" | "test";
  /** The history row it was copied from, only to open it there. */
  sourceTranscriptionId: number | null;
  /** False: kept in memory for this session only. */
  durable: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Why a new case would be kept for this session only. */
export type PromptTestStorageReason = "history-off" | "policy-off" | "pending" | "unavailable";

export type PromptTestCaseErrorCode =
  | "OWNER_UNKNOWN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "NOT_PINNABLE"
  | "NO_RAW_TEXT"
  | "TOO_LONG"
  | "LIMIT_REACHED"
  | "STORAGE_UNAVAILABLE"
  | "FAILED";

export interface PromptTestCaseEditable {
  label?: string | null;
  targetApp?: string | null;
  mustContain?: string[];
  mustNotContain?: string[];
  matchCase?: boolean;
  styleChecks?: Partial<PromptTestStyleChecks> | null;
}

export interface PromptTestCaseList {
  success: boolean;
  code?: PromptTestCaseErrorCode;
  /** The owner these cases belong to ("account:<id>" or "signed-out"). */
  owner: string | null;
  /** Whether a new case would be stored, and if not, why. */
  durable?: boolean;
  reason?: PromptTestStorageReason | null;
  cases: PromptTestCase[];
}

export interface PromptTestCaseWriteResult {
  success: boolean;
  code?: PromptTestCaseErrorCode;
  case?: PromptTestCase;
  /** The same input was already a case; that one is returned. */
  duplicate?: boolean;
  durable?: boolean;
  reason?: PromptTestStorageReason | null;
  removed?: number;
}

export interface PromptTestCasesChange {
  owner: string | null;
  reason: "owner" | "policy" | "added" | "updated" | "removed" | "cleared";
}

export interface DictationLifecycleSnapshot {
  state: "idle" | "preparing" | "recording" | "processing";
  inputKind: string;
}

export type AnalyticsMode = "local" | "openwhispr_cloud" | "byok" | "self_hosted" | "unknown";

export interface AnalyticsEventInput {
  eventId: string;
  wordCount: number;
  occurredAt: string;
  localDate: string;
  spokenDurationMs?: number | null;
  mode: AnalyticsMode;
  provider?: string | null;
  model?: string | null;
}

export interface PendingAnalyticsEvent {
  event_id: string;
  occurred_at: string;
  local_date: string;
  word_count: number;
  spoken_duration_ms: number | null;
  mode: AnalyticsMode;
  provider: string | null;
  model: string | null;
  counter_version: number;
}

export interface PendingAnalyticsClear {
  cleared_through: string;
}

export interface AnalyticsSyncContext {
  accountId: string;
  authGeneration: number;
}

export interface AnalyticsDailyBucket {
  date: string;
  words: number;
  dictations: number;
  spokenDurationMs: number;
}

export interface AnalyticsSummary {
  totalWords: number;
  totalDictations: number;
  totalSpokenDurationMs: number;
  averageWpm: number | null;
  currentStreakDays: number;
  longestStreakDays: number;
  wpmCoveragePercent: number;
  daily: AnalyticsDailyBucket[];
  historyBackfillRetryRequired?: boolean;
}

export type LeaderboardMetric =
  "total_words" | "words_per_minute" | "current_daily_streak" | "desktop_words" | "mobile_words";

export type LeaderboardRange = "week" | "all";

export interface AnalyticsParticipation {
  configured: boolean;
  enabled: boolean;
  updatedAt: string | null;
}

export interface LeaderboardMember {
  userId: string;
  name: string | null;
  // Withheld (null) on a domain board, where a shared mail suffix is the only
  // thing the listed people have in common.
  email: string | null;
  image: string | null;
  totalWords: number;
  desktopWords: number;
  mobileWords: number;
  averageWpm: number | null;
  currentStreakDays: number;
  rank: number;
}

export type LeaderboardAccessState =
  "ready" | "invite" | "accept_invite" | "request_join" | "create";

export interface LeaderboardAccessScope {
  key: string;
  kind: "workspace" | "domain";
  id: string;
  name: string;
  memberCount: number;
  state: "ready" | "invite";
  role: WorkspaceRole | null;
}

export interface LeaderboardAccess {
  state: LeaderboardAccessState;
  scopes: LeaderboardAccessScope[];
  domain: string | null;
  colleagueCount: number;
  invitation: {
    workspaceId: string;
    workspaceName: string;
    inviterName: string | null;
  } | null;
  joinableWorkspace: {
    id: string;
    name: string;
    memberCount: number;
    requestState: "none" | "pending";
  } | null;
}

export interface Leaderboard {
  scope: {
    key: string;
    kind: "workspace" | "domain";
    id: string;
    name: string;
  };
  viewerUserId: string | null;
  metric: LeaderboardMetric;
  range: LeaderboardRange;
  weekStart: string | null;
  availableWeekStarts: string[];
  leaders: LeaderboardMember[];
  members: LeaderboardMember[];
  totalMembers: number;
  viewerRank: number | null;
  page: number;
  pageSize: number;
  generatedAt: string;
  refreshAfterSeconds: number;
}

export interface NoteItem {
  id: number;
  title: string;
  content: string;
  enhanced_content: string | null;
  enhancement_prompt: string | null;
  /** The client_id of the template that produced enhanced_content. */
  enhancement_template_id: string | null;
  enhanced_at_content_hash: string | null;
  note_type: "personal" | "meeting" | "upload";
  source_file: string | null;
  audio_duration_seconds: number | null;
  folder_id: number | null;
  space_id: number;
  transcript: string | null;
  calendar_event_id: string | null;
  participants: string | null;
  diarization_enabled: number | null;
  expected_speaker_count: number | null;
  cloud_id: string | null;
  is_shared: number;
  share_token: string | null;
  // The note's owner (CloudNote.user_id) — who created it, not who last
  // edited it. Only populated from the cloud; NULL on local-only rows and on
  // team notes mirrored before ownership shipped (the UI fails closed on
  // those until the owner backfill fills them).
  owner_user_id?: string | null;
  created_by_user_id?: string | null;
  // Last cloud editor; only populated on cloud pull (local edits don't set it).
  updated_by_user_id?: string | null;
  // Server updated_at this device last acked (push response or pull); echoed
  // as base_updated_at on the next PATCH. Null = pre-guard row, pushes LWW.
  cloud_updated_at?: string | null;
  created_at: string;
  updated_at: string;
  client_note_id: string;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  // Computed by getNoteByClientId while a parent folder DELETE awaits its
  // server result. Held notes stay hidden and must not be pulled/queued alone.
  folder_delete_pending?: number;
  // 1 while a cloud-backed row that left a team space still owes its scope
  // retraction push (D6); cleared when the row settles.
  left_team?: number;
}

// Immutable view of every local field that affects a note push. The main
// process compares this atomically when the cloud response returns, so an
// in-flight create/PATCH cannot settle a newer edit or a purged identity.
export type NotePushSnapshot = Pick<
  NoteItem,
  | "client_note_id"
  | "title"
  | "content"
  | "enhanced_content"
  | "enhancement_prompt"
  | "enhancement_template_id"
  | "enhanced_at_content_hash"
  | "note_type"
  | "source_file"
  | "audio_duration_seconds"
  | "folder_id"
  | "space_id"
  | "transcript"
  | "calendar_event_id"
  | "participants"
  | "diarization_enabled"
  | "expected_speaker_count"
  | "created_at"
  | "updated_at"
  | "sync_status"
  | "deleted_at"
  | "cloud_updated_at"
  | "left_team"
>;

export type NoteCreateSnapshot = NotePushSnapshot;
export type NoteUpdateSnapshot = NotePushSnapshot;

export interface NoteCreateAckResult {
  success: boolean;
  outcome: "synced" | "pending" | "already-linked" | "orphaned" | "unresolved";
}

export interface NoteUpdateAckResult {
  success: boolean;
  outcome: "synced" | "pending" | "identity-changed";
  changes: number;
}

export type ShareVisibility = "private" | "link" | "domain" | "invited";

export type NotePermission = "owner" | "editor" | "viewer";

export type NoteAccessPrincipalType = "user" | "email" | "team" | "folder" | "workspace";

export interface NoteAccessPrincipal {
  type: NoteAccessPrincipalType;
  id: string | null;
  email: string | null;
  name: string | null;
  image: string | null;
  member_count: number | null;
}

export interface NoteAccessGrant {
  id: string;
  principal: NoteAccessPrincipal;
  permission: Exclude<NotePermission, "owner">;
  source: "direct" | "team" | "folder" | "workspace";
  inherited: boolean;
  pending: boolean;
  created_at: string;
  updated_at: string;
}

export interface NoteAccessState {
  owner: NoteAccessPrincipal;
  grants: NoteAccessGrant[];
  my_permission: NotePermission;
  can_manage_access: boolean;
  can_manage_inherited_access: boolean;
}

export interface ShareSettings {
  visibility: ShareVisibility;
  token_prefix: string | null;
  domain_allowlist: string[];
  updated_by_user_id: string | null;
  updated_at: string | null;
}

export interface NoteShareInvitation {
  id: string;
  email: string;
  invited_by_user_id: string;
  accepted_at: string | null;
  revoked_at: string | null;
  last_emailed_at: string | null;
  created_at: string;
}

export interface FolderItem {
  id: number;
  name: string;
  is_default: number;
  sort_order: number;
  space_id: number;
  created_at: string;
  updated_at: string;
  client_folder_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  // 1 while a cloud-backed row that left a team space still owes its scope
  // retraction push (D6); cleared when the row settles.
  left_team?: number;
}

export type FolderPushSnapshot = Pick<
  FolderItem,
  | "client_folder_id"
  | "name"
  | "is_default"
  | "sort_order"
  | "space_id"
  | "created_at"
  | "updated_at"
  | "sync_status"
  | "deleted_at"
  | "left_team"
>;

export interface FolderAckResult {
  success: boolean;
  outcome: "synced" | "pending" | "already-linked" | "identity-changed" | "unresolved";
  changes: number;
}

/** A team assigned to a space, as mirrored from GET /api/me/spaces. */
export interface SpaceTeamRef {
  id: string;
  name: string;
  // Explicit team membership role, if any (workspace admins may have none).
  my_role?: "admin" | "member" | null;
  // Per-assignment cap on what the team conveys (space_teams.access): its
  // team admins are space admins only when this is 'admin'. Absent on
  // mirrors written before the API shipped it; those rows are 'admin'.
  access?: "admin" | "member";
}

export interface SpaceItem {
  id: number;
  client_space_id: string;
  cloud_space_id: string | null;
  // Retained only for unambiguous adoption of pre-spaces team rows.
  cloud_team_id?: string | null;
  workspace_id: string | null;
  kind: "private" | "team";
  name: string;
  emoji: string | null;
  sort_order: number;
  // Server-computed effective role: direct grant or best role across assigned
  // teams (ws owner/admin ⇒ admin).
  my_role: "admin" | "member" | null;
  // Direct space_members grant, null when access comes only via teams or the
  // workspace role. Absent on mirrors written before the API shipped it.
  my_direct_role?: TeamRole | null;
  // Server-computed deduped union of direct members and assigned team rosters.
  member_count: number | null;
  teams: SpaceTeamRef[];
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DictionaryEntryItem {
  id: number;
  word: string;
  source: "manual" | "learned";
  created_at: string;
  updated_at: string;
  client_dict_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface SnippetEntryItem {
  id: number;
  trigger: string;
  replacement: string;
  created_at: string;
  updated_at: string;
  client_snippet_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export type WorkspaceRole = "owner" | "admin" | "member";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  created_by_user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string;
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  seats: number;
  // Optional: absent from API responses that predate unified billing.
  seats_used?: number;
  created_at: string;
  updated_at: string;
  role: WorkspaceRole;
  is_billable?: boolean;
  billing_manager?: string | null;
}

export interface WorkspaceMember {
  user_id: string;
  role: WorkspaceRole;
  is_billable?: boolean;
  joined_at: string;
  email: string;
  name: string | null;
  image: string | null;
}

export type TeamRole = "admin" | "member";

export interface Team {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  emoji?: string | null;
  created_at: string;
  updated_at: string;
  member_count?: number;
}

export interface TeamMember {
  user_id: string;
  role: TeamRole;
  joined_at: string;
  email: string;
  name: string | null;
  image: string | null;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  workspace_role: WorkspaceRole;
  team_ids: string[];
  invited_by_user_id: string;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export interface JoinableMember {
  name: string | null;
  email: string;
  image: string | null;
}

/**
 * A workspace the signed-in user can act on, from GET /api/me/joinable.
 * `source` is why they can see it, `mode` is what the button does: a direct
 * invitation joins, while a company-domain match only earns the right to ask
 * an admin. Enterprise SSO and SCIM provision through the SSO callback.
 */
export interface JoinableWorkspace {
  source: "invitation" | "domain";
  mode: "join" | "request";
  request_state: "none" | "pending";
  invitation_id: string | null;
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  role: WorkspaceRole;
  member_count: number;
  members: JoinableMember[];
  inviter_name: string | null;
  inviter_email: string | null;
}

export interface WorkspaceJoinRequest {
  id: string;
  user_id: string;
  name: string | null;
  email: string;
  image: string | null;
  created_at: string;
}

export interface InvitationPreview {
  id: string;
  email: string;
  workspace_role: WorkspaceRole;
  team_ids: string[];
  /** Live spaces the invite grants directly; absent from APIs that predate space grants. */
  space_names?: string[];
  expires_at: string;
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  inviter_name: string | null;
  inviter_email: string | null;
}

export interface WorkspaceApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  created_by_user_id: string | null;
  description: string | null;
}

export interface NewWorkspaceApiKey extends WorkspaceApiKey {
  key: string;
}

export interface TemplateSection {
  heading: string;
  instruction: string;
}

/** A template writes the AI summary; an action edits it or answers in the note chat. */
export type ActionKind = "template" | "action";
export type ActionOutput = "summary" | "chat";

export interface ActionItem {
  id: number;
  /** Stable across devices: a built-in's translation key, otherwise a UUID. */
  client_id: string;
  kind: ActionKind;
  name: string;
  description: string;
  /** A template's context, or an action's instructions. */
  prompt: string;
  sections: TemplateSection[] | null;
  output: ActionOutput | null;
  icon: string;
  is_builtin: number;
  sort_order: number;
  translation_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface GpuDevice {
  index: number;
  uuid: string;
  name: string;
  vramMb: number;
}

export interface GpuInfo {
  hasNvidiaGpu: boolean;
  gpuName?: string;
  driverVersion?: string;
  vramMb?: number;
  computeCap?: number;
  /** Whether the card meets the shipped CUDA build's minimum compute capability. */
  cudaSupported?: boolean;
}

export interface CudaWhisperStatus {
  downloaded: boolean;
  downloading: boolean;
  path: string | null;
  gpuInfo: GpuInfo;
  /** CUDA fell back to CPU on this machine and stays off until retried. */
  gpuFailed?: boolean;
  /** The whisper-server error line saved with that failure; null when none was readable. */
  gpuFailReason?: string | null;
  /** The pack the GPU card describes: the one every whisper start picks, else
   * an installed pack that failed (#1736). At most one pack reports true. */
  inUse?: boolean;
  /** An older release installed the pack and this version can't use it. */
  needsUpdate?: boolean;
}

export interface VulkanWhisperStatus {
  downloaded: boolean;
  downloading: boolean;
  vulkan: VulkanGpuResult;
  hasNvidiaGpu: boolean;
  /** Vulkan fell back to CPU on this machine and stays off until retried. */
  gpuFailed?: boolean;
  /** The whisper-server error line saved with that failure; null when none was readable. */
  gpuFailReason?: string | null;
  /** The pack the GPU card describes: the one every whisper start picks, else
   * an installed pack that failed (#1736). At most one pack reports true. */
  inUse?: boolean;
  /** An older release installed the pack and this version can't use it. */
  needsUpdate?: boolean;
}

export interface WhisperServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  hostname: string;
  isRemote: boolean;
  modelPath: string | null;
  modelName: string | null;
  gpuBackend: "cuda" | "vulkan" | null;
  /** True only when the running server is actually using a local GPU backend. */
  gpuAccelerated: boolean;
}

export interface WhisperCheckResult {
  installed: boolean;
  working: boolean;
  error?: string;
}

export interface WhisperModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  size_mb?: number;
  error?: string;
  code?: string;
  isDownloading?: boolean;
  isInstalling?: boolean;
  downloadProgress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface WhisperModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_mb?: number;
  error?: string;
}

export interface WhisperModelsListResult {
  success: boolean;
  models: WhisperModelResult[];
  cache_dir: string;
}

export interface FFmpegAvailabilityResult {
  available: boolean;
  path?: string;
  error?: string;
}

export interface AudioDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  ffmpeg: { available: boolean; path: string | null; error: string | null };
  whisperBinary: { available: boolean; path: string | null; error: string | null };
  whisperServer: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export type SystemAudioMode = "native" | "loopback" | "portal" | "unsupported";
export type SystemAudioStrategy =
  "native" | "loopback" | "pipewire-loopback" | "wasapi-loopback" | "unsupported";

export interface MeetingSystemAudioInterruption {
  systemAudioStrategy: SystemAudioStrategy;
  reason: "no_audio_delivered" | "device_invalidated" | "gone_quiet" | "loopback_takeover_failed";
  recovering: boolean;
}

export interface SystemAudioAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  mode: SystemAudioMode;
  supportsPersistentGrant?: boolean;
  supportsPersistentPortalGrant?: boolean;
  supportsNativeCapture?: boolean;
  supportsOnboardingGrant?: boolean;
  requiresRuntimeSharePrompt?: boolean;
  strategy?: SystemAudioStrategy;
  restoreTokenAvailable?: boolean;
  portalVersion?: number | null;
  error?: string;
}

export interface ScreenRecordingAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  supported: boolean;
  /** macOS only: granted mid-session, so capture stays broken until the app relaunches. */
  needsRelaunch?: boolean;
}

export type CloudReasonPurpose = "cleanup" | "assistant" | "translation" | "noteFormatting";

// Orukeet's audio language estimate, reported for the backend's per-user gate.
export interface SttDetectedLanguageFields {
  sttDetectedLanguage?: string;
  sttDetectedLanguageConfidence?: number;
  sttDetectedLanguageAudioSeconds?: number;
  sttDetectedLanguageStatus?: "detected" | "unknown";
}

export interface ScreenContextImage {
  mediaType: string;
  /** Base64 image bytes, no data-URL prefix. */
  data: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  version?: string;
  releaseDate?: string;
  files?: any[];
  releaseNotes?: string;
  message?: string;
}

export interface UpdateStatusResult {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDevelopment: boolean;
  isSupported: boolean;
  isSelfBuilt?: boolean;
  selfBuiltCommit?: string | null;
}

export interface UpdateInfoResult {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string | null;
  files?: any[];
}

export interface UpdateResult {
  success: boolean;
  message: string;
}

export interface AppVersionResult {
  version: string;
}

/**
 * `source`: a selfhost Dev or `npm run dev` run from the working tree;
 * `selfhost-stable`: a packaged self-built install; `release`: an official package.
 */
export type BuildChannel = "source" | "selfhost-stable" | "release";

/** System › This build (`get-build-info`). Null fields are unknown. */
export interface BuildInfoResult {
  version: string;
  /** UTC ISO time the package was made; null when running from source or not stamped. */
  builtAt: string | null;
  /** Full SHA: the packaged commit, or the working tree's HEAD when running from source. */
  commit: string | null;
  /** Tracked files had uncommitted changes when it was packaged (or now, from source). */
  dirty: boolean | null;
  /** Who packaged it: `selfhost` (selfhost.js ship) or `npm` (any other packaging). */
  source: "selfhost" | "npm" | null;
  /** The commit's subject line; read only when running from source. */
  commitSubject: string | null;
  channel: BuildChannel;
  /** When the main process started (UTC ISO), not when a window loaded. */
  startedAt: string;
  uptimeSec: number;
  /** The executable's path, with the user profile prefix as %USERPROFILE% (~ elsewhere). */
  exePath: string | null;
  electron: string | null;
  chrome: string | null;
  node: string | null;
}

/** Storage › Logs: Off, Problems only (warnings and errors), Everything (debug). */
export type LogSettingLevel = "off" | "warn" | "debug";

/** A level in force; a --log-level flag or an inherited variable may ask for any. */
export type LogLevel = LogSettingLevel | "trace" | "info" | "error" | "fatal";

export type LogRetentionDays = 7 | 14 | 30 | 90;

/** `log-info`: the log settings, what's in force and the folder's size. */
export interface LogInfoResult {
  /** The saved setting (read as one of the three choices). */
  level: LogSettingLevel;
  /** The level in force; differs from `level` when an override sets it. */
  effectiveLevel: LogLevel;
  /** A --log-level flag or an OPENWHISPR_LOG_LEVEL inherited from the parent process. */
  overriddenBy: "flag" | "env" | null;
  retentionDays: LogRetentionDays;
  includeText: boolean;
  totalBytes: number;
  fileCount: number;
  /** The file being written (name only), or null while nothing is. */
  currentFile: string | null;
  /** The logs folder with the user profile as %USERPROFILE% (~ elsewhere). */
  logsDir: string | null;
  /** The OS, for Copy diagnostics. */
  system?: { platform: string; version: string | null; arch: string };
}

export interface LogSettingsUpdate {
  level?: LogSettingLevel;
  retentionDays?: LogRetentionDays;
  includeText?: boolean;
}

/** What every window's logger needs (`get-log-state`, `log-settings-changed`). */
export interface LogState {
  level: LogLevel;
  includeText: boolean;
}

/** One of the recent warnings and errors (`log-recent-problems`), newest first. */
export interface LogProblem {
  /** UTC ISO time. */
  time: string;
  level: "warn" | "error" | "fatal";
  /** The entry's scope (else its source), e.g. "clipboard"; null when it has neither. */
  area: string | null;
  /** The message's first line, at most 200 characters. */
  message: string;
}

export interface ClearLogsResult {
  deleted: number;
  /** Files that couldn't be deleted (in use by another instance). */
  failed: string[];
}

/** Settings › Storage › Recordings: how new dictations are recorded. */
export type RecordingQuality = "smaller" | "balanced" | "original";

/** Clear all recordings (`delete-all-audio`): files deleted, and files still there. */
export interface DeleteAllAudioResult {
  deleted: number;
  failed: number;
}

/** The fixed places OpenWhispr keeps data (Settings › Storage); main owns their paths. */
export type StorageResourceId =
  | "recordings"
  | "logs"
  | "database"
  | "settings"
  | "secrets"
  | "models"
  | "searchIndex"
  | "appCache"
  | "cliBridge"
  | "selfhost";

export interface StorageInventoryItem {
  id: StorageResourceId;
  /** Where Open goes (a folder, or the file Show in folder selects), the user profile masked. */
  path: string | null;
  /** Every measured part's path, masked. */
  paths: Array<string | null>;
  target: "folder" | "file";
  exists: boolean;
  /** Null when not measured (the self-hosted builds folder). */
  bytes: number | null;
  files: number | null;
  /** Per part: models by kind (whisper, parakeet, diarization, llm, embedding), app cache by folder. */
  parts: Array<{ key: string; bytes: number; exists: boolean }>;
  clearable: boolean;
}

export interface HistoryDatabaseCounts {
  dictations: number;
  stepRecords: number;
  reviews: number;
  testCases: number;
  dictionaryWords: number;
  glossaryRules: number;
  notes: number;
}

/** Dictations a day over the last 30 days of history and their average recorded length. */
export interface RecordingPace {
  windowDays: number;
  spanDays: number;
  dictations: number;
  perDay: number;
  averageSeconds: number | null;
  minutesPerDay: number | null;
}

export interface StorageInventoryResult {
  measuredAt: string;
  /** Served from main's one-minute cache. */
  cached: boolean;
  totalBytes: number;
  items: StorageInventoryItem[];
  database: { counts: HistoryDatabaseCounts | null };
  recordingPace: RecordingPace | null;
}

export interface StorageActionResult {
  success: boolean;
  error?: string;
  deleted?: number;
  failed?: number;
}

export interface WhisperDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
  result?: any;
  sequence?: number;
}

export interface LocalModelDownloadStatus {
  modelType: "whisper" | "parakeet" | "llm";
  modelId: string;
  phase: "downloading" | "installing";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  sequence: number;
}

export interface ParakeetCheckResult {
  installed: boolean;
  working: boolean;
  supported?: boolean;
  path?: string;
  code?: string;
  message?: string;
  minimumMacOSVersion?: string;
}

export interface ParakeetModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  error?: string;
  code?: string;
  isDownloading?: boolean;
  isInstalling?: boolean;
  downloadProgress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface ParakeetModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_bytes?: number;
  freed_mb?: number;
  error?: string;
}

export interface ParakeetModelsListResult {
  success: boolean;
  models: ParakeetModelResult[];
  cache_dir: string;
}

export interface ParakeetDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
  sequence?: number;
}

export interface ParakeetTranscriptionResult {
  success: boolean;
  text?: string;
  message?: string;
  error?: string;
}

export interface ParakeetDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  sherpaOnnx: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export interface PasteToolsResult {
  platform: "darwin" | "win32" | "linux";
  available: boolean;
  method: string | null;
  requiresPermission: boolean;
  isWayland?: boolean;
  xwaylandAvailable?: boolean;
  terminalAware?: boolean;
  hasNativeBinary?: boolean;
  hasUinput?: boolean;
  hasWtype?: boolean;
  isWlroots?: boolean;
  isCosmic?: boolean;
  tools?: string[];
  recommendedInstall?: string;
}

export type GpuBackend = "vulkan" | "cpu" | "metal" | null;

export interface LlamaServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  modelPath: string | null;
  modelName: string | null;
  backend: GpuBackend;
  gpuAccelerated: boolean;
}

export interface VulkanGpuResult {
  available: boolean;
  deviceName?: string;
  reason?: string;
  error?: string;
}

export interface LlamaVulkanStatus {
  supported: boolean;
  downloaded: boolean;
  downloading?: boolean;
  error?: string;
}

export interface LlamaVulkanDownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
}

export interface LocalLLMModelStatus extends ModelDefinition {
  providerId?: string;
  providerName?: string;
  isDownloaded: boolean;
  isDownloading: boolean;
  downloadProgress: number;
  downloadedSize: number;
  totalSize: number;
  path: string | null;
}

export type LocalLLMDownloadProgressEvent =
  | {
      type?: "progress";
      modelId: string;
      progress: number;
      downloadedSize: number;
      totalSize: number;
      sequence?: number;
    }
  | {
      type: "complete";
      modelId: string;
      progress: 100;
      downloadedSize?: number;
      totalSize?: number;
      sequence?: number;
    }
  | {
      type: "error";
      modelId: string;
      error: string;
      code?: string;
      details?: unknown;
      sequence?: number;
    };

export interface ConversationPreview {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  cloud_id?: string | null;
  client_conversation_id?: string;
  sync_status?: "synced" | "pending" | "error";
  deleted_at?: string | null;
  // Computed for sync lookups while the parent folder delete is unresolved.
  folder_delete_pending?: number;
  message_count: number;
  last_message?: string | null;
  last_message_role?: "user" | "assistant" | "system" | null;
}

export interface ConversationCreateSnapshot {
  client_conversation_id?: string | null;
  title: string;
  updated_at: string;
  message_count: number;
}

export interface ConversationCreateAckResult {
  success: boolean;
  outcome: "synced" | "changed" | "already-linked" | "delete-pending" | "orphaned" | "unresolved";
  cloud_id?: string | null;
}

export type OnboardingDemoKind = "dictation" | "assistant";
/**
 * "partial" streams the transcript, "processing" carries the final transcript,
 * "replying" streams the assistant demo's reply, and "level" mirrors the
 * microphone level while listening.
 */
export type OnboardingDemoStatus =
  "listening" | "level" | "processing" | "partial" | "replying" | "success" | "error";
export interface OnboardingDemoEvent {
  demoId: string;
  kind: OnboardingDemoKind;
  status: OnboardingDemoStatus;
  text?: string;
  message?: string;
  /** Tool the assistant is running while it replies (a tool registry name). */
  tool?: string;
  /** Microphone input level, 0..1, on "level" events. */
  level?: number;
}

export interface ReferralItem {
  id: string;
  email: string;
  name: string | null;
  status: "pending" | "completed" | "rewarded";
  created_at: string;
  first_payment_at: string | null;
}

declare global {
  interface Window {
    electronAPI: {
      // Basic window operations
      setOnboardingWindowMode?: (mode: "compact" | "expanded" | "restore") => Promise<boolean>;
      setOnboardingActive?: (active: boolean) => Promise<boolean>;
      openPermissionGuide?: (state: PermissionGuideState) => Promise<boolean>;
      closePermissionGuide?: () => Promise<boolean>;
      getPermissionGuideState?: () => Promise<PermissionGuideState | null>;
      permissionGuideAction?: (action: PermissionGuideAction) => void;
      startPermissionGuideDrag?: (
        target: Pick<PermissionGuideState, "sessionId" | "permission">
      ) => void;
      onPermissionGuideState?: (callback: (state: PermissionGuideState) => void) => () => void;
      onPermissionGuideAction?: (callback: (action: PermissionGuideAction) => void) => () => void;
      verifySystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      beginOnboardingDemo?: (session: { id: string; kind: OnboardingDemoKind }) => Promise<boolean>;
      endOnboardingDemo?: (id: string) => Promise<boolean>;
      stopOnboardingDemo?: (id: string) => Promise<boolean>;
      publishOnboardingDemoEvent?: (event: Omit<OnboardingDemoEvent, "demoId">) => Promise<boolean>;
      onOnboardingDemoEvent?: (callback: (event: OnboardingDemoEvent) => void) => () => void;
      testProviderConnection?: (config: {
        scope: "transcription" | "reasoning";
        provider: string;
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        clientId?: string;
        clientSecret?: string;
        environment?: string;
        tenant?: string;
      }) => Promise<{ success: boolean; error?: string; errorCode?: string; status?: number }>;
      pasteText: (
        text: string,
        options?: {
          fromStreaming?: boolean;
          restoreClipboard?: boolean;
          allowClipboardFallback?: boolean;
          /** A styled paste: main arms no auto-learn edit monitoring for it. */
          suppressAutoLearn?: boolean;
        }
      ) => Promise<
        | { success: true; pasted: boolean; reason?: "modifiers-held" }
        | {
            success: false;
            pasted: false;
            code: "ACCESSIBILITY_PERMISSION_REQUIRED";
            clipboardCopied: true;
          }
      >;
      captureSelectedText?: (options?: { probeEditable?: boolean }) => Promise<
        | {
            status: "selected";
            sessionId: string;
            text: string;
            characterCount: number;
          }
        | {
            status: "editable";
            sessionId: string;
            /** True when the captured app keeps markdown (spec Appendix A); false means plain text. */
            acceptsMarkdown: boolean;
          }
        | {
            status: "none" | "unavailable" | "target_changed" | "too_large";
            code?: string;
            characterCount?: number;
            maxCharacters?: number;
          }
      >;
      replaceSelectedText?: (
        sessionId: string,
        text: string,
        options?: { restoreClipboard?: boolean; allowClipboardFallback?: boolean }
      ) => Promise<{
        success: boolean;
        code?:
          | "invalid_replacement"
          | "session_expired"
          | "target_changed"
          | "selection_unavailable"
          | "selection_changed"
          | "paste_failed"
          | "modifiers_held"
          | "selection_manager_unavailable";
        error?: string;
      }>;
      pasteAtCapturedTarget?: (
        sessionId: string,
        text: string,
        options?: { restoreClipboard?: boolean; allowClipboardFallback?: boolean }
      ) => Promise<{
        success: boolean;
        code?:
          | "invalid_replacement"
          | "session_expired"
          | "target_changed"
          | "paste_failed"
          | "modifiers_held"
          | "selection_manager_unavailable";
        error?: string;
      }>;
      hideWindow: () => Promise<void>;
      showDictationPanel: () => Promise<void>;
      openSettingsSection?: (section: ProviderSettingsTarget) => Promise<{ success: boolean }>;
      captureDictationTarget?: () => Promise<{ success: boolean; pid: number | null }>;
      /** The starting recording's frozen target app; null when unknown (non-Windows). */
      getDictationTargetApp?: () => Promise<{ exeName: string } | null>;
      /** `styleId`: a style key's style (Stage 4); absent, the dictation hotkey's. */
      onToggleDictation: (callback: (payload?: { styleId?: string }) => void) => () => void;
      onToggleVoiceAgent?: (callback: () => void) => () => void;
      onToggleTranslation?: (callback: () => void) => () => void;
      onOpenAssistantPanel?: (callback: () => void) => () => void;
      onStartDictation?: (
        callback: (payload?: { trace?: DictationPressTrace; styleId?: string }) => void
      ) => () => void;
      onStopDictation?: (callback: () => void) => () => void;
      onPrepareDictation?: (
        callback: (options?: {
          inputKind?: "dictation" | "assistant" | "translation";
          trace?: DictationPressTrace;
          styleId?: string;
        }) => void
      ) => () => void;
      onCancelDictationPreparation?: (callback: () => void) => () => void;
      onCancelDictation?: (callback: () => void) => () => void;
      onCancelHotkeyPressed?: (callback: () => void) => () => void;
      /** Esc held for a long-running dictation's processing (`purpose: "processing"`). */
      onCancelProcessingHotkeyPressed?: (callback: () => void) => () => void;
      registerCancelHotkey?: (
        key: string,
        options?: { purpose?: "recording" | "processing" }
      ) => Promise<{ success: boolean; hotkey?: string; error?: string }>;
      unregisterCancelHotkey?: () => Promise<{ success: boolean }>;
      onDictationForceStopped?: (
        callback: (payload?: { reason?: "timeout" | "reset" | "manual" }) => void
      ) => () => void;
      micWarmHoldChanged?: (active: boolean) => void;
      dictationLifecycleStateChanged: (
        state: "idle" | "preparing" | "recording" | "processing",
        inputKind?: RecordingInputKind,
        startedAt?: number | null
      ) => void;
      dictationAudioLevelChanged?: (level: number) => void;
      toggleAgentPanelDictation?: () => Promise<{ success: boolean }>;
      cancelAgentPanelDictation?: () => Promise<{ success: boolean }>;
      getAgentDictationPillState?: () => Promise<{
        lifecycle: "idle" | "preparing" | "recording" | "processing";
        interactive: boolean;
        horizontalDirection: "left" | "right";
        startedAt?: number | null;
      }>;
      resizeAgentDictationPillToContent?: (surfaceHeight: number | null) => Promise<{
        success: boolean;
        changed?: boolean;
        bounds?: { x: number; y: number; width: number; height: number };
        message?: string;
      }>;
      setAgentDictationPillInteractivity?: (interactive: boolean) => Promise<{ success: boolean }>;
      onAgentDictationPillStateChanged?: (
        callback: (state: {
          lifecycle: "idle" | "preparing" | "recording" | "processing";
          interactive: boolean;
          horizontalDirection: "left" | "right";
          startedAt?: number | null;
        }) => void
      ) => () => void;
      onRecordingReminder?: (
        callback: (payload: { startedAt: number | null; inputKind: RecordingInputKind }) => void
      ) => () => void;
      onAgentDictationPillAudioLevelChanged?: (callback: (level: number) => void) => () => void;
      showAgentDictationFinalTranscript?: (text: string) => void;
      onAgentDictationPillFinalTranscript?: (callback: (text: string) => void) => () => void;

      // STT config
      getSttConfig?: () => Promise<
        | ({
            success: boolean;
            dictation?: { mode: string };
            notes?: { mode: string };
            streamingProvider?: string;
          } & PolicyFailureMetadata)
        | null
      >;

      // Org policy (see src/types/policy.ts)
      getWorkspacePolicy?: (
        accountId?: string,
        expectedAuthGeneration?: number
      ) => Promise<{
        success: boolean;
        status?: "network" | "cached" | "current" | "unsupported" | "restricted" | "error";
        revision?: number;
        accountId?: string | null;
        authGeneration?: number | null;
        managed?: boolean;
        policy?: OrgPolicy | null;
        policyUpdatedAt?: string | null;
        endpointSupported?: boolean;
        code?: string;
        error?: string;
        enforcementRequired?: boolean;
      }>;
      onWorkspacePolicyChanged?: (
        callback: (
          snapshot:
            | {
                success: true;
                status: "network" | "cached" | "current" | "unsupported";
                revision: number;
                accountId: string | null;
                authGeneration: number;
                managed: boolean;
                policy: OrgPolicy | null;
                policyUpdatedAt: string | null;
                endpointSupported: boolean;
              }
            | {
                success: false;
                status: "error";
                revision: number;
                accountId: string | null;
                authGeneration: number;
                code: "POLICY_UNRESOLVABLE";
                error: string;
              }
        ) => void
      ) => () => void;

      getNoteRecordingConfig?: () => Promise<NoteRecordingConfigResult | null>;

      // Database operations
      saveTranscription: (
        text: string,
        rawText?: string | null,
        options?: {
          status?: TranscriptionStatus;
          errorMessage?: string | null;
          errorCode?: TranscriptionErrorCode;
          clientTranscriptionId?: string;
          analyticsOccurredAt?: string;
          routeKind?: string | null;
          /** The boundary's trace; main saves it as step history if it may. */
          trace?: PostTranscriptionTrace;
        }
      ) => Promise<{ id: number; success: boolean; transcription?: TranscriptionItem }>;
      getTranscriptions: (
        limit?: number,
        options?: { includeDiscarded?: boolean }
      ) => Promise<TranscriptionItem[]>;
      recordAnalyticsEvent: (
        input: AnalyticsEventInput
      ) => Promise<{ success: boolean; eventId?: string; ignored?: boolean }>;
      getAnalyticsSummary: () => Promise<AnalyticsSummary>;
      getPendingAnalyticsEvents: (
        limit?: number,
        context?: AnalyticsSyncContext
      ) => Promise<PendingAnalyticsEvent[]>;
      markAnalyticsEventsSynced: (
        eventIds: string[],
        context?: AnalyticsSyncContext
      ) => Promise<{ success: boolean; updated: number }>;
      getPendingAnalyticsDeletes: (
        limit?: number,
        context?: AnalyticsSyncContext
      ) => Promise<Array<{ event_id: string }>>;
      hardDeleteAnalyticsEvents: (
        eventIds: string[],
        context?: AnalyticsSyncContext
      ) => Promise<{ success: boolean; deleted: number }>;
      getPendingAnalyticsClear: (
        context?: AnalyticsSyncContext
      ) => Promise<PendingAnalyticsClear | null>;
      completeAnalyticsClear: (
        clearedThrough: string,
        context?: AnalyticsSyncContext
      ) => Promise<{ success: boolean; deleted: number }>;
      countUnclaimedAnalyticsEvents: (context?: AnalyticsSyncContext) => Promise<number>;
      countAnalyticsEventsAwaitingUpload: (context?: AnalyticsSyncContext) => Promise<number>;
      claimAnonymousAnalyticsEvents: (
        accountId: string,
        expectedAuthGeneration: number
      ) => Promise<{ success: boolean; claimed: number; code?: string }>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;
      getTranscriptionById: (id: number) => Promise<TranscriptionItem | null>;

      // Audio retention operations
      saveTranscriptionAudio: (
        id: number,
        audioBuffer: ArrayBuffer,
        metadata?: { durationMs?: number; provider?: string; model?: string }
      ) => Promise<{ success: boolean; path?: string }>;
      mergeAudioSegments: (
        segments: Array<{ buffer: ArrayBuffer; mimeType: string }>,
        options?: { quality?: RecordingQuality }
      ) => Promise<
        | { success: true; buffer: ArrayBuffer; mimeType: "audio/webm" }
        | { success: false; error: string }
      >;
      getAudioPath: (id: number) => Promise<string | null>;
      showAudioInFolder: (id: number) => Promise<{ success: boolean }>;
      getAudioBuffer: (id: number) => Promise<ArrayBuffer | null>;
      deleteTranscriptionAudio: (id: number) => Promise<{ success: boolean }>;
      getAudioStorageUsage: () => Promise<{ fileCount: number; totalBytes: number }>;
      deleteAllAudio: () => Promise<DeleteAllAudioResult>;
      openRecordingsFolder?: () => Promise<{ success: boolean; error?: string }>;
      getStorageInventory?: (options?: { refresh?: boolean }) => Promise<StorageInventoryResult>;
      openStorageItem?: (id: StorageResourceId) => Promise<StorageActionResult>;
      clearStorageItem?: (id: StorageResourceId) => Promise<StorageActionResult>;
      syncRetentionSettings?: (settings: {
        audioRetentionDays: number;
        transcriptRetentionDays: number;
        dataRetentionEnabled: boolean;
        localHistoryPolicyResolved: boolean;
        localHistoryForcedOff?: boolean;
      }) => void;
      retryTranscription: (
        id: number,
        settings?: {
          useLocalWhisper: boolean;
          localTranscriptionProvider: string;
          cloudTranscriptionMode: string;
          cloudTranscriptionProvider: string;
          cloudTranscriptionModel: string;
          cloudTranscriptionBaseUrl?: string;
          cortiEnvironment?: string;
          cortiTenant?: string;
          /** Azure Speech's resource endpoint; main re-checks it before sending the key. */
          azureSpeechEndpoint?: string;
          parakeetModel: string;
          cohereModel: string;
          whisperModel: string;
          preferredLanguage?: string;
          /** The speech language a live dictation of the row used (a translation's source). */
          speechLanguage?: string;
          /** The dictionary to send, as live dictation would (sttHintFields.js). */
          dictionary?: RetryHintDictionary;
          transcriptionMode?: InferenceMode;
          remoteTranscriptionType?: SelfHostedType;
          remoteTranscriptionUrl?: string;
          remoteTranscriptionModel?: string;
          managed?: {
            kind: "managed";
            provider: "azure";
            deployment: string;
            context: ManagedEnterpriseRequestContext;
          };
        }
      ) => Promise<{
        success: boolean;
        transcription?: TranscriptionItem;
        error?: string;
        /** "DICTIONARY_ECHO": the transcript only repeated the dictionary sent; nothing was written. */
        code?: TranscriptionErrorCode | "DICTIONARY_ECHO";
        messageKey?: string;
        /** Main's step-history run for this retry; put it on the trace as `runId`. */
        stepRunId?: string | null;
        /** A newer run on this row (Re-transcribe, Re-run cleanup) began; nothing was written. */
        stale?: boolean;
      }>;
      updateTranscriptionText: (
        id: number,
        text: string,
        rawText: string,
        options?: { trace?: PostTranscriptionTrace }
      ) => Promise<{
        success: boolean;
        transcription?: TranscriptionItem;
        error?: string;
        /** A newer retry of the same row overtook this one; nothing was written. */
        stale?: boolean;
      }>;
      beginStepHistoryRun?: (options?: {
        /** A re-sent failed dictation's History row: its steps replace that row's. */
        transcriptionId?: number;
      }) => Promise<{ runId: string | null }>;
      completeFailedDictationRetry?: (
        id: number,
        text: string,
        rawText: string | null,
        options?: {
          trace?: PostTranscriptionTrace;
          provider?: string | null;
          model?: string | null;
        }
      ) => Promise<{
        success: boolean;
        transcription?: TranscriptionItem;
        stepsSaved?: boolean;
        /** The row completed meanwhile, or a newer retry overtook this one; nothing was written. */
        stale?: boolean;
        /** "NOT_FOUND": the row is gone; save the dictation as a new row. */
        code?: string;
        error?: string;
      }>;
      getTranscriptionSteps?: (id: number) => Promise<TranscriptionStepsResult>;
      exportDictations?: () => Promise<ExportDictationsResult>;
      listHistory?: (request: HistoryListRequest) => Promise<HistoryListResult>;
      getHistoryApps?: () => Promise<HistoryAppsResult>;
      getHistoryItem?: (id: number) => Promise<HistoryItemResult>;
      /** Loaded rows' "📖 n fixed" badges, after a dictionary or snippet change. */
      getHistoryDictionaryFixes?: (ids: number[]) => Promise<HistoryDictionaryFixesResult>;
      getHistoryFeedback?: (
        id: number
      ) => Promise<{ success: boolean; feedback: HistoryFeedback | null; code?: string }>;
      saveHistoryFeedback?: (
        input: HistoryFeedbackSaveRequest
      ) => Promise<HistoryFeedbackSaveResult>;
      deleteHistoryFeedback?: (
        id: number
      ) => Promise<{ success: boolean; removed?: boolean; code?: string }>;
      onHistoryFeedbackChanged?: (callback: (change: { id: number }) => void) => () => void;
      getPendingReviewRequest?: () => Promise<HistoryReviewRequest | null>;
      onReviewDictationPending?: (callback: () => void) => () => void;
      /** The dictation window: a card's "Open in History", at the row its dictation saved. */
      openHistoryItem?: (id: number) => Promise<{ opened: boolean; id?: number; reason?: string }>;
      /** The control panel: the dictation a card asked to open, without a review. */
      getPendingHistoryItemRequest?: () => Promise<HistoryItemRequest | null>;
      onHistoryItemPending?: (callback: () => void) => () => void;
      /** The dictation window: the review hotkey was pressed during a dictation. */
      onReviewDictationBusy?: (callback: () => void) => () => void;
      /** Hides the control panel to the tray. */
      hideControlPanel?: () => Promise<void>;
      /** The dictation window: a finished dictation is still being pasted or saved. */
      dictationDeliveryStateChanged?: (delivering: boolean) => void;
      // Prompt test cases (main-owned, owner-scoped, local-only)
      listTestCases?: () => Promise<PromptTestCaseList>;
      pinHistoryTestCase?: (transcriptionId: number) => Promise<PromptTestCaseWriteResult>;
      saveTestCase?: (
        input: PromptTestCaseEditable & { rawText: string; target?: string }
      ) => Promise<PromptTestCaseWriteResult>;
      updateTestCase?: (
        id: string,
        patch: PromptTestCaseEditable
      ) => Promise<PromptTestCaseWriteResult>;
      deleteTestCase?: (id: string) => Promise<PromptTestCaseWriteResult>;
      /** `target`: only that target's cases ("cleanup" or "style:<id>"); all when omitted. */
      clearTestCases?: (target?: string) => Promise<PromptTestCaseWriteResult>;
      onTestCasesChanged?: (callback: (change: PromptTestCasesChange) => void) => () => void;
      getDictationLifecycle?: () => Promise<DictationLifecycleSnapshot>;
      onDictationLifecycleChanged?: (
        callback: (lifecycle: DictationLifecycleSnapshot) => void
      ) => () => void;

      // Dictionary operations
      getDictionary: () => Promise<string[]>;
      /** Words with their source, in stored order. */
      getDictionaryEntries?: () => Promise<DictionaryEntry[]>;
      /** Replaces the whole dictionary — omitted words are deleted. Prefer applyDictionaryChanges. */
      setDictionary: (words: string[]) => Promise<{ success: boolean }>;
      applyDictionaryChanges?: (changes: {
        add?: string[];
        remove?: string[];
      }) => Promise<{ success: boolean; added: number; removed: number }>;
      onDictionaryUpdated?: (callback: (words: string[]) => void) => () => void;
      getSnippets?: () => Promise<Array<{ trigger: string; replacement: string }>>;
      setSnippets?: (
        snippets: Array<{ trigger: string; replacement: string }>
      ) => Promise<{ success: boolean }>;
      onSnippetsUpdated?: (
        callback: (snippets: Array<{ trigger: string; replacement: string }>) => void
      ) => () => void;
      // Glossary rules (main-owned, local-only)
      getGlossaryRules?: () => Promise<GlossarySnapshot>;
      saveGlossaryRule?: (rule: GlossaryRuleInput) => Promise<GlossarySaveResult>;
      deleteGlossaryRule?: (id: string) => Promise<GlossarySaveResult>;
      onGlossaryRulesUpdated?: (callback: (snapshot: GlossarySnapshot) => void) => () => void;
      setAutoLearnMode?: (mode: AutoLearnMode) => void;
      onCorrectionsLearned?: (callback: (words: string[]) => void) => () => void;
      undoLearnedCorrections?: (words: string[]) => Promise<{ success: boolean }>;
      // Pins (main-owned, local-only): dictionaryWordKey of each pinned word
      getDictionaryPins?: () => Promise<string[]>;
      setDictionaryPin?: (
        word: string,
        pinned: boolean
      ) => Promise<{ success: boolean; changed?: boolean; pins?: string[]; code?: string }>;
      /** The pins in a new order: exactly the current keys, else MISMATCH (with the pins as they are). */
      reorderDictionaryPins?: (
        keys: string[]
      ) => Promise<{ success: boolean; changed?: boolean; pins?: string[]; code?: string }>;
      onDictionaryPinsUpdated?: (callback: (pins: string[]) => void) => () => void;
      // Auto-learn's suggestions (main-owned, local-only)
      listDictionarySuggestions?: () => Promise<DictionarySuggestionList>;
      acceptDictionarySuggestions?: (
        ids: number[]
      ) => Promise<{ success: boolean; accepted: number }>;
      dismissDictionarySuggestions?: (
        ids: number[]
      ) => Promise<{ success: boolean; dismissed: number }>;
      clearDismissedDictionarySuggestions?: () => Promise<{ success: boolean; cleared: number }>;
      onDictionarySuggestionsUpdated?: (
        callback: (change: { reason: string }) => void
      ) => () => void;
      /** The dictation window: words auto-learn just suggested (Suggest mode). */
      onCorrectionsSuggested?: (
        callback: (suggestions: Array<{ id: number; word: string }>) => void
      ) => () => void;
      /** The suggestion toast's Review: opens the Dictionary in the control panel. */
      openDictionarySuggestions?: () => Promise<{ success: boolean }>;
      getPendingDictionarySuggestionsRequest?: () => Promise<boolean>;
      onDictionarySuggestionsPending?: (callback: () => void) => () => void;
      /** Heard vs written per dictionary word over local History (counts only). */
      getDictionaryUsage?: () => Promise<DictionaryUsageResult>;
      /** One word's heard and written counts per week (counts only). */
      getDictionaryWordUsage?: (word: string) => Promise<DictionaryWordUsageResult>;
      /** What a word replaced and where, this owner's, while local history is durable. */
      getDictionaryWordEvidence?: (word: string) => Promise<DictionaryWordEvidenceResult>;
      /** How this owner's cleanups ran per dictionary word set (counts only). */
      getDictionaryCleanupScopeCounts?: () => Promise<CleanupScopeCountsResult>;
      /** One word's dictations, newest first, with snippets of their own text. */
      getDictionaryWordOccurrences?: (
        word: string,
        options?: DictionaryOccurrencesRequest
      ) => Promise<DictionaryOccurrencesResult>;
      /** The spellings speech wrote where the final text has the word; `spelling`: its own numbers too. */
      getDictionarySpeechVariants?: (
        word: string,
        options?: { spelling?: string }
      ) => Promise<DictionarySpeechVariantsResult>;
      /** The owner or History's policy changed: drop what was read for the old one. */
      onDictionaryHistoryChanged?: (
        callback: (change: { reason: "owner" | "policy" }) => void
      ) => () => void;
      /** A word's new spelling, in place: source, date, pin and evidence kept. */
      renameDictionaryWord?: (from: string, to: string) => Promise<DictionaryRenameResult>;
      /** Folds `from` into `into`: typed wins, a pin survives, evidence moves. */
      mergeDictionaryWords?: (from: string, into: string) => Promise<DictionaryMergeResult>;
      /** "Mark typed": learned words become typed ("manual" only). */
      setDictionarySource?: (
        words: string[],
        source: "manual"
      ) => Promise<{ success: boolean; changed?: number; code?: string }>;
      /** Tidy up's History aggregates: frequent tokens and adjacent words (counts only). */
      getDictionaryTidyInputs?: () => Promise<DictionaryTidyInputsResult>;
      /** Tidy up's choices in one batch; each applied one returns its Undo steps. */
      applyDictionaryTidy?: (ops: DictionaryTidyOp[]) => Promise<DictionaryTidyApplyResult>;
      /** Reverses one Tidy up action: all of its steps or none, refused with the reason. */
      undoDictionaryTidy?: (steps: DictionaryTidyUndoStep[]) => Promise<DictionaryTidyUndoResult>;

      // Note operations
      saveNote: (
        title: string,
        content: string,
        noteType?: string,
        sourceFile?: string | null,
        audioDuration?: number | null,
        folderId?: number | null,
        spaceId?: number | null
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      getNote: (id: number) => Promise<NoteItem | null>;
      getNotes: (
        noteType?: string | null,
        limit?: number,
        folderId?: number | null,
        spaceId?: number | null
      ) => Promise<NoteItem[]>;
      getSpaceNotes: (spaceId: number, limit?: number) => Promise<NoteItem[]>;
      updateNote: (
        id: number,
        updates: {
          title?: string;
          content?: string;
          enhanced_content?: string | null;
          enhancement_prompt?: string | null;
          enhancement_template_id?: string | null;
          enhanced_at_content_hash?: string | null;
          folder_id?: number | null;
          space_id?: number;
          transcript?: string | null;
          calendar_event_id?: string | null;
          participants?: string | null;
          diarization_enabled?: number | null;
          expected_speaker_count?: number | null;
          client_note_id?: string;
          cloud_id?: string | null;
          cloud_updated_at?: string | null;
          owner_user_id?: string | null;
          updated_by_user_id?: string | null;
          left_team?: number;
        },
        options?: { undoable: true; expected: NoteItem; turn?: string }
      ) => Promise<{ success: boolean; note?: NoteItem; error?: string }>;
      getNoteUndos: () => Promise<Array<{ token: string; noteId: number; title: string }>>;
      claimNoteUndo: (token: string) => Promise<boolean>;
      undoNoteUpdate: (
        token: string
      ) => Promise<{ success: boolean; note?: NoteItem; error?: string }>;
      discardNoteUndo: (id: number, token?: string) => Promise<void>;
      deleteNote: (id: number) => Promise<{ success: boolean }>;
      exportNote: (
        noteId: number,
        format: "txt" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportTranscript: (
        noteId: number,
        format: "txt" | "srt" | "json" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportDictionary: (words: string[]) => Promise<{ success: boolean; error?: string }>;
      searchNotes: (
        query: string,
        limit?: number,
        spaceId?: number | null,
        folderId?: number | null
      ) => Promise<NoteItem[]>;
      semanticSearchNotes: (
        query: string,
        limit?: number,
        spaceId?: number | null,
        folderId?: number | null
      ) => Promise<NoteItem[]>;
      updateNoteCloudId: (id: number, cloudId: string) => Promise<NoteItem>;
      updateNoteShareState: (
        id: number,
        state: { is_shared: number; share_token?: string | null }
      ) => Promise<NoteItem>;

      // Folder operations
      getFolders: (spaceId?: number | null) => Promise<FolderItem[]>;
      createFolder: (
        name: string,
        spaceId?: number | null
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      deleteFolder: (id: number) => Promise<{ success: boolean; error?: string }>;
      renameFolder: (
        id: number,
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      moveFolderToSpace: (
        id: number,
        spaceId: number
      ) => Promise<{ success: boolean; folder?: FolderItem; notes?: NoteItem[]; error?: string }>;
      getFolderNoteCounts: () => Promise<
        Array<{ space_id: number; folder_id: number | null; count: number }>
      >;

      // Space operations
      getSpaces?: () => Promise<SpaceItem[]>;
      setActiveAccountScope?: (
        accountId: string | null,
        expectedAuthGeneration?: number
      ) => Promise<{ success: boolean; code?: string; error?: string }>;
      getActiveAccountScope?: () => Promise<ActiveAccountScope | null>;
      onActiveAccountScopeChanged?: (
        callback: (scope: ActiveAccountScope | null) => void
      ) => () => void;
      deleteAccountData?: (
        accountId: string,
        expectedAuthGeneration: number,
        options?: { erasingDevice?: boolean }
      ) => Promise<{
        success: boolean;
        code?: string;
        error?: string;
        deletedNoteIds?: number[];
        deletedFolderIds?: number[];
      }>;
      updateSpace?: (
        id: number,
        updates: { name?: string; emoji?: string | null }
      ) => Promise<{ success: boolean; space?: SpaceItem; error?: string }>;
      purgeSpace?: (
        id: number,
        options?: {
          mode?: "preserve-dirty" | "destructive";
          expectedAuthGeneration?: number;
        }
      ) => Promise<{
        success: boolean;
        code?: string;
        error?: string;
        noteIds?: number[];
        folderNames?: string[];
        spaceId?: number;
        relocatedNotes?: NoteItem[];
        relocatedCount?: number;
        relocatedTitles?: string[];
        preservedForOtherAccounts?: boolean;
      }>;
      upsertSpaceFromCloud?: (space: Record<string, unknown>) => Promise<SpaceItem>;
      setSpaceSyncStatus?: (
        id: number,
        status: SpaceItem["sync_status"]
      ) => Promise<{ success: boolean; space?: SpaceItem | null }>;
      onSpacePurged?: (callback: (payload: { spaceId: number }) => void) => () => void;
      onSpaceSynced?: (callback: (space: SpaceItem) => void) => () => void;

      // Note files (markdown mirror)
      noteFilesSetEnabled?: (
        enabled: boolean,
        customPath?: string,
        options?: { skipRebuild?: boolean }
      ) => Promise<{ success: boolean; error?: string }>;
      noteFilesSetPath?: (path: string) => Promise<{ success: boolean; error?: string }>;
      noteFilesRebuild?: () => Promise<{ success: boolean; error?: string }>;
      noteFilesGetDefaultPath?: () => Promise<string>;
      noteFilesPickFolder?: () => Promise<{ canceled: boolean; path?: string }>;
      granolaImportPickAndPreview?: () => Promise<{
        canceled: boolean;
        success?: boolean;
        error?: string;
        fileName?: string;
        total?: number;
        newCount?: number;
        duplicateCount?: number;
        sampleTitles?: string[];
        rowIssueCount?: number;
      }>;
      granolaImportRun?: () => Promise<{
        success: boolean;
        error?: string;
        imported?: number;
        skipped?: number;
        errors?: Array<{ clientNoteId: string; error: string }>;
      }>;
      showNoteFile?: (noteId: number) => Promise<{ success: boolean }>;
      showFolderInExplorer?: (folderName: string) => Promise<{ success: boolean }>;

      // Action operations
      getActions: () => Promise<ActionItem[]>;
      getAction: (id: number) => Promise<ActionItem | null>;
      createAction: (
        name: string,
        description: string,
        prompt: string,
        icon?: string,
        fields?: { kind?: ActionKind; sections?: TemplateSection[]; output?: ActionOutput }
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      updateAction: (
        id: number,
        updates: {
          name?: string;
          description?: string;
          prompt?: string;
          icon?: string;
          sort_order?: number;
          sections?: TemplateSection[];
          output?: ActionOutput;
        }
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      deleteAction: (id: number) => Promise<{ success: boolean; id?: number; error?: string }>;
      onActionCreated?: (callback: (action: ActionItem) => void) => () => void;
      onActionUpdated?: (callback: (action: ActionItem) => void) => () => void;
      onActionDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Audio file operations
      saveTempAudio: (buffer: ArrayBuffer) => Promise<{ success: boolean; path: string }>;
      deleteTempAudio: (tempPath: string) => Promise<{ success: boolean; error?: string }>;
      selectAudioFile: (options?: { multiple?: boolean }) => Promise<{
        canceled: boolean;
        filePath?: string;
        filePaths?: string[];
      }>;
      getFileSize?: (filePath: string) => Promise<number>;
      transcribeAudioFile: (
        filePath: string,
        options?: {
          provider?: LocalTranscriptionProvider;
          model?: string;
          language?: string;
          requestId?: string;
          [key: string]: unknown;
        }
      ) => Promise<{ success: boolean; text?: string; error?: string; code?: string }>;
      getPathForFile: (file: File) => string;

      // URL audio download
      downloadUrlAudio: (
        url: string,
        downloadId?: string
      ) => Promise<
        | {
            success: true;
            tempPath: string;
            title: string;
            durationSeconds: number | null;
            sizeBytes: number;
          }
        | { success: false; error: string; code?: string }
      >;
      cancelUrlDownload: (downloadId?: string) => Promise<{ success: boolean }>;
      deleteTempFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      onUrlDownloadProgress?: (
        callback: (data: {
          stage: "resolving" | "downloading" | "ready";
          percent: number;
          title?: string;
          downloadId?: string;
        }) => void
      ) => () => void;

      // Note event listeners
      onNoteAdded?: (callback: (note: NoteItem) => void) => () => void;
      onNoteUpdated?: (callback: (note: NoteItem) => void) => () => void;
      onNoteDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onNoteSynced?: (callback: (note: NoteItem) => void) => () => void;
      onFolderSynced?: (callback: (folder: FolderItem) => void) => () => void;
      onFolderDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Cross-window sync events
      emitSyncEvent?: (name: string, payload?: unknown) => Promise<{ success: boolean }>;
      onSyncEvent?: (callback: (event: { name: string; payload?: unknown }) => void) => () => void;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionUpdated?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onTranscriptionsCleared?: (callback: (payload: { cleared: number }) => void) => () => void;
      onAnalyticsChanged?: (callback: () => void) => () => void;

      // API key management
      getOpenAIKey: () => Promise<string>;
      saveOpenAIKey: (key: string) => Promise<{ success: boolean }>;
      getAnthropicKey: () => Promise<string | null>;
      saveAnthropicKey: (key: string) => Promise<void>;
      getUiLanguage: () => Promise<string>;
      saveUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      setUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      saveAllKeysToEnv: () => Promise<{ success: boolean; path: string }>;
      syncStartupPreferences: (
        prefs: LocalServerPrefs & {
          useLocalWhisper: boolean;
          localTranscriptionProvider: LocalTranscriptionProvider;
          model?: string;
          language?: string;
          keepLocalModelLoaded: boolean;
          policySettled: boolean;
        }
      ) => Promise<void>;

      // Clipboard operations
      checkAccessibilityPermission: (silent?: boolean) => Promise<boolean>;
      promptAccessibilityPermission: () => Promise<boolean>;
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;
      copyLeaderboardImage: (dataUrl: string) => Promise<{ success: boolean; error?: string }>;
      saveLeaderboardImage: (
        dataUrl: string,
        suggestedName: string
      ) => Promise<{ success: boolean; canceled?: boolean; error?: string }>;
      checkPasteTools: () => Promise<PasteToolsResult>;

      // Audio

      // Whisper operations (whisper.cpp)
      transcribeLocalWhisper: (audioBlob: Blob | ArrayBuffer, options?: any) => Promise<any>;
      checkWhisperInstallation: () => Promise<WhisperCheckResult>;
      downloadWhisperModel: (modelName: string) => Promise<WhisperModelResult>;
      onWhisperDownloadProgress: (
        callback: (event: any, data: WhisperDownloadProgressData) => void
      ) => () => void;
      checkModelStatus: (modelName: string) => Promise<WhisperModelResult>;
      listWhisperModels: () => Promise<WhisperModelsListResult>;
      deleteWhisperModel: (modelName: string) => Promise<WhisperModelDeleteResult>;
      deleteAllWhisperModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelWhisperDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;

      // Whisper server lifecycle
      whisperServerStatus: () => Promise<WhisperServerStatus>;
      whisperGpuRetry: () => Promise<{ success: boolean; willRestart: boolean }>;

      // CUDA GPU acceleration
      listGpus?: () => Promise<GpuDevice[]>;
      setGpuDeviceIndex?: (
        purpose: "transcription" | "intelligence",
        uuid: string
      ) => Promise<{ success: boolean }>;
      getGpuDeviceIndex?: (purpose: "transcription" | "intelligence") => Promise<string>;
      detectGpu: () => Promise<GpuInfo>;
      getCudaWhisperStatus: () => Promise<CudaWhisperStatus>;
      downloadCudaWhisperBinary: () => Promise<{
        success: boolean;
        willRestart?: boolean;
        error?: string;
      }>;
      cancelCudaWhisperDownload: () => Promise<{ success: boolean }>;
      deleteCudaWhisperBinary: () => Promise<{ success: boolean }>;
      onCudaDownloadProgress: (
        callback: (data: {
          downloadedBytes: number;
          totalBytes: number;
          percentage: number;
        }) => void
      ) => () => void;
      onCudaFallbackNotification: (callback: () => void) => () => void;

      // Vulkan GPU acceleration (whisper on AMD/Intel GPUs)
      getVulkanWhisperStatus: () => Promise<VulkanWhisperStatus>;
      downloadVulkanWhisperBinary: () => Promise<{
        success: boolean;
        willRestart?: boolean;
        error?: string;
      }>;
      cancelVulkanWhisperDownload: () => Promise<{ success: boolean }>;
      deleteVulkanWhisperBinary: () => Promise<{ success: boolean; deletedCount?: number }>;
      onVulkanWhisperDownloadProgress: (
        callback: (data: {
          downloadedBytes: number;
          totalBytes: number;
          percentage: number;
        }) => void
      ) => () => void;
      onGpuFallbackNotification: (callback: () => void) => () => void;
      onWhisperGpuStatusChanged: (callback: () => void) => () => void;

      // One-time "GPU pack needs re-downloading" notice from the legacy-layout migration
      getGpuPackMigrationNotice: () => Promise<{ packs: string[] } | null>;
      dismissGpuPackMigrationNotice: () => Promise<{ success: boolean }>;

      // Parakeet operations (NVIDIA via sherpa-onnx)
      transcribeLocalParakeet: (
        audioBlob: ArrayBuffer,
        options?: { model?: string; language?: string }
      ) => Promise<ParakeetTranscriptionResult>;
      checkParakeetInstallation: () => Promise<ParakeetCheckResult>;
      downloadParakeetModel: (modelName: string) => Promise<ParakeetModelResult>;
      onParakeetDownloadProgress: (
        callback: (event: any, data: ParakeetDownloadProgressData) => void
      ) => () => void;
      checkParakeetModelStatus: (modelName: string) => Promise<ParakeetModelResult>;
      listParakeetModels: () => Promise<ParakeetModelsListResult>;
      deleteParakeetModel: (modelName: string) => Promise<ParakeetModelDeleteResult>;
      deleteAllParakeetModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelParakeetDownload: () => Promise<
        {
          success: boolean;
          message?: string;
        } & PolicyFailureMetadata
      >;
      getParakeetDiagnostics: () => Promise<ParakeetDiagnosticsResult>;

      // Local AI model management
      modelGetAll: () => Promise<LocalLLMModelStatus[]>;
      modelGetActiveDownloads: () => Promise<LocalModelDownloadStatus[]>;
      modelCheck: (modelId: string) => Promise<boolean>;
      modelDownload: (modelId: string) => Promise<{
        success: boolean;
        path?: string;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDelete: (modelId: string) => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDeleteAll: () => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelCheckRuntime: () => Promise<{
        available: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelCancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>;
      onModelDownloadProgress: (
        callback: (event: any, data: LocalLLMDownloadProgressEvent) => void
      ) => () => void;

      // Local reasoning
      processLocalReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: ReasoningConfig
      ) => Promise<{
        success: boolean;
        text?: string;
        error?: string;
        code?: string;
        details?: Record<string, unknown>;
      }>;
      checkLocalReasoningAvailable: () => Promise<boolean>;
      /** The largest context this machine can give a bundled model; drives chunked note generation. */
      getLocalContextBudget: (modelId: string) => Promise<{
        success: boolean;
        maxContextTokens?: number;
        modelName?: string;
        error?: string;
      }>;
      /** Aborts the local request tagged with this `requestId`, if it is still in flight. */
      cancelLocalReasoning: (requestId: string) => Promise<void>;

      // Anthropic reasoning
      processAnthropicReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string } & Partial<IpcErrorFields>>;

      // GitHub Copilot (main-process sign-in; the token never reaches the renderer)
      processCopilotReasoning?: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string } & Partial<IpcErrorFields>>;
      getCopilotAuthStatus?: () => Promise<CopilotAuthStatus>;
      startCopilotSignIn?: () => Promise<CopilotAuthStatus>;
      cancelCopilotSignIn?: (flowId: string) => Promise<CopilotAuthStatus>;
      retryCopilotSignIn?: (flowId: string) => Promise<CopilotAuthStatus>;
      signOutOfCopilot?: () => Promise<CopilotAuthStatus>;
      listCopilotModels?: (options?: {
        refresh?: boolean;
      }) => Promise<{ success: boolean; models?: CopilotModel[] } & Partial<IpcErrorFields>>;
      onCopilotAuthChanged?: (callback: (status: CopilotAuthStatus) => void) => () => void;

      // Enterprise reasoning (Bedrock, Azure, Vertex)
      processEnterpriseReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{
        success: boolean;
        text?: string;
        error?: string;
        messageKey?: string;
        messageParams?: Record<string, string | number>;
        action?: string;
        actionKey?: string;
        copyCommand?: string;
        retryable?: boolean;
        technicalDetails?: {
          status?: number;
          exceptionType?: string;
          requestId?: string;
          underlyingError?: string;
        };
      }>;
      cancelEnterpriseReasoning?: () => void;
      enterpriseStreamStart?: (payload: {
        streamId: string;
        provider: string;
        modelId: string;
        config: Record<string, unknown>;
        options: Record<string, unknown>;
      }) => Promise<{ success: boolean; error?: string }>;
      enterpriseStreamCancel?: (streamId: string) => Promise<void>;
      onEnterpriseStreamPart?: (
        callback: (payload: {
          streamId: string;
          part?: unknown;
          done?: boolean;
          error?: string;
        }) => void
      ) => () => void;
      listBedrockModels?: (config: Record<string, unknown>) => Promise<{
        success: boolean;
        models?: Array<{ value: string; label: string; vendor: string }>;
        error?: string;
      }>;

      // llama.cpp management
      llamaCppCheck: () => Promise<{ isInstalled: boolean; version?: string }>;
      llamaCppInstall: () => Promise<{ success: boolean; error?: string }>;
      llamaCppUninstall: () => Promise<{ success: boolean; error?: string }>;

      // llama-server
      llamaServerStart: (
        modelId: string
      ) => Promise<{ success: boolean; port?: number; error?: string }>;
      llamaServerStatus: () => Promise<LlamaServerStatus>;
      llamaGpuReset: () => Promise<{ success: boolean; error?: string }>;
      detectVulkanGpu?: () => Promise<VulkanGpuResult>;
      getLlamaVulkanStatus?: () => Promise<LlamaVulkanStatus>;
      downloadLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        cancelled?: boolean;
        error?: string;
      }>;
      cancelLlamaVulkanDownload?: () => Promise<{ success: boolean }>;
      deleteLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        deletedCount?: number;
        error?: string;
      }>;
      onLlamaVulkanDownloadProgress?: (
        callback: (data: LlamaVulkanDownloadProgress) => void
      ) => () => void;

      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      snapToMeetingMode: () => Promise<void>;
      restoreFromMeetingMode: () => Promise<void>;
      getPlatform: () => string;
      startWindowDrag: () => Promise<void>;
      stopWindowDrag: () => Promise<void>;
      startControlPanelDrag: () => Promise<void>;
      stopControlPanelDrag: () => Promise<void>;
      setMainWindowInteractivity: (interactive: boolean) => Promise<void>;
      setMainWindowInputRegion: (region: MainWindowInputRegion | null) => Promise<boolean>;
      onMainWindowVisibilityChanged: (callback: (visible: boolean) => void) => () => void;
      setNotificationInteractivity: (interactive: boolean) => Promise<void>;
      resizeMainWindow: (
        sizeKey:
          | "BASE"
          | "RECORDING"
          | "DICTATION_ERROR"
          | "DICTATION_ERROR_WITH_TRANSCRIPT"
          | "WITH_MENU"
          | "WITH_TOAST"
          | "EXPANDED"
          | "ASSISTANT"
      ) => Promise<{
        success: boolean;
        bounds?: Electron.Rectangle;
        message?: string;
        changed?: boolean;
      }>;
      resizeAssistantWindowToContent: (surfaceHeight: number) => Promise<{
        success: boolean;
        bounds?: Electron.Rectangle;
        message?: string;
        changed?: boolean;
      }>;
      resizeDictationErrorWindowToContent: (
        surfaceHeight: number
      ) => Promise<{ success: boolean; bounds?: Electron.Rectangle; message?: string }>;
      setAssistantPanelOpen: (open: boolean) => Promise<{ success: boolean }>;
      setAssistantPanelBusy: (busy: boolean) => Promise<{ success: boolean }>;

      // App management
      cleanupApp: () => Promise<{ success: boolean; message: string; errors?: string[] }>;
      relaunchApp: () => Promise<void>;

      // Update operations
      checkForUpdates: () => Promise<UpdateCheckResult>;
      downloadUpdate: () => Promise<UpdateResult>;
      installUpdate: () => Promise<UpdateResult>;
      getAppVersion: () => Promise<AppVersionResult>;
      getBuildInfo: () => Promise<BuildInfoResult>;
      getPostMigrationState: () => Promise<{ justMigrated: boolean }>;
      getOAuthProtocolRegistered: () => Promise<boolean>;
      getOAuthProtocol: () => Promise<string>;
      markBundleMigrated: () => Promise<void>;
      markBundleMigrationDismissed: () => Promise<void>;
      getUpdateStatus: () => Promise<UpdateStatusResult>;
      getUpdateInfo: () => Promise<UpdateInfoResult | null>;
      setAutoUpdatesEnabled: (enabled: boolean) => Promise<{ success: boolean }>;

      // Update event listeners
      onUpdateAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateNotAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloaded: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloadProgress: (callback: (event: any, progressObj: any) => void) => () => void;
      onUpdateError: (callback: (event: any, error: any) => void) => () => void;

      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

      // Hotkey management
      updateHotkey: (key: string) => Promise<{ success: boolean; message: string }>;
      setHotkeyListeningMode?: (enabled: boolean) => Promise<{ success: boolean }>;
      getHotkeyModeInfo?: (hotkey?: string) => Promise<{
        isUsingGnome: boolean;
        isUsingHyprland: boolean;
        isUsingKDE: boolean;
        isUsingNativeShortcut: boolean;
        supportsPushToTalk: boolean;
        pushToTalkUnavailableReason: string | null;
        linuxInputAccessDenied?: boolean;
      }>;
      getHyprlandConfigStatus?: () => Promise<{ canWrite: boolean; path: string } | null>;

      // Wayland paste diagnostics
      getYdotoolStatus?: () => Promise<{
        isLinux: boolean;
        isWayland: boolean;
        hasYdotool: boolean;
        hasYdotoold: boolean;
        hasWtype: boolean;
        daemonRunning: boolean;
        hasService: boolean;
        hasUinput: boolean;
        hasUdevRule: boolean;
        hasGroup: boolean;
        isNixOS: boolean;
        isKde: boolean;
        isWlroots: boolean;
        isCosmic: boolean;
        hasXclip: boolean;
        hasXsel: boolean;
      }>;

      // Globe key listener for hotkey capture (macOS only)
      onGlobeKeyPressed?: (callback: () => void) => () => void;
      onGlobeKeyReleased?: (callback: () => void) => () => void;

      // Hotkey registration events
      onHotkeyFallbackUsed?: (
        callback: (data: { original: string; fallback: string }) => void
      ) => () => void;
      onHotkeyRegistrationFailed?: (
        callback: (data: { hotkey: string; error: string; suggestions: string[] }) => void
      ) => () => void;
      onApiKeyUpdated?: (callback: (storeKey: string) => void) => () => void;
      onSettingUpdated?: (callback: (data: { key: string; value: unknown }) => void) => () => void;
      onDictationKeyActive?: (callback: (key: string) => void) => () => void;
      onLinuxPttPermissionDenied?: (callback: () => void) => () => void;

      // Settings shortcut (Cmd+, / Ctrl+,)
      onShowSettings?: (callback: () => void) => () => void;
      getPendingSettingsSection?: () => Promise<string | null>;

      // Accessibility permission events (macOS)
      markMacAccessibilityFeaturesReady?: (expectedAccountScope?: ActiveAccountScope) => void;
      onAccessibilityMissing?: (callback: () => void) => () => void;
      checkAccessibilityTrusted?: () => Promise<boolean>;

      // Gemini API key management
      getGeminiKey: () => Promise<string | null>;
      saveGeminiKey: (key: string) => Promise<void>;
      proxyGeminiTranscription?: (data: {
        audioBuffer: ArrayBuffer;
        model?: string;
        language?: string;
        keyterms?: string[];
      }) => Promise<ProxyTranscriptionResult>;

      // Groq API key management
      getGroqKey: () => Promise<string | null>;
      saveGroqKey: (key: string) => Promise<void>;
      getOpenrouterKey: () => Promise<string | null>;
      saveOpenrouterKey: (key: string) => Promise<void>;

      // xAI API key management
      getXaiKey?: () => Promise<string | null>;
      saveXaiKey?: (key: string) => Promise<void>;
      proxyXaiTranscription?: (data: {
        audioBuffer: ArrayBuffer;
        language?: string;
        keyterms?: string[];
      }) => Promise<ProxyTranscriptionResult>;

      // Mistral API key management
      getMistralKey: () => Promise<string | null>;
      saveMistralKey: (key: string) => Promise<void>;
      proxyMistralTranscription: (data: {
        audioBuffer: ArrayBuffer;
        model?: string;
        language?: string;
        contextBias?: string[];
      }) => Promise<ProxyTranscriptionResult>;

      // Corti credential management
      getCortiClientId?: () => Promise<string | null>;
      saveCortiClientId?: (key: string) => Promise<void>;
      getCortiClientSecret?: () => Promise<string | null>;
      saveCortiClientSecret?: (key: string) => Promise<void>;
      getCortiKey?: () => Promise<string | null>;
      saveCortiKey?: (key: string) => Promise<void>;
      proxyCortiTranscription?: (data: {
        audioBuffer: ArrayBuffer;
        language: string;
        environment: string;
        tenant: string;
      }) => Promise<ProxyTranscriptionResult>;
      getTinfoilKey?: () => Promise<string | null>;
      saveTinfoilKey?: (key: string) => Promise<void>;
      getTinfoilChatModels?: () => Promise<TinfoilCatalogModel[]>;
      proxyTinfoilTranscription?: (data: {
        audioBuffer: ArrayBuffer;
        language?: string;
        prompt?: string;
      }) => Promise<ProxyTranscriptionResult>;
      getDeepgramKey?: () => Promise<string | null>;
      saveDeepgramKey?: (key: string) => Promise<void>;
      getAssemblyAIKey?: () => Promise<string | null>;
      saveAssemblyAIKey?: (key: string) => Promise<void>;
      getAzureSpeechKey?: () => Promise<string | null>;
      saveAzureSpeechKey?: (key: string) => Promise<void>;

      // Custom endpoint API keys
      getCustomTranscriptionKey?: () => Promise<string | null>;
      saveCustomTranscriptionKey?: (key: string) => Promise<void>;
      getCleanupCustomKey?: () => Promise<string | null>;
      saveCleanupCustomKey?: (key: string) => Promise<void>;
      getNoteFormattingCustomKey?: () => Promise<string | null>;
      saveNoteFormattingCustomKey?: (key: string) => Promise<void>;
      getTranslationCustomKey?: () => Promise<string | null>;
      saveTranslationCustomKey?: (key: string) => Promise<void>;
      getDictationAgentCustomKey?: () => Promise<string | null>;
      saveDictationAgentCustomKey?: (key: string) => Promise<void>;
      getDictationAgentVisionCustomKey?: () => Promise<string | null>;
      saveDictationAgentVisionCustomKey?: (key: string) => Promise<void>;
      getChatAgentCustomKey?: () => Promise<string | null>;
      saveChatAgentCustomKey?: (key: string) => Promise<void>;

      // The custom connection: main copies its key between slots; no plain save.
      getCustomConnectionKey?: () => Promise<string | null>;
      customConnectionCopyKey?: (args: {
        fromSlot: CustomConnectionSlot;
      }) => Promise<{ success: boolean }>;
      customConnectionSaveKey?: (args: {
        key: string;
        applyTo: CustomConnectionSlot[];
      }) => Promise<{ success: boolean }>;
      customConnectionApplyKey?: (args: {
        slots: CustomConnectionSlot[];
      }) => Promise<{ success: boolean }>;
      customConnectionCompare?: (args: {
        slots: CustomConnectionSlot[];
      }) => Promise<Partial<Record<CustomConnectionSlot, boolean>>>;
      customConnectionDeleteKey?: () => Promise<{ success: boolean }>;
      customConnectionCheck?: (args: {
        endpoint: string;
        key?: string;
        fromSlot?: CustomConnectionSlot;
      }) => Promise<CustomConnectionCheckResult>;

      // Enterprise provider key persistence
      getBedrockRegion?: () => Promise<string | null>;
      saveBedrockRegion?: (value: string) => Promise<void>;
      getBedrockProfile?: () => Promise<string | null>;
      saveBedrockProfile?: (value: string) => Promise<void>;
      getBedrockAccessKeyId?: () => Promise<string | null>;
      saveBedrockAccessKeyId?: (key: string) => Promise<void>;
      getBedrockSecretAccessKey?: () => Promise<string | null>;
      saveBedrockSecretAccessKey?: (key: string) => Promise<void>;
      getBedrockSessionToken?: () => Promise<string | null>;
      saveBedrockSessionToken?: (key: string) => Promise<void>;
      getAzureEndpoint?: () => Promise<string | null>;
      saveAzureEndpoint?: (value: string) => Promise<void>;
      getAzureApiKey?: () => Promise<string | null>;
      saveAzureApiKey?: (key: string) => Promise<void>;
      getAzureDeployment?: () => Promise<string | null>;
      saveAzureDeployment?: (value: string) => Promise<void>;
      getAzureApiVersion?: () => Promise<string | null>;
      saveAzureApiVersion?: (value: string) => Promise<void>;
      getVertexProject?: () => Promise<string | null>;
      saveVertexProject?: (value: string) => Promise<void>;
      getVertexLocation?: () => Promise<string | null>;
      saveVertexLocation?: (value: string) => Promise<void>;
      getVertexApiKey?: () => Promise<string | null>;
      saveVertexApiKey?: (key: string) => Promise<void>;
      testEnterpriseConnection?: (
        provider: string,
        config: Record<string, unknown>
      ) => Promise<{
        success: boolean;
        error?: string;
        messageKey?: string;
        messageParams?: Record<string, string | number>;
        action?: string;
        actionKey?: string;
        copyCommand?: string;
        technicalDetails?: {
          status?: number;
          exceptionType?: string;
          requestId?: string;
          underlyingError?: string;
        };
      }>;
      getManagedEnterpriseConfig?: (
        accountId: string,
        workspaceId: string,
        expectedAuthGeneration: number,
        forceRefresh?: boolean
      ) => Promise<{
        success: boolean;
        status?: "network" | "current" | "cached" | "error";
        accountId?: string | null;
        workspaceId?: string | null;
        authGeneration?: number | null;
        config?: ManagedEnterpriseConfig;
        code?: string;
        error?: string;
        enforcementRequired?: boolean;
        enforcedScopes?: string[];
      }>;
      onManagedEnterpriseConfigChanged?: (
        callback: (snapshot: {
          accountId: string;
          workspaceId: string;
          authGeneration: number;
          config: ManagedEnterpriseConfig | null;
          code: string | null;
          enforcementRequired?: boolean;
          enforcedScopes?: string[];
        }) => void
      ) => () => void;
      clearManagedEnterpriseIdentity?: () => Promise<void>;
      managedTranscribe?: (data: {
        audioBuffer: ArrayBuffer;
        fileName: string;
        mimeType: string;
        language?: string;
        prompt?: string;
        managed: { provider: "azure"; context: ManagedEnterpriseRequestContext };
      }) => Promise<{ text?: string; error?: string; code?: string; messageKey?: string }>;

      // Dictation key persistence (file-based for reliable startup)
      getDictationKey?: () => Promise<string | null>;
      getActiveDictationKey?: () => Promise<string>;
      getEffectiveDefaultHotkey?: () => Promise<string>;
      saveDictationKey?: (key: string) => Promise<void>;

      // Activation mode persistence (file-based for reliable startup)
      getActivationMode?: () => Promise<"tap" | "push">;
      saveActivationMode?: (mode: "tap" | "push") => Promise<void>;

      // Debug logging
      getLogLevel?: () => Promise<string>;
      getLogState?: () => Promise<LogState>;
      onLogSettingsChanged?: (callback: (state: LogState) => void) => () => void;
      log?: (entry: {
        level: string;
        message: string;
        meta?: any;
        scope?: string;
        source?: string;
      }) => Promise<void>;
      getLogInfo?: () => Promise<LogInfoResult>;
      setLogSettings?: (settings: LogSettingsUpdate) => Promise<LogInfoResult>;
      clearLogs?: () => Promise<ClearLogsResult>;
      getRecentLogProblems?: () => Promise<LogProblem[]>;
      openLogsFolder?: () => Promise<{ success: boolean; error?: string }>;

      // FFmpeg availability
      checkFFmpegAvailability: () => Promise<FFmpegAvailabilityResult>;
      getAudioDiagnostics: () => Promise<AudioDiagnosticsResult>;

      // System settings helpers
      requestMicrophoneAccess?: () => Promise<{ granted: boolean }>;
      checkMicrophoneAccess?: () => Promise<{ granted: boolean; status: string }>;
      getSystemDefaultMicrophone?: (options?: { refresh?: boolean }) => Promise<{
        name: string;
        nativeId?: string;
        platform: string;
        source: "system" | "unavailable";
      }>;
      checkSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      requestSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      openSystemAudioSettings?: () => Promise<{ success: boolean; error?: string }>;
      openScreenRecordingSettings?: () => Promise<{ success: boolean; error?: string }>;
      openLoginItemsSettings?: () => Promise<{ success: boolean; error?: string }>;
      checkScreenRecordingAccess?: () => Promise<ScreenRecordingAccessResult>;
      requestScreenRecordingAccess?: () => Promise<ScreenRecordingAccessResult>;
      captureScreenContext?: () => Promise<ScreenContextImage | null>;
      setScreenContextEnabled?: (enabled: boolean) => Promise<{ success: boolean }>;
      toggleMediaPlayback?: () => Promise<boolean>;
      pauseMediaPlayback?: () => Promise<boolean>;
      resumeMediaPlayback?: () => Promise<boolean>;
      getModelCacheRoot?: () => Promise<string>;
      openWhisperModelsFolder?: () => Promise<{ success: boolean; error?: string }>;

      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string) => void;
      registerMeetingHotkey?: (hotkey: string) => Promise<{ success: boolean; message?: string }>;
      registerReviewHotkey?: (hotkey: string) => Promise<{ success: boolean; message?: string }>;
      notifyFloatingIconAutoHideChanged?: (enabled: boolean) => void;
      onFloatingIconAutoHideChanged?: (callback: (enabled: boolean) => void) => () => void;
      notifyStartMinimizedChanged?: (enabled: boolean) => void;
      notifyPanelStartPositionChanged?: (position: string) => void;
      notifyFloatingIconDisplayChanged?: (display: string, label: string) => void;
      getDisplays?: () => Promise<FloatingIconDisplayInfo[]>;
      onDisplaysChanged?: (callback: (displays: FloatingIconDisplayInfo[]) => void) => () => void;
      previewFloatingIconPlacement?: () => Promise<{ success: boolean }>;
      onFloatingIconPlacementPreview?: (
        callback: (payload: { durationMs: number }) => void
      ) => () => void;
      notifyRecordingIndicatorChanged?: (settings: RecordingIndicatorSettings) => void;
      previewRecordingEdgeStrip?: (
        settings: RecordingIndicatorSettings
      ) => Promise<{ success: boolean }>;
      getMainWindowHorizontalDirection?: () => Promise<"left" | "right">;
      onMainWindowHorizontalDirectionChanged?: (
        callback: (direction: "left" | "right") => void
      ) => () => void;
      onMainWindowWillResize?: (
        callback: (resize: {
          bounds: Electron.Rectangle;
          anchor:
            "bottom-left" | "bottom-right" | "center" | "top-left" | "top-right" | "top-center";
        }) => void
      ) => () => void;

      // Auto-start at login. requiresApproval is macOS-only: SMAppService can
      // register the login item and still leave it awaiting approval in System
      // Settings, which otherwise looks like a toggle that will not stick.
      getAutoStartEnabled?: () => Promise<{ enabled: boolean; requiresApproval: boolean }>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      // Auth
      authClearSession?: () => Promise<{
        success: boolean;
        tokenState?: AuthTokenState;
        error?: string;
      }>;
      authGetToken?: () => Promise<string | null>;
      authGetTokenState?: () => Promise<AuthTokenState>;
      authSetToken?: (
        token: string,
        expectedGeneration: number
      ) => Promise<AuthTokenMutationResult>;
      onAuthTokenStateChanged?: (
        callback: (state: { generation: number; hasToken: boolean }) => void
      ) => () => void;

      // OpenWhispr account & Cloud switch (main owns it; see openWhisprCloudGate.js)
      openWhisprCloudDisabledAtLoad?: boolean;
      getOpenWhisprCloudDisabled?: () => Promise<boolean>;
      setOpenWhisprCloudDisabled?: (
        disabled: boolean
      ) => Promise<{ success: boolean; code?: string; disabled: boolean }>;
      onOpenWhisprCloudDisabledChanged?: (callback: (disabled: boolean) => void) => () => void;

      // OpenWhispr Cloud API
      cloudTranscribe?: (
        audioBuffer: ArrayBuffer,
        opts: {
          language?: string;
          prompt?: string;
          useCase?: string;
          diarization?: boolean;
          localDate?: string;
          analyticsOccurredAt?: string;
          // Why a managed-streaming user's dictation went batch (rollout metric).
          streamingFallbackReason?: string;
        } & SttDetectedLanguageFields
      ) => Promise<
        {
          success: boolean;
          text?: string;
          warning?: string;
          clientTranscriptionId?: string;
          wordsUsed?: number;
          wordsRemaining?: number;
          limitReached?: boolean;
        } & PolicyFailureMetadata
      >;
      cancelCloudTranscription?: () => void;
      /** Live dictation's OpenAI-compatible request, sent by main (deadline, one retry). */
      transcribeDictationRequest?: (
        request: DictationTranscriptionRequest
      ) => Promise<DictationTranscriptionReply>;
      cancelDictationTranscription?: (requestId: string) => void;
      cloudReason?: (
        text: string,
        opts: {
          model?: string;
          agentName?: string;
          customDictionary?: string[];
          customPrompt?: string;
          systemPrompt?: string;
          requestPurpose?: "agent";
          promptMode?: "cleanup" | "agent";
          purpose?: CloudReasonPurpose;
          screenContext?: ScreenContextImage;
          language?: string;
          locale?: string;
          streamingFallbackReason?: string;
        } & SttDetectedLanguageFields
      ) => Promise<{
        success: boolean;
        text?: string;
        model?: string;
        provider?: string;
        promptMode?: string;
        matchType?: string;
        screenContextApplied?: boolean;
        error?: string;
        code?: string;
      }>;
      cancelCloudReason?: () => void;
      cloudStreamingUsage?: (
        text: string,
        audioDurationSeconds: number,
        opts?: {
          sendLogs?: boolean;
          sttProvider?: string;
          sttModel?: string;
          sttProcessingMs?: number;
          sttLanguage?: string;
          audioSizeBytes?: number;
          audioFormat?: string;
          clientTotalMs?: number;
          clientTranscriptionId?: string;
          localDate?: string;
          analyticsOccurredAt?: string;
          analyticsWordCount?: number;
          analyticsCounterVersion?: number;
        } & SttDetectedLanguageFields
      ) => Promise<{
        success: boolean;
        wordsUsed?: number;
        wordsRemaining?: number;
        limitReached?: boolean;
        error?: string;
        code?: string;
      }>;
      cloudHealthCheck?: () => Promise<{
        ok: boolean;
        status?: number;
        code?: string;
        messageKey?: string;
      }>;
      cloudUsage?: () => Promise<
        UsageResponse & {
          success: boolean;
          error?: string;
          code?: string;
        }
      >;
      cloudCheckout?: (opts?: {
        plan?: "monthly" | "annual";
        tier?: "pro" | "business";
      }) => Promise<{
        success: boolean;
        url?: string;
        error?: string;
        code?: string;
      }>;
      cloudBillingPortal?: () => Promise<{
        success: boolean;
        url?: string;
        error?: string;
        code?: string;
      }>;
      cloudSwitchPlan?: (opts: {
        plan: "monthly" | "annual";
        tier: "pro" | "business";
      }) => Promise<{
        success: boolean;
        alreadyOnPlan?: boolean;
        error?: string;
      }>;
      cloudPreviewSwitch?: (opts: {
        plan: "monthly" | "annual";
        tier: "pro" | "business";
      }) => Promise<{
        success: boolean;
        immediateAmount?: number;
        currency?: string;
        currentPriceAmount?: number;
        currentInterval?: string;
        newPriceAmount?: number;
        newInterval?: string;
        nextBillingDate?: string;
        alreadyOnPlan?: boolean;
        error?: string;
      }>;

      // Authenticated cloud API proxy (`public: true` skips the auth requirement)
      cloudApiRequest?: (opts: {
        method?: string;
        path: string;
        body?: unknown;
        public?: boolean;
        expectedAuthGeneration?: number;
      }) => Promise<
        {
          success: boolean;
          data?: unknown;
        } & PolicyFailureMetadata
      >;

      // Cloud audio file transcription
      transcribeAudioFileCloud?: (
        filePath: string,
        options?: { requestId?: string }
      ) => Promise<
        {
          success: boolean;
          text?: string;
          warning?: string;
          failedChunks?: number;
          totalChunks?: number;
        } & PolicyFailureMetadata
      >;

      cancelUploadTranscription?: (requestId: string) => Promise<{ success: boolean }>;

      onUploadTranscriptionProgress?: (
        callback: (data: { stage: string; chunksTotal: number; chunksCompleted: number }) => void
      ) => () => void;

      // BYOK audio file transcription
      transcribeAudioFileByok?: (options: {
        filePath: string;
        apiKey: string;
        baseUrl: string;
        model: string;
        diarize?: boolean;
        timestamps?: boolean;
        provider?: string;
        language?: string;
        environment?: string;
        tenant?: string;
        transcriptionMode?: string;
        remoteTranscriptionUrl?: string;
        remoteTranscriptionModel?: string;
        /** Azure Speech's resource endpoint; main re-checks it before sending the key. */
        azureSpeechEndpoint?: string;
        managed?: {
          kind: "managed";
          provider: "azure";
          deployment: string;
          context: ManagedEnterpriseRequestContext;
        };
      }) => Promise<{
        success: boolean;
        text?: string;
        error?: string;
        diarized?: boolean;
        segments?: Array<{ text: string; start: number; end: number; speaker?: string }>;
      }>;

      // Usage limit events
      notifyLimitReached?: (data: { wordsUsed: number; limit: number }) => void;
      onLimitReached?: (
        callback: (data: { wordsUsed: number; limit: number }) => void
      ) => () => void;

      // Workspace invitation deep link
      onWorkspaceInvitationToken?: (callback: (token: string) => void) => () => void;
      getPendingInvitationToken?: () => Promise<string | null>;

      // AssemblyAI Streaming
      assemblyAiStreamingWarmup?: (options?: { sampleRate?: number; language?: string }) => Promise<
        {
          success: boolean;
          alreadyWarm?: boolean;
        } & PolicyFailureMetadata
      >;
      assemblyAiStreamingStart?: (options?: { sampleRate?: number; language?: string }) => Promise<
        {
          success: boolean;
          usedWarmConnection?: boolean;
        } & PolicyFailureMetadata
      >;
      assemblyAiStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      assemblyAiStreamingForceEndpoint?: () => void;
      assemblyAiStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        error?: string;
      }>;
      assemblyAiStreamingStatus?: () => Promise<{
        isConnected: boolean;
        sessionId: string | null;
      }>;
      onAssemblyAiPartialTranscript?: (callback: (text: string) => void) => () => void;
      onAssemblyAiFinalTranscript?: (callback: (text: string) => void) => () => void;
      onAssemblyAiError?: (callback: (error: string) => void) => () => void;
      onAssemblyAiSessionEnd?: (
        callback: (data: { audioDuration?: number; text?: string }) => void
      ) => () => void;

      // Referral stats
      getReferralStats?: () => Promise<{
        referralCode: string;
        referralLink: string;
        totalReferrals: number;
        completedReferrals: number;
        pendingReferrals: number;
        totalMonthsEarned: number;
        referrals: Array<{
          id: string;
          email: string;
          name: string;
          status: "pending" | "completed" | "rewarded";
          created_at: string;
          first_payment_at: string | null;
          words_used: number;
        }>;
      }>;

      sendReferralInvite?: (email: string) => Promise<{
        success: boolean;
        invite: {
          id: string;
          recipientEmail: string;
          status: "sent" | "failed" | "opened" | "converted";
          sentAt: string;
        };
      }>;

      getReferralInvites?: () => Promise<{
        invites: Array<{
          id: string;
          recipientEmail: string;
          status: "sent" | "failed" | "opened" | "converted";
          sentAt: string;
          openedAt?: string;
          convertedAt?: string;
        }>;
      }>;

      // Agent Mode
      updateVoiceAgentHotkey?: (hotkey: string) => Promise<{ success: boolean; message?: string }>;
      getVoiceAgentKey?: () => Promise<string>;
      updateTranslationHotkey?: (hotkey: string) => Promise<{ success: boolean; message?: string }>;
      getTranslationKey?: () => Promise<string>;
      // Style hotkeys (Stage 4): main owns the bindings; the style record mirrors them.
      getStyleHotkeys?: () => Promise<StyleHotkeyState>;
      setStyleHotkey?: (styleId: string, hotkey: string | null) => Promise<StyleHotkeyResult>;
      syncStyleHotkeyStyles?: (styleIds: string[]) => Promise<StyleHotkeyResult>;
      onStyleHotkeysChanged?: (callback: (state: StyleHotkeyState) => void) => () => void;
      createAgentConversation?: (
        title: string,
        noteId?: number | null,
        spaceId?: number | null,
        folderId?: number | null
      ) => Promise<{
        id: number;
        title: string;
        note_id?: number | null;
        space_id?: number | null;
        folder_id?: number | null;
        created_at: string;
        updated_at: string;
      } | null>;
      getConversationsForNote?: (
        noteId: number,
        limit?: number
      ) => Promise<
        Array<{
          id: number;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }>
      >;
      getConversationsForContainer?: (
        spaceId: number,
        folderId?: number | null,
        limit?: number
      ) => Promise<
        Array<{
          id: number;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }>
      >;
      getAgentConversations?: (limit?: number) => Promise<
        Array<{
          id: number;
          title: string;
          archived_at?: string;
          cloud_id?: string;
          client_conversation_id?: string;
          created_at: string;
          updated_at: string;
        }>
      >;
      getAgentConversation?: (id: number) => Promise<{
        id: number;
        title: string;
        archived_at?: string;
        cloud_id?: string | null;
        client_conversation_id?: string | null;
        created_at: string;
        updated_at: string;
        messages: Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>;
      } | null>;
      deleteAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationTitle?: (id: number, title: string) => Promise<{ success: boolean }>;
      addAgentMessage?: (
        conversationId: number,
        role: "user" | "assistant" | "system",
        content: string,
        metadata?: Record<string, unknown>
      ) => Promise<{
        id: number;
        conversation_id: number;
        role: string;
        content: string;
        metadata?: string;
        created_at: string;
      } | null>;
      getAgentMessages?: (conversationId: number) => Promise<
        Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>
      >;
      getAgentConversationsWithPreview?: (
        limit?: number,
        offset?: number,
        includeArchived?: boolean
      ) => Promise<ConversationPreview[]>;
      searchAgentConversations?: (query: string, limit?: number) => Promise<ConversationPreview[]>;
      archiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      unarchiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationCloudId?: (
        id: number,
        cloudId: string
      ) => Promise<{ success: boolean }>;
      semanticSearchConversations?: (
        query: string,
        limit?: number
      ) => Promise<ConversationPreview[]>;

      // Deepgram Streaming
      deepgramStreamingWarmup?: (options?: { sampleRate?: number; language?: string }) => Promise<{
        success: boolean;
        alreadyWarm?: boolean;
        error?: string;
        code?: string;
      }>;
      deepgramStreamingStart?: (options?: {
        sampleRate?: number;
        language?: string;
        forceNew?: boolean;
      }) => Promise<
        {
          success: boolean;
          usedWarmConnection?: boolean;
        } & PolicyFailureMetadata
      >;
      deepgramStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      deepgramStreamingFinalize?: () => void;
      deepgramStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        error?: string;
      }>;
      deepgramStreamingStatus?: () => Promise<{
        isConnected: boolean;
        sessionId: string | null;
      }>;
      onDeepgramPartialTranscript?: (callback: (text: string) => void) => () => void;
      onDeepgramFinalTranscript?: (callback: (text: string) => void) => () => void;
      onDeepgramError?: (callback: (error: string) => void) => () => void;
      onDeepgramSessionEnd?: (
        callback: (data: { audioDuration?: number; text?: string }) => void
      ) => () => void;

      // Gemini Live Streaming
      geminiStreamingWarmup?: (
        options?: DictationRealtimeSessionOptions
      ) => Promise<
        { success: boolean; alreadyWarm?: boolean; error?: string } & PolicyFailureMetadata
      >;
      geminiStreamingStart?: (
        options?: DictationRealtimeSessionOptions & { forceNew?: boolean }
      ) => Promise<
        { success: boolean; usedWarmConnection?: boolean; error?: string } & PolicyFailureMetadata
      >;
      geminiStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      geminiStreamingFinalize?: () => void;
      geminiStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        model?: string;
        audioBytesSent?: number;
        error?: string;
      }>;
      geminiStreamingStatus?: () => Promise<{ isConnected: boolean; isConnecting: boolean }>;
      onGeminiPartialTranscript?: (callback: (text: string) => void) => () => void;
      onGeminiFinalTranscript?: (callback: (text: string) => void) => () => void;
      onGeminiError?: (callback: (error: string) => void) => () => void;
      onGeminiSessionEnd?: (callback: (data: { text?: string }) => void) => () => void;

      // Corti streaming (BYOK)
      cortiStreamingWarmup?: (options?: {
        environment?: string;
        tenant?: string;
        language?: string;
        keyterms?: string[];
      }) => Promise<{ success: boolean } & PolicyFailureMetadata>;
      cortiStreamingStart?: (options?: {
        environment?: string;
        tenant?: string;
        language?: string;
        keyterms?: string[];
      }) => Promise<{ success: boolean } & PolicyFailureMetadata>;
      cortiStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      cortiStreamingFinalize?: () => void;
      cortiStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        model?: string;
        audioBytesSent?: number;
        error?: string;
      }>;
      cortiStreamingStatus?: () => Promise<{ isConnected: boolean; sessionId: string | null }>;
      onCortiPartialTranscript?: (callback: (text: string) => void) => () => void;
      onCortiFinalTranscript?: (callback: (text: string) => void) => () => void;
      onCortiError?: (callback: (error: string) => void) => () => void;
      onCortiSessionEnd?: (callback: (data: { text?: string }) => void) => () => void;

      // Agent cloud streaming (event-based)
      startAgentStream?: (
        requestId: string,
        messages: Array<{ role: string; content: string | Array<unknown> }>,
        opts?: {
          systemPrompt?: string;
          tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
          screenContext?: { data: string; mediaType: string };
          noteChat?: boolean;
        }
      ) => void;
      cancelAgentStream?: (requestId: string) => void;
      onAgentStreamChunk?: (
        callback: (payload: {
          requestId: string;
          chunk: {
            type: "content" | "tool_call" | "done";
            text?: string;
            id?: string;
            name?: string;
            arguments?: string;
            finishReason?: string;
          };
        }) => void
      ) => () => void;
      onAgentStreamError?: (
        callback: (payload: PolicyFailureMetadata & { requestId: string; error: string }) => void
      ) => () => void;
      onAgentStreamEnd?: (callback: (payload: { requestId: string }) => void) => () => void;

      // Agent cloud tools
      agentOpenNote?: (noteId: number) => Promise<{ success: boolean; error?: string }>;
      agentWebSearch?: (
        query: string,
        numResults?: number
      ) => Promise<
        {
          success: boolean;
          results?: Array<{
            title: string;
            url: string;
            text: string;
            publishedDate?: string;
          }>;
        } & PolicyFailureMetadata
      >;

      // Google Calendar
      gcalStartOAuth?: () => Promise<{ success: boolean; email?: string; error?: string }>;
      gcalDisconnect?: (email?: string) => Promise<{ success: boolean; error?: string }>;
      gcalGetConnectionStatus?: () => Promise<{
        connected: boolean;
        accounts: Array<{ email: string }>;
        email: string | null;
      }>;
      gcalGetCalendars?: () => Promise<{ success: boolean; calendars: any[] }>;
      gcalSetCalendarSelection?: (
        calendarId: string,
        isSelected: boolean
      ) => Promise<{ success: boolean; error?: string }>;
      gcalSetPrimaryOnly?: (value: boolean) => Promise<{ success: boolean; error?: string }>;
      gcalSyncEvents?: () => Promise<{ success: boolean; error?: string }>;
      gcalGetUpcomingEvents?: (
        windowMinutes?: number
      ) => Promise<{ success: boolean; events: any[] }>;
      connectorStatus?: () => Promise<ConnectorStatus[]>;
      connectorPrepare?: (
        connectorId: string,
        action: string,
        args: Record<string, unknown>
      ) => Promise<ConnectorPrepareResult>;
      /** Reads provider data for the model (an issue search); never writes. */
      connectorQuery?: (
        connectorId: string,
        action: string,
        args: Record<string, unknown>
      ) => Promise<ConnectorQueryResult>;
      connectorCommit?: (actionId: string, edits: ConnectorEdits) => Promise<ConnectorCommitResult>;
      /** Cancels a pending approval, or a direct run (by its runId) still waiting on policy. */
      connectorCancel?: (
        actionId: string,
        reason: ConnectorCancelReason
      ) => Promise<{ cancelled: boolean }>;
      connectorRunDirect?: (
        connectorId: string,
        action: string,
        args: Record<string, unknown>,
        runId?: string
      ) => Promise<ConnectorDirectResult>;
      connectorRecentActions?: (
        connectorId: string,
        limit?: number
      ) => Promise<ConnectorActionRecord[]>;
      connectorFindContacts?: (
        query: string
      ) => Promise<{ contacts: ContactMatch[]; hasMore?: boolean; unavailableReason?: string }>;
      /**
       * A note's participants, plus its calendar event's organizer, minus the
       * user and rooms (main applies find_contact's exclusions).
       */
      connectorNoteAttendees?: (
        request: NoteAttendeesRequest
      ) => Promise<{ attendees: NoteAttendee[]; unavailableReason?: string }>;
      connectorConnect?: (connectorId: string) => Promise<ConnectorConnectResult>;
      /**
       * Stops this connector's connect in progress, whichever account started it
       * (including one still waiting on policy); the connect ends as oauth_cancelled.
       */
      connectorCancelConnect?: (connectorId: string) => Promise<ConnectorCancelConnectResult>;
      connectorDisconnect?: (connectorId: string) => Promise<ConnectorDisconnectResult>;
      onConnectorStatusChanged?: (callback: (statuses: ConnectorStatus[]) => void) => () => void;
      onConnectorConnectProgress?: (
        callback: (progress: ConnectorConnectProgress) => void
      ) => () => void;
      calendarGetAvailability?: (
        request: CalendarAvailabilityRequest
      ) => Promise<
        | { success: true; availability: CalendarAvailabilityResult }
        | { success: false; error: string }
      >;
      gcalGetEvent?: (eventId: string) => Promise<{
        success: boolean;
        event: {
          id: string;
          summary: string | null;
          start_time: string;
          end_time: string;
          attendees_count: number;
          attendees: string | null;
        } | null;
      }>;

      // Contacts
      searchContacts: (query: string) => Promise<{
        success: boolean;
        contacts: Array<{ email: string; display_name: string | null }>;
      }>;
      upsertContact: (contact: {
        email: string;
        displayName?: string | null;
      }) => Promise<{ success: boolean }>;
      getMD5Hash: (text: string) => Promise<string>;

      // Meeting transcription (streaming, dual-channel)
      meetingTranscriptionPrepare?: (options: {
        provider?: string;
        model?: string;
        language?: string;
      }) => Promise<{ success: boolean; alreadyPrepared?: boolean } & PolicyFailureMetadata>;
      meetingTranscriptionStart?: (options: {
        provider?: string;
        model?: string;
        language?: string;
        noteId?: number | null;
        sessionId: string;
        autoEndEligible: boolean;
        aecEnabled?: boolean;
      }) => Promise<
        {
          success: boolean;
          sessionId?: string;
          error?: string;
          systemAudioMode?: SystemAudioMode;
          systemAudioStrategy?: SystemAudioStrategy;
          oneOnOneAttendee?: { displayName: string; email: string | null } | null;
        } & PolicyFailureMetadata
      >;
      meetingTranscriptionSend?: (buffer: ArrayBuffer, source: "mic" | "system") => void;
      meetingTranscriptionSetSystemAudioAvailable?: (
        sessionId: string,
        available: boolean
      ) => Promise<{ success: boolean; reason?: "stale-session" }>;
      meetingTranscriptionStop?: (expectedSessionId?: string) => Promise<{
        success: boolean;
        transcript?: string;
        diarizationSessionId?: string;
        error?: string;
        reason?: "stale-session";
      }>;
      meetingTranscriptionCancel?: () => Promise<{
        success: boolean;
        reason?: "recording-active";
      }>;
      onMeetingTranscriptionSegment?: (
        callback: (data: {
          text: string;
          source: "mic" | "system";
          type: "partial" | "final" | "retract";
          timestamp?: number;
        }) => void
      ) => () => void;
      onMeetingSpeakerIdentified?: (
        callback: (data: {
          speakerId: string;
          displayName?: string | null;
          startTime: number;
          endTime: number;
        }) => void
      ) => () => void;
      onMeetingSpeakersMerged?: (
        callback: (
          merges: Array<{
            keep: string;
            remove: string;
            displayName?: string | null;
            similarity: number;
          }>
        ) => void
      ) => () => void;
      onMeetingSessionSpeakerConfigUpdated?: (
        callback: (config: { enabled: boolean; expectedCount: number }) => void
      ) => () => void;
      onMeetingTranscriptionError?: (callback: (error: string) => void) => () => void;
      onMeetingTranscriptionFatalError?: (callback: (error: string) => void) => () => void;
      onMeetingSystemAudioSilent?: (
        callback: (data: { systemAudioStrategy: SystemAudioStrategy }) => void
      ) => () => void;
      onMeetingSystemAudioDegraded?: (callback: () => void) => () => void;
      onMeetingSystemAudioInterrupted?: (
        callback: (data: MeetingSystemAudioInterruption) => void
      ) => () => void;
      onMeetingSystemAudioResumed?: (callback: () => void) => () => void;

      // Speaker diarization
      downloadDiarizationModels?: () => Promise<{ success: boolean; error?: string }>;
      getDiarizationModelStatus?: () => Promise<{
        available: boolean;
        modelsDownloaded: boolean;
      }>;
      deleteDiarizationModels?: () => Promise<{ success: boolean }>;
      cancelDiarizationDownload?: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      mergeSpeakerText?: (
        segments: Array<{ start: number; end: number; speaker: string }>,
        text: string,
        duration: number
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      diarizeAudioFile?: (
        filePath: string,
        options?: { numSpeakers?: number; threshold?: number; requestId?: string }
      ) => Promise<{
        success: boolean;
        segments?: Array<{ start: number; end: number; speaker: string }>;
        durationSeconds?: number;
        error?: string;
        code?: string;
      }>;
      onDiarizationDownloadProgress?: (callback: (data: any) => void) => () => void;
      onMeetingDiarizationComplete?: (
        callback: (data: {
          sessionId?: string;
          noteId?: number | null;
          segments: Array<{
            id: string;
            text: string;
            source: "mic" | "system";
            timestamp?: number;
            speaker?: string;
            speakerName?: string;
            speakerIsPlaceholder?: boolean;
            suggestedName?: string;
            suggestedProfileId?: number;
            speakerStatus?: "provisional" | "confirmed" | "suggested" | "locked";
            speakerLocked?: boolean;
            speakerLockSource?: "user" | "diarization" | "suggestion";
          }>;
          speakerEmbeddings?: Record<string, number[]> | null;
        }) => void
      ) => () => void;

      // Speaker name mapping
      getSpeakerMappings?: (noteId: number) => Promise<
        Array<{
          note_id: number;
          speaker_id: string;
          profile_id: number | null;
          display_name: string;
        }>
      >;
      setSpeakerMapping?: (
        noteId: number,
        speakerId: string,
        displayName: string,
        email?: string | null,
        profileId?: number | null
      ) => Promise<{ success: boolean; profileId: number | null }>;
      removeSpeakerMapping?: (noteId: number, speakerId: string) => Promise<{ success: boolean }>;
      getSpeakerProfiles?: () => Promise<
        Array<{
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
          created_at: string;
          updated_at: string;
        }>
      >;
      attachSpeakerEmail?: (
        profileId: number,
        email: string | null
      ) => Promise<{
        success: boolean;
        error?: string;
        profile?: {
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
        };
      }>;
      saveNoteSpeakerEmbeddings?: (
        noteId: number,
        embeddings: Record<string, number[]>
      ) => Promise<{ success: boolean }>;

      // Dictation realtime streaming
      dictationRealtimeWarmup?: (
        options: DictationRealtimeSessionOptions
      ) => Promise<{ success: boolean } & PolicyFailureMetadata>;
      dictationRealtimeStart?: (
        options: DictationRealtimeSessionOptions
      ) => Promise<{ success: boolean } & PolicyFailureMetadata>;
      dictationRealtimeSend?: (buffer: ArrayBuffer) => void;
      dictationRealtimeFinalize?: () => Promise<
        {
          success: boolean;
          text?: string;
          error?: string;
        } & Partial<DictationLanguageMetadata>
      >;
      dictationRealtimeStop?: () => Promise<{ success: boolean; text: string }>;
      onDictationRealtimePartial?: (callback: (text: string) => void) => () => void;
      onDictationRealtimeFinal?: (callback: (text: string) => void) => () => void;
      onDictationRealtimeLanguage?: (
        callback: (metadata: DictationLanguageMetadata) => void
      ) => () => void;
      onDictationRealtimeError?: (callback: (error: string) => void) => () => void;
      onDictationRealtimeSessionEnd?: (callback: (data: { text: string }) => void) => () => void;

      // Google Calendar event listeners
      onGcalConnectionChanged?: (callback: (data: any) => void) => () => void;
      onGcalEventsSynced?: (callback: (data: any) => void) => () => void;

      // Microsoft Calendar
      mcalStartOAuth?: () => Promise<{
        success: boolean;
        email?: string;
        tenantId?: string | null;
        error?: string;
      }>;
      mcalDisconnect?: (email?: string) => Promise<{ success: boolean; error?: string }>;
      mcalGetConnectionStatus?: () => Promise<{
        connected: boolean;
        accounts: MicrosoftCalendarAccount[];
      }>;
      mcalSetPrimaryOnly?: (value: boolean) => Promise<{ success: boolean; error?: string }>;
      onMcalConnectionChanged?: (callback: (data: any) => void) => () => void;
      onMcalEventsSynced?: (callback: (data: any) => void) => () => void;

      // Apple Calendar (macOS EventKit)
      acalConnect?: () => Promise<{ success: boolean; reason?: string; error?: string }>;
      acalDisconnect?: () => Promise<{ success: boolean; error?: string }>;
      acalGetConnectionStatus?: () => Promise<{ connected: boolean; sourceNames: string[] }>;
      openCalendarPrivacySettings?: () => Promise<{ success: boolean; error?: string }>;
      onAcalConnectionChanged?: (
        callback: (data: { connected: boolean; sourceNames: string[] }) => void
      ) => () => void;
      onAcalEventsSynced?: (callback: (data: any) => void) => () => void;

      syncNotificationPreferences?: (prefs: {
        notificationsEnabled: boolean;
        notifyMeetingDetection: boolean;
        notifyCalendarReminders: boolean;
        meetingProcessDetection: boolean;
      }) => Promise<{ success: boolean }>;
      setSpeakerDiarizationEnabled?: (
        enabled: boolean
      ) => Promise<{ success: boolean; error?: string }>;
      setMeetingSessionSpeakerConfig?: (config: {
        enabled: boolean;
        expectedCount: number;
        countIsExplicit?: boolean;
      }) => Promise<{ success: boolean; error?: string }>;
      getWhisperVadConfig?: () => Promise<{
        success: boolean;
        config?: {
          dictationSileroEnabled: boolean;
          noteRecordingSileroEnabled: boolean;
          meetingSileroEnabled: boolean;
          threshold: number;
          minSpeechDurationMs: number;
          minSilenceDurationMs: number;
          maxSpeechDurationS: number;
          speechPadMs: number;
          samplesOverlap: number;
        };
        error?: string;
      }>;
      setWhisperVadConfig?: (config: {
        dictationSileroEnabled?: boolean;
        noteRecordingSileroEnabled?: boolean;
        meetingSileroEnabled?: boolean;
        threshold?: number;
        minSpeechDurationMs?: number;
        minSilenceDurationMs?: number;
        maxSpeechDurationS?: number;
        speechPadMs?: number;
        samplesOverlap?: number;
      }) => Promise<{ success: boolean; config?: Record<string, unknown>; error?: string }>;
      onMeetingNotificationData?: (callback: (data: MeetingNotificationData) => void) => () => void;
      onMeetingAutoEndRequested?: (
        callback: (request: MeetingAutoEndRequest) => void
      ) => () => void;
      getMeetingNotificationDestination: () => Promise<MeetingResult<MeetingDestinationContext>>;
      selectMeetingNotificationFolder: (
        folder: MeetingFolderRef
      ) => Promise<MeetingResult<MeetingDestinationContext>>;
      createMeetingNotificationFolder: (request: {
        requestId: string;
        name: string;
        spaceId: number;
      }) => Promise<MeetingResult<MeetingDestinationContext & { createdFolder: MeetingFolderRef }>>;
      onMeetingNotificationFolderCreated: (
        callback: (hint: { folderId: number }) => void
      ) => () => void;
      setMeetingNotificationSurface: (
        state: MeetingSurfaceState
      ) => Promise<MeetingResult<{ width: number; height: number; maxHeight: number }>>;
      onMeetingNotificationSurfaceClosed: (
        callback: (data: { revision: number }) => void
      ) => () => void;
      onMeetingNotificationSurfaceResized: (
        callback: (data: { revision: number }) => void
      ) => () => void;
      getMeetingNotificationData?: () => Promise<MeetingNotificationData | null>;
      meetingNotificationReady?: () => Promise<void>;
      meetingNotificationRespond?: (
        detectionId: string,
        action: string,
        options?: {
          existingNote?: Pick<MeetingExistingNote, "noteId" | "spaceId" | "folderId">;
        }
      ) => Promise<MeetingResult<null>>;
      confirmMeetingNoteNavigation: (
        navigationId: string,
        status?: "ready" | "cancel"
      ) => Promise<MeetingResult<NoteItem>>;
      joinCalendarMeeting?: (eventId: string) => Promise<{ success: boolean }>;
      startManualMeeting?: () => Promise<void>;
      getPendingMeetingNoteNavigation?: () => Promise<{
        navigationId?: string;
        spaceId?: number;
        noteId: number;
        folderId: number | null;
        event: any;
        trigger?: "hotkey" | "manual" | "calendar-join";
      } | null>;
      onMeetingNoteNavigationPending?: (callback: () => void) => () => void;
      getPendingNoteNavigation?: () => Promise<{
        noteId: number;
        folderId: number | null;
      } | null>;
      onNoteNavigationPending?: (callback: () => void) => () => void;
      onPreviewText?: (callback: (text: string) => void) => () => void;
      onPreviewAppend?: (callback: (text: string) => void) => () => void;
      onPreviewHold?: (callback: (payload: { showCleanup: boolean }) => void) => () => void;
      onPreviewResult?: (callback: (payload: { text: string }) => void) => () => void;
      onPreviewHide?: (callback: () => void) => () => void;
      startDictationPreview?: (opts: {
        provider: string;
        model: string;
        language?: string;
        display?: boolean;
      }) => Promise<{ success: boolean }>;
      stopDictationPreview?: (opts?: {
        showCleanup?: boolean;
        flushed?: boolean;
      }) => Promise<{ success: boolean; streamed?: boolean; text?: string }>;
      dismissDictationPreview?: () => Promise<{ success: boolean }>;
      updateDictationPreview?: (text: string) => Promise<{ success: boolean }>;
      completeDictationPreview?: (payload: { text?: string }) => Promise<{ success: boolean }>;
      hideDictationPreview?: () => Promise<{ success: boolean }>;
      sendDictationPreviewAudio?: (data: ArrayBuffer) => void;

      // Sync operations
      getPendingNotes?: (spaceKind?: "private" | "team") => Promise<NoteItem[]>;
      getPendingNoteDeletes?: () => Promise<NoteItem[]>;
      getNoteByClientId?: (clientNoteId: string) => Promise<NoteItem | null>;
      upsertNoteFromCloud?: (
        cloudNote: Record<string, unknown>,
        localFolderId: number | null,
        localSpaceId?: number | null
      ) => Promise<NoteItem>;
      acknowledgeNoteCreate?: (
        id: number,
        snapshot: NoteCreateSnapshot,
        cloudId: string,
        cloudUpdatedAt?: string | null,
        ownerUserId?: string | null,
        settleIfUnchanged?: boolean
      ) => Promise<NoteCreateAckResult>;
      markNoteSyncedIfUnchanged?: (
        id: number,
        snapshot: NoteUpdateSnapshot,
        expectedCloudId: string,
        cloudUpdatedAt?: string | null,
        ownerUserId?: string | null
      ) => Promise<NoteUpdateAckResult>;
      setNoteCloudBase?: (id: number, cloudUpdatedAt: string | null) => Promise<void>;
      setNoteOwnerFromCloud?: (id: number, ownerUserId: string) => Promise<void>;
      countTeamNotesMissingOwner?: () => Promise<number>;
      markNoteSyncError?: (id: number) => Promise<void>;
      restoreNoteAfterDeniedDelete?: (id: number) => Promise<{ success: boolean; id: number }>;
      hardDeleteNote?: (id: number) => Promise<void>;

      getPendingFolders?: (spaceKind?: "private" | "team") => Promise<FolderItem[]>;
      getFolderByClientId?: (clientFolderId: string) => Promise<FolderItem | null>;
      upsertFolderFromCloud?: (
        cloudFolder: Record<string, unknown>,
        localSpaceId?: number | null
      ) => Promise<FolderItem>;
      acknowledgeFolderCreate?: (
        id: number,
        snapshot: FolderPushSnapshot,
        expectedCloudId: string | null,
        responseClientFolderId: string,
        cloudId: string,
        cloudUpdatedAt?: string | null
      ) => Promise<FolderAckResult>;
      markFolderSyncedIfUnchanged?: (
        id: number,
        snapshot: FolderPushSnapshot,
        expectedCloudId: string
      ) => Promise<FolderAckResult>;
      getFolderIdMap?: () => Promise<FolderItem[]>;
      getPendingFolderDeletes?: () => Promise<FolderItem[]>;
      restoreFolderAfterDeniedDelete?: (id: number) => Promise<{
        success: boolean;
        id: number;
        folder?: FolderItem;
        notes?: NoteItem[];
        conversationIds?: number[];
        reason?: "name-taken";
        error?: string;
      }>;
      hardDeleteFolder?: (id: number) => Promise<{ success: boolean; id: number }>;
      relocateRevokedFolder?: (
        id: number,
        privateSpaceId: number,
        preserveFolder?: boolean
      ) => Promise<{
        success: boolean;
        folder?: FolderItem | null;
        folderName?: string;
        relocatedNotes?: NoteItem[];
        deletedNoteIds?: number[];
        error?: string;
      }>;

      getPendingConversations?: () => Promise<ConversationPreview[]>;
      getPendingConversationDeletes?: () => Promise<ConversationPreview[]>;
      getConversationByClientId?: (clientId: string) => Promise<ConversationPreview | null>;
      upsertConversationFromCloud?: (
        cloudConv: Record<string, unknown>,
        messages: Array<Record<string, unknown>>
      ) => Promise<void>;
      acknowledgeConversationCreate?: (
        id: number,
        snapshot: ConversationCreateSnapshot,
        cloudId: string
      ) => Promise<ConversationCreateAckResult | undefined>;
      markConversationSynced?: (
        id: number,
        cloudId: string
      ) => Promise<{ success: boolean } | undefined>;
      hardDeleteConversation?: (id: number) => Promise<void>;

      getPendingTranscriptions?: () => Promise<TranscriptionItem[]>;
      getTranscriptionByClientId?: (clientId: string) => Promise<TranscriptionItem | null>;
      upsertTranscriptionFromCloud?: (
        cloudTranscription: Record<string, unknown>
      ) => Promise<TranscriptionItem>;
      markTranscriptionSynced?: (id: number, cloudId: string) => Promise<void>;
      getPendingTranscriptionDeletes?: () => Promise<TranscriptionItem[]>;
      hardDeleteTranscription?: (id: number) => Promise<{ success: boolean; id: number }>;

      getPendingDictionary?: () => Promise<DictionaryEntryItem[]>;
      getPendingDictionaryDeletes?: () => Promise<DictionaryEntryItem[]>;
      getDictionaryByClientId?: (clientDictId: string) => Promise<DictionaryEntryItem | null>;
      upsertDictionaryFromCloud?: (
        cloudEntry: Record<string, unknown>
      ) => Promise<DictionaryEntryItem | null>;
      markDictionarySynced?: (
        id: number,
        cloudId: string
      ) => Promise<{ success: boolean; changes: number }>;
      hardDeleteDictionary?: (id: number) => Promise<{ success: boolean; id: number }>;
      clearDictionaryCloudId?: (id: number) => Promise<{ success: boolean }>;
      broadcastDictionaryUpdated?: () => Promise<{ success: boolean }>;

      getPendingSnippets?: () => Promise<SnippetEntryItem[]>;
      getPendingSnippetDeletes?: () => Promise<SnippetEntryItem[]>;
      getSnippetForCloudMerge?: (
        cloudEntry: Record<string, unknown>
      ) => Promise<SnippetEntryItem | null>;
      upsertSnippetFromCloud?: (
        cloudEntry: Record<string, unknown>
      ) => Promise<SnippetEntryItem | null>;
      markSnippetSynced?: (
        id: number,
        cloudId: string,
        serverUpdatedAt?: string,
        expectedTrigger?: string,
        expectedReplacement?: string
      ) => Promise<{ success: boolean; changes: number }>;
      hardDeleteSnippet?: (id: number) => Promise<{ success: boolean; id: number }>;
      clearSnippetCloudId?: (id: number) => Promise<{ success: boolean }>;
      broadcastSnippetsUpdated?: () => Promise<{ success: boolean }>;
    };

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}

import type {
  SearchLlmScope,
  SettingAvailability,
  SettingDescriptor,
  SettingsLocation,
  SettingsSearchContext,
  SettingsSearchToggles,
  SettingsSearchValueKey,
} from "./types";
import type { SettingsSectionType } from "../../SettingsPage";
import type { Platform } from "../../../utils/platform";

/**
 * Settings search: one descriptor per setting row or block, plus the Settings
 * pages and two app pages outside Settings. Each setting row carries a
 * matching `data-setting-id` in the markup (test/components/settingsSearchRegistry
 * fails otherwise). Locations are data, so moving a setting only moves its entry.
 */

type Rule = (ctx: SettingsSearchContext) => SettingAvailability;

const R = {
  hiddenWhileOff: "settingsSearch.reasons.hiddenWhileOff",
  requiresSetting: "settingsSearch.reasons.requiresSetting",
  signIn: "settingsSearch.reasons.signIn",
  managedByOrg: "common.managedByOrg",
  macOnly: "settingsSearch.reasons.macOnly",
  waylandOnly: "settingsSearch.reasons.waylandOnly",
  multiGpu: "settingsSearch.reasons.multiGpu",
  autoLanguageOnly: "settingsSearch.reasons.autoLanguageOnly",
  localWhisperOnly: "settingsSearch.reasons.localWhisperOnly",
  localModelOnly: "settingsSearch.reasons.localModelOnly",
  streamingOnly: "settingsSearch.reasons.streamingOnly",
  managerOnly: "settingsSearch.reasons.managerOnly",
} as const;

/** Reason keys a descriptor may return, for the locale check. */
export const SETTINGS_SEARCH_REASON_KEYS: readonly string[] = Object.values(R);

const all =
  (...rules: Rule[]): Rule =>
  (ctx) => {
    for (const rule of rules) {
      const result = rule(ctx);
      if (result !== true) return result;
    }
    return true;
  };

const cloudOn: Rule = (ctx) =>
  ctx.cloudDisabled ? { reason: R.hiddenWhileOff, prerequisite: "privacy.cloud" } : true;
const signedIn: Rule = all(cloudOn, (ctx) =>
  ctx.isSignedIn ? true : { reason: R.signIn, prerequisite: "account.signIn" }
);
const agentAllowed: Rule = (ctx) => (ctx.agentAllowed ? true : { reason: R.managedByOrg });
const requires =
  (flag: keyof SettingsSearchToggles, prerequisite: string, reason: string = R.requiresSetting) =>
  (ctx: SettingsSearchContext): SettingAvailability =>
    ctx.on[flag] ? true : { reason, prerequisite };
const onPlatform =
  (platform: Platform, reason: string): Rule =>
  (ctx) =>
    ctx.platform === platform ? true : { reason };
const localModel =
  (scope: SearchLlmScope, prerequisite: string): Rule =>
  (ctx) =>
    ctx.localLlm[scope] ? true : { reason: R.localModelOnly, prerequisite };
const multiGpu: Rule = (ctx) => ((ctx.gpuCount ?? 0) >= 2 ? true : { reason: R.multiGpu });

// Builders keep the list readable: `row` is a setting anchored at its own id.
const at = (section: SettingsSectionType, subTab?: string): SettingsLocation =>
  subTab ? { section, subTab } : { section };

type RowOptions = Omit<SettingDescriptor, "id" | "kind" | "location" | "titleKey">;

function row(
  id: string,
  location: SettingsLocation,
  titleKey: string,
  options: RowOptions = {}
): SettingDescriptor {
  return { id, kind: "setting", location, titleKey, anchor: id, ...options };
}

function page(
  id: string,
  location: SettingsLocation,
  titleKey: string,
  options: Omit<RowOptions, "anchor" | "fallbackAnchor" | "reveal" | "value"> = {}
): SettingDescriptor {
  return { id, kind: "page", location, titleKey, ...options };
}

/** The model editor of an LLM scope and the two toggles under it (derived anchors). */
function llmEditor(
  base: string,
  location: SettingsLocation,
  scope: SearchLlmScope,
  titleKey: string,
  available: Rule,
  aliases: readonly string[]
): SettingDescriptor[] {
  return [
    row(base, location, titleKey, {
      descriptionKey: "settingsSearch.descriptions.model",
      value: `llm.${scope}` as SettingsSearchValueKey,
      aliases: [
        "model",
        "llm",
        "ai model",
        "provider",
        "api key",
        "byok",
        "openai",
        "anthropic",
        "claude",
        "gemini",
        "groq",
        "openrouter",
        "copilot",
        "local model",
        "llama",
        "qwen",
        "ollama",
        "lm studio",
        "self-hosted",
        "enterprise",
        "bedrock",
        "azure",
        "vertex",
        ...aliases,
      ],
      available,
    }),
    row(`${base}.thinking`, location, "reasoning.disableThinking.label", {
      descriptionKey: "reasoning.disableThinking.help",
      anchor: `${base}.thinking`,
      fallbackAnchor: base,
      aliases: ["thinking", "reasoning", "think tokens", "chain of thought"],
      available,
    }),
    row(`${base}.keepLoaded`, location, "reasoning.keepModelLoaded.label", {
      descriptionKey: "reasoning.keepModelLoaded.help",
      anchor: `${base}.keepLoaded`,
      fallbackAnchor: base,
      aliases: ["cold start", "memory", "unload", "warm"],
      available: all(available, localModel(scope, base)),
    }),
  ];
}

const PREFS = at("general");
const HOTKEYS = at("hotkeys");
const STT_DICTATION = at("speechToText", "dictation");
const STT_NOTES = at("speechToText", "noteRecording");
const STT_UPLOAD = at("speechToText", "upload");
const CLEANUP = at("llms", "dictationCleanup");
const ASSISTANT = at("llms", "dictationAgent");
const TRANSLATION = at("llms", "dictationTranslation");
const NOTE_FORMATTING = at("llms", "noteFormatting");
const CHAT = at("llms", "chatIntelligence");
const PRIVACY = at("privacyData");
const SYSTEM = at("system");

const FLOATING_ICON = "settingsPage.general.floatingIcon.title";
const VAD_GROUP = "settingsPage.transcription.vad.title";
const assistantOn = all(agentAllowed, requires("assistant", "assistant.enabled"));
const screenContextOn = all(
  assistantOn,
  (ctx) => (ctx.screenContextAllowed ? true : { reason: R.managedByOrg }),
  requires("screenContext", "assistant.screenContext")
);
const translationOn = requires("translation", "translation.enabled");
const cleanupOn = requires("cleanup", "dictation.cleanup.enabled");
const vadAvailable = requires("localWhisper", "dictation.stt.engine", R.localWhisperOnly);

const VAD_FIELDS = [
  ["threshold", ["threshold", "sensitivity"]],
  ["minSpeechDurationMs", ["min speech", "minimum speech"]],
  ["minSilenceDurationMs", ["min silence", "minimum silence", "pause"]],
  ["maxSpeechDurationS", ["max speech", "maximum speech"]],
  ["speechPadMs", ["speech pad", "padding"]],
  ["samplesOverlap", ["overlap", "samples overlap"]],
] as const;

export const SETTINGS_SEARCH_DESCRIPTORS: readonly SettingDescriptor[] = [
  // ── Account ──────────────────────────────────────────────────────────────
  page("page.account", at("account"), "settingsModal.sections.account.label", {
    descriptionKey: "settingsModal.sections.account.description",
    aliases: ["account", "profile", "sign in", "login", "email"],
    available: cloudOn,
  }),
  row("account.name", at("account"), "settingsPage.account.profile.name.label", {
    fallbackAnchor: "account",
    aliases: ["display name", "profile", "username"],
    available: signedIn,
  }),
  row("account.password", at("account"), "settingsPage.account.profile.password.label", {
    descriptionKey: "settingsPage.account.profile.password.description",
    fallbackAnchor: "account",
    aliases: ["change password", "credentials"],
    available: signedIn,
  }),
  row("account.signOut", at("account"), "settingsPage.account.signOut.signOut", {
    fallbackAnchor: "account",
    aliases: ["log out", "logout", "sign out"],
    available: signedIn,
  }),
  row("account.delete", at("account"), "settingsPage.account.deleteAccount.label", {
    descriptionKey: "settingsPage.account.deleteAccount.labelDescription",
    fallbackAnchor: "account",
    aliases: ["remove account", "close account", "gdpr"],
    available: signedIn,
  }),
  row("account.signIn", at("account"), "settingsPage.account.trialCta.button", {
    descriptionKey: "settingsPage.account.trialCta.description",
    fallbackAnchor: "account",
    aliases: ["sign in", "log in", "login", "create account", "sign up", "trial"],
    available: (ctx) => (ctx.isSignedIn ? null : cloudOn(ctx)),
  }),

  // ── Plans & Billing ──────────────────────────────────────────────────────
  page("page.plansBilling", at("plansBilling"), "settingsModal.sections.plansBilling.label", {
    descriptionKey: "settingsModal.sections.plansBilling.description",
    aliases: ["billing", "subscription", "plan", "invoice", "payment"],
    available: cloudOn,
  }),
  row("plans.personal", at("plansBilling"), "settingsPage.unifiedBilling.personalPlanTitle", {
    fallbackAnchor: "plansBilling",
    aliases: ["my plan", "usage", "words", "subscription", "billing portal", "invoice"],
    available: signedIn,
  }),
  row("plans.pricing", at("plansBilling"), "settingsPage.account.pricing.title", {
    fallbackAnchor: "plansBilling",
    aliases: ["upgrade", "pro", "business", "enterprise", "pricing", "price", "trial"],
    available: cloudOn,
  }),

  // ── Workspace ────────────────────────────────────────────────────────────
  page("page.workspace", at("workspace"), "settingsModal.sections.workspace.label", {
    descriptionKey: "settingsModal.sections.workspace.description",
    aliases: ["team", "organization", "org", "company"],
    available: signedIn,
  }),
  ...(["members", "teams", "general", "developer"] as const).map((tab) =>
    row(`workspace.${tab}`, at("workspace", tab), `settingsPage.workspace.tab.${tab}`, {
      anchor: "workspace.tabs",
      fallbackAnchor: "workspace",
      aliases:
        tab === "members"
          ? ["invite", "teammates", "users", "people", "seats"]
          : tab === "teams"
            ? ["team spaces", "shared notes", "groups"]
            : tab === "developer"
              ? ["api keys", "developer", "tokens"]
              : ["workspace name", "rename workspace", "leave workspace", "delete workspace"],
      available:
        tab === "developer"
          ? all(signedIn, (ctx) => (ctx.canManageWorkspace ? true : { reason: R.managerOnly }))
          : signedIn,
    })
  ),

  // ── Preferences ──────────────────────────────────────────────────────────
  page("page.general", PREFS, "settingsModal.sections.general.label", {
    descriptionKey: "settingsModal.sections.general.description",
    aliases: ["preferences", "general", "options"],
  }),
  row("preferences.theme", PREFS, "settingsPage.general.appearance.theme", {
    descriptionKey: "settingsPage.general.appearance.themeDescription",
    groupKey: "settingsPage.general.appearance.title",
    aliases: ["dark mode", "light mode", "night mode", "appearance", "color scheme", "theme"],
    aliasKeys: ["settingsSearch.aliases.darkMode"],
    value: "theme",
  }),
  row("preferences.sounds.dictation", PREFS, "settingsPage.general.soundEffects.dictationSounds", {
    descriptionKey: "settingsPage.general.soundEffects.dictationSoundsDescription",
    groupKey: "settingsPage.general.soundEffects.title",
    aliases: ["sound", "audio cues", "beep", "chime", "sound effects"],
  }),
  row("preferences.sounds.pauseMedia", PREFS, "settingsPage.general.soundEffects.pauseMedia", {
    descriptionKey: "settingsPage.general.soundEffects.pauseMediaDescription",
    groupKey: "settingsPage.general.soundEffects.title",
    aliases: ["pause music", "spotify", "media", "mute"],
  }),
  row("preferences.notifications", PREFS, "settingsPage.general.notifications.title", {
    descriptionKey: "settingsPage.general.notifications.description",
    aliases: ["notifications", "alerts", "toasts", "popups"],
  }),
  row(
    "preferences.notifications.disableAll",
    PREFS,
    "settingsPage.general.notifications.disableAll",
    {
      descriptionKey: "settingsPage.general.notifications.disableAllDescription",
      groupKey: "settingsPage.general.notifications.title",
      aliases: ["do not disturb", "mute notifications", "silence"],
    }
  ),
  row(
    "preferences.notifications.meetingDetection",
    PREFS,
    "settingsPage.general.notifications.meetingDetection",
    {
      descriptionKey: "settingsPage.general.notifications.meetingDetectionDescription",
      groupKey: "settingsPage.general.notifications.title",
      aliases: ["meeting detected", "zoom", "teams", "google meet"],
    }
  ),
  row(
    "preferences.notifications.calendarReminders",
    PREFS,
    "settingsPage.general.notifications.calendarReminders",
    {
      descriptionKey: "settingsPage.general.notifications.calendarRemindersDescription",
      groupKey: "settingsPage.general.notifications.title",
      aliases: ["calendar", "reminder", "upcoming meeting"],
    }
  ),
  row("dictation.output.autoPaste", PREFS, "settingsPage.general.clipboard.autoPaste", {
    descriptionKey: "settingsPage.general.clipboard.autoPasteDescription",
    groupKey: "settingsPage.general.clipboard.title",
    aliases: ["paste", "insert text", "type text", "clipboard", "output"],
  }),
  row("dictation.output.keepInClipboard", PREFS, "settingsPage.general.clipboard.keepInClipboard", {
    descriptionKey: "settingsPage.general.clipboard.keepInClipboardDescription",
    groupKey: "settingsPage.general.clipboard.title",
    aliases: ["clipboard", "copy", "restore clipboard"],
  }),
  row("notes.files.enabled", PREFS, "settings.noteFiles.title", {
    descriptionKey: "settings.noteFiles.description",
    aliases: ["markdown", "obsidian", "export notes", "files", "folder", "sync folder"],
  }),
  row("notes.files.path", PREFS, "settings.noteFiles.path", {
    groupKey: "settings.noteFiles.title",
    aliases: ["notes folder", "location", "directory"],
    available: requires("noteFiles", "notes.files.enabled"),
  }),
  row("notes.files.rebuild", PREFS, "settings.noteFiles.rebuild", {
    descriptionKey: "settings.noteFiles.rebuildDescription",
    groupKey: "settings.noteFiles.title",
    aliases: ["regenerate files", "reexport"],
    available: requires("noteFiles", "notes.files.enabled"),
  }),
  row("notes.import.granola", PREFS, "settings.granolaImport.title", {
    descriptionKey: "settings.granolaImport.description",
    aliases: ["import", "granola", "csv", "migrate notes"],
  }),
  row("preferences.floatingIcon", PREFS, FLOATING_ICON, {
    descriptionKey: "settingsPage.general.floatingIcon.description",
    aliases: ["pill", "overlay", "bubble", "widget", "floating button", "indicator"],
  }),
  row("preferences.floatingIcon.autoHide", PREFS, "settingsPage.general.floatingIcon.autoHide", {
    descriptionKey: "settingsPage.general.floatingIcon.autoHideDescription",
    groupKey: FLOATING_ICON,
    aliases: ["hide pill", "hide overlay"],
  }),
  row("preferences.floatingIcon.display", PREFS, "settingsPage.general.floatingIcon.display", {
    descriptionKey: "settingsPage.general.floatingIcon.displayDescription",
    groupKey: FLOATING_ICON,
    aliases: ["monitor", "screen", "display", "multi monitor"],
  }),
  row(
    "preferences.floatingIcon.startPosition",
    PREFS,
    "settingsPage.general.floatingIcon.startPosition",
    {
      descriptionKey: "settingsPage.general.floatingIcon.startPositionDescription",
      groupKey: FLOATING_ICON,
      aliases: ["position", "corner", "placement", "where"],
    }
  ),
  row("preferences.recording.style", PREFS, "settingsPage.general.floatingIcon.recordingStyle", {
    groupKey: FLOATING_ICON,
    aliases: ["recording indicator", "rec", "waveform", "orb"],
  }),
  row(
    "preferences.recording.elapsed",
    PREFS,
    "settingsPage.general.floatingIcon.recordingShowElapsed",
    {
      descriptionKey: "settingsPage.general.floatingIcon.recordingShowElapsedDescription",
      groupKey: FLOATING_ICON,
      aliases: ["timer", "elapsed time", "duration"],
    }
  ),
  row("preferences.recording.color", PREFS, "settingsPage.general.floatingIcon.recordingColor", {
    descriptionKey: "settingsPage.general.floatingIcon.recordingColorDescription",
    groupKey: FLOATING_ICON,
    aliases: ["color", "colour", "accent"],
  }),
  row(
    "preferences.recording.colorByMode",
    PREFS,
    "settingsPage.general.floatingIcon.recordingColorByMode",
    {
      descriptionKey: "settingsPage.general.floatingIcon.recordingColorByModeDescription",
      groupKey: FLOATING_ICON,
      aliases: ["color", "colour", "mode color"],
    }
  ),
  row(
    "preferences.recording.assistantColor",
    PREFS,
    "settingsPage.general.floatingIcon.recordingAssistantColor",
    {
      groupKey: FLOATING_ICON,
      aliases: ["color", "colour"],
      available: requires("colorByMode", "preferences.recording.colorByMode"),
    }
  ),
  row(
    "preferences.recording.translationColor",
    PREFS,
    "settingsPage.general.floatingIcon.recordingTranslationColor",
    {
      groupKey: FLOATING_ICON,
      aliases: ["color", "colour"],
      available: requires("colorByMode", "preferences.recording.colorByMode"),
    }
  ),
  row("preferences.recording.edgeStrip", PREFS, "settingsPage.general.floatingIcon.edgeStrip", {
    descriptionKey: "settingsPage.general.floatingIcon.edgeStripDescription",
    groupKey: FLOATING_ICON,
    aliases: ["border", "frame", "screen edge", "glow"],
  }),
  row("preferences.recording.tray", PREFS, "settingsPage.general.floatingIcon.recordingTray", {
    descriptionKey: "settingsPage.general.floatingIcon.recordingTrayDescription",
    groupKey: FLOATING_ICON,
    aliases: ["tray icon", "system tray", "menu bar"],
  }),
  row(
    "preferences.recording.reminder",
    PREFS,
    "settingsPage.general.floatingIcon.recordingReminder",
    {
      descriptionKey: "settingsPage.general.floatingIcon.recordingReminderDescription",
      groupKey: FLOATING_ICON,
      aliases: ["still recording", "reminder", "forgot"],
    }
  ),
  row("preferences.uiLanguage", PREFS, "settings.language.uiLabel", {
    descriptionKey: "settings.language.uiDescription",
    groupKey: "settings.language.sectionTitle",
    aliases: ["language", "interface language", "display language", "locale", "translation"],
    value: "uiLanguage",
  }),
  row("dictation.language", PREFS, "settings.language.transcriptionLabel", {
    descriptionKey: "settings.language.transcriptionDescription",
    groupKey: "settings.language.sectionTitle",
    aliases: ["spoken language", "dictation language", "language", "auto detect"],
    value: "transcriptionLanguage",
  }),
  row("dictation.language.chineseScript", PREFS, "settings.language.chineseScriptLabel", {
    descriptionKey: "settings.language.chineseScriptDescription",
    groupKey: "settings.language.sectionTitle",
    aliases: ["simplified", "traditional", "chinese", "mandarin"],
    available: requires("autoLanguage", "dictation.language", R.autoLanguageOnly),
  }),
  row("preferences.startup.launchAtLogin", PREFS, "settingsPage.general.startup.launchAtLogin", {
    descriptionKey: "settingsPage.general.startup.launchAtLoginDescription",
    groupKey: "settingsPage.general.startup.title",
    aliases: ["autostart", "auto start", "start with windows", "login item", "boot", "startup"],
    aliasKeys: ["settingsSearch.aliases.autostart"],
  }),
  row("preferences.startup.startMinimized", PREFS, "settingsPage.general.startup.startMinimized", {
    descriptionKey: "settingsPage.general.startup.startMinimizedDescription",
    groupKey: "settingsPage.general.startup.title",
    aliases: ["tray", "background", "hidden", "minimized"],
  }),
  row("preferences.microphone", PREFS, "settingsPage.general.microphone.title", {
    descriptionKey: "settingsPage.general.microphone.description",
    aliases: ["mic", "microphone", "input device", "headset", "audio input"],
  }),
  row("preferences.microphone.device", PREFS, "microphoneSettings.inputDevice", {
    descriptionKey: "microphoneSettings.helpText",
    groupKey: "settingsPage.general.microphone.title",
    aliases: ["mic", "input device", "headset", "built-in microphone", "usb mic"],
  }),
  row("preferences.microphone.warmHold", PREFS, "microphoneSettings.warmHold.label", {
    descriptionKey: "microphoneSettings.warmHold.description",
    groupKey: "settingsPage.general.microphone.title",
    aliases: ["keep microphone open", "latency", "warm", "mic delay"],
  }),
  row("dictation.output.autoLearn", PREFS, "settingsPage.dictionary.autoLearnTitle", {
    descriptionKey: "settingsPage.dictionary.autoLearnDescription",
    aliases: ["dictionary", "corrections", "learn words", "vocabulary"],
  }),
  row("dictation.output.waylandPaste", PREFS, "settingsPage.general.waylandPaste.title", {
    descriptionKey: "settingsPage.general.waylandPaste.description",
    aliases: ["ydotool", "wtype", "paste", "linux", "wayland", "xclip"],
    available: (ctx) =>
      ctx.platform === "linux" && ctx.isWayland !== false ? true : { reason: R.waylandOnly },
  }),

  // ── Hotkeys ──────────────────────────────────────────────────────────────
  page("page.hotkeys", HOTKEYS, "settingsModal.sections.hotkeys.label", {
    descriptionKey: "settingsModal.sections.hotkeys.description",
    aliases: ["shortcuts", "keyboard", "keybindings", "hotkeys"],
    aliasKeys: ["settingsSearch.aliases.shortcut"],
  }),
  row("hotkeys.dictation", HOTKEYS, "settingsPage.general.hotkey.title", {
    descriptionKey: "settingsPage.general.hotkey.description",
    aliases: ["shortcut", "keybinding", "hotkey", "trigger", "key", "globe", "fn"],
    aliasKeys: ["settingsSearch.aliases.shortcut"],
    value: "hotkey.dictation",
  }),
  row("hotkeys.activationMode", HOTKEYS, "settingsPage.general.hotkey.activationMode", {
    fallbackAnchor: "hotkeys.dictation",
    groupKey: "settingsPage.general.hotkey.title",
    aliases: ["push to talk", "ptt", "hold to talk", "walkie talkie", "toggle", "tap", "hold"],
    aliasKeys: ["settingsSearch.aliases.pushToTalk", "common.tap", "common.hold"],
    value: "activationMode",
  }),
  row("hotkeys.assistant", HOTKEYS, "settingsPage.general.voiceAgentHotkey.title", {
    descriptionKey: "settingsPage.general.voiceAgentHotkey.description",
    aliases: ["shortcut", "hotkey", "voice agent", "assistant", "agent"],
    aliasKeys: ["settingsSearch.aliases.shortcut"],
    value: "hotkey.assistant",
    available: agentAllowed,
  }),
  row("hotkeys.translation", HOTKEYS, "settingsPage.general.translationHotkey.title", {
    descriptionKey: "settingsPage.general.translationHotkey.description",
    aliases: ["shortcut", "hotkey", "translate"],
    aliasKeys: ["settingsSearch.aliases.shortcut"],
    value: "hotkey.translation",
  }),
  row("hotkeys.meeting", HOTKEYS, "settingsPage.general.meetingHotkey.title", {
    descriptionKey: "settingsPage.general.meetingHotkey.description",
    aliases: ["shortcut", "hotkey", "meeting", "record meeting", "note recording"],
    aliasKeys: ["settingsSearch.aliases.shortcut"],
    value: "hotkey.meeting",
  }),
  row("hotkeys.meetingLayout", HOTKEYS, "settingsPage.general.meetingHotkey.layoutLabel", {
    groupKey: "settingsPage.general.meetingHotkey.title",
    aliases: ["side panel", "full width", "layout", "window"],
  }),
  row("hotkeys.styles", HOTKEYS, "settingsPage.general.styleHotkeys.title", {
    descriptionKey: "settingsPage.general.styleHotkeys.description",
    aliases: ["shortcut", "hotkey", "style", "per style"],
    aliasKeys: ["settingsSearch.aliases.shortcut"],
    value: "hotkey.styles",
  }),

  // ── Speech-to-Text ───────────────────────────────────────────────────────
  page("page.speechToText", at("speechToText"), "settingsModal.sections.speechToText.label", {
    descriptionKey: "settingsModal.sections.speechToText.description",
    aliases: ["stt", "transcription", "asr", "speech recognition"],
  }),
  page("page.speechToText.dictation", STT_DICTATION, "settingsPage.speechToText.tabs.dictation", {
    aliases: ["dictation", "stt"],
  }),
  page(
    "page.speechToText.noteRecording",
    STT_NOTES,
    "settingsPage.speechToText.tabs.noteRecording",
    { aliases: ["meeting", "note recording", "stt"] }
  ),
  page("page.speechToText.upload", STT_UPLOAD, "settingsPage.speechToText.tabs.upload", {
    aliases: ["upload", "audio file", "file transcription", "stt"],
  }),
  row("dictation.stt.engine", STT_DICTATION, "settingsSearch.titles.dictationEngine", {
    descriptionKey: "settingsSearch.descriptions.engine",
    value: "stt.dictation",
    aliases: [
      "speech to text",
      "stt",
      "transcription",
      "engine",
      "model",
      "whisper",
      "parakeet",
      "cohere",
      "local model",
      "openai",
      "groq",
      "deepgram",
      "assemblyai",
      "elevenlabs",
      "mistral",
      "api key",
      "self-hosted",
      "enterprise",
    ],
  }),
  row("dictation.stt.preview", STT_DICTATION, "settingsPage.transcription.transcriptionPreview", {
    descriptionKey: "settingsPage.transcription.transcriptionPreviewDescription",
    // Also hidden under a managed enterprise engine, which the context doesn't see.
    fallbackAnchor: "dictation.stt.engine",
    aliases: ["live preview", "streaming", "realtime", "real-time"],
    available: requires("transcriptionPreview", "dictation.stt.engine", R.streamingOnly),
  }),
  row("dictation.stt.vad", STT_DICTATION, VAD_GROUP, {
    descriptionKey: "settingsPage.transcription.vad.description",
    aliases: ["vad", "silero", "voice activity detection", "silence", "hallucination"],
    available: vadAvailable,
  }),
  ...(["dictation", "noteRecording", "meeting"] as const).map((toggle) =>
    row(
      `dictation.stt.vad.${toggle}`,
      STT_DICTATION,
      `settingsPage.transcription.vad.toggles.${toggle}.title`,
      {
        descriptionKey: `settingsPage.transcription.vad.toggles.${toggle}.description`,
        groupKey: VAD_GROUP,
        aliases: ["vad", "silero"],
        available: vadAvailable,
      }
    )
  ),
  ...VAD_FIELDS.map(([field, aliases]) =>
    row(
      `dictation.stt.vad.${field}`,
      STT_DICTATION,
      `settingsPage.transcription.vad.fields.${field}.label`,
      {
        descriptionKey: `settingsPage.transcription.vad.fields.${field}.info`,
        anchor: "dictation.stt.vad.fields",
        groupKey: VAD_GROUP,
        aliases: ["vad", ...aliases],
        available: vadAvailable,
      }
    )
  ),
  row("dictation.stt.gpu", STT_DICTATION, "settingsPage.transcription.gpuDevice.title", {
    descriptionKey: "settingsPage.transcription.gpuDevice.description",
    fallbackAnchor: "dictation.stt.engine",
    aliases: ["gpu", "cuda", "nvidia", "graphics card", "video card"],
    available: multiGpu,
  }),
  row("notes.recording.engine", STT_NOTES, "settingsSearch.titles.noteRecordingEngine", {
    descriptionKey: "settingsSearch.descriptions.engine",
    value: "stt.noteRecording",
    aliases: [
      "meeting",
      "note recording",
      "speech to text",
      "stt",
      "streaming",
      "whisper",
      "parakeet",
      "deepgram",
      "assemblyai",
      "model",
    ],
  }),
  row("notes.recording.speakerDetection", STT_NOTES, "settings.meeting.speakerDetection.title", {
    descriptionKey: "settings.meeting.speakerDetection.description",
    aliases: ["diarization", "speakers", "who said", "speaker labels"],
  }),
  row(
    "notes.recording.echoCancellation",
    STT_NOTES,
    "settingsPage.transcription.aec.toggle.title",
    {
      descriptionKey: "settingsPage.transcription.aec.toggle.description",
      aliases: ["aec", "echo", "speakers", "feedback"],
    }
  ),
  row("notes.upload.engine", STT_UPLOAD, "settingsSearch.titles.uploadEngine", {
    descriptionKey: "settingsSearch.descriptions.engine",
    value: "stt.upload",
    aliases: ["upload", "audio file", "file", "speech to text", "stt", "whisper", "model"],
  }),

  // ── Language Models ──────────────────────────────────────────────────────
  page("page.llms", at("llms"), "settingsModal.sections.llms.label", {
    descriptionKey: "settingsModal.sections.llms.description",
    aliases: ["llm", "ai", "language model", "models"],
  }),
  page("page.llms.dictationCleanup", CLEANUP, "settingsPage.llms.tabs.dictationCleanup", {
    aliases: ["cleanup", "llm"],
  }),
  page("page.llms.dictationAgent", ASSISTANT, "settingsPage.llms.tabs.dictationAgent", {
    aliases: ["assistant", "voice agent", "agent"],
    available: agentAllowed,
  }),
  page(
    "page.llms.dictationTranslation",
    TRANSLATION,
    "settingsPage.llms.tabs.dictationTranslation",
    {
      aliases: ["translate", "translation"],
    }
  ),
  page("page.llms.noteFormatting", NOTE_FORMATTING, "settingsPage.llms.tabs.noteFormatting", {
    aliases: ["notes", "summary", "formatting"],
  }),
  page("page.llms.chatIntelligence", CHAT, "settingsPage.llms.tabs.chatIntelligence", {
    aliases: ["chat", "agent"],
    available: agentAllowed,
  }),
  row("dictation.cleanup.enabled", CLEANUP, "settingsPage.aiModels.enableTextCleanup", {
    descriptionKey: "settingsPage.aiModels.enableTextCleanupDescription",
    aliases: [
      "cleanup",
      "llm",
      "ai cleanup",
      "post-processing",
      "grammar",
      "punctuation",
      "filler",
    ],
  }),
  ...llmEditor(
    "dictation.cleanup.model",
    CLEANUP,
    "dictationCleanup",
    "settingsSearch.titles.cleanupModel",
    cleanupOn,
    ["cleanup"]
  ),
  row("dictation.cleanup.gpu", CLEANUP, "settingsPage.intelligence.gpuDevice.title", {
    descriptionKey: "settingsPage.intelligence.gpuDevice.description",
    fallbackAnchor: "dictation.cleanup.model",
    aliases: ["gpu", "cuda", "nvidia", "graphics card"],
    available: all(cleanupOn, multiGpu),
  }),
  row("dictation.cleanup.prompt", CLEANUP, "settingsPage.prompts.title", {
    descriptionKey: "settingsPage.prompts.description",
    aliases: ["prompt studio", "system prompt", "instructions", "custom prompt", "test set"],
  }),
  row("dictation.styles", CLEANUP, "styles.section.title", {
    descriptionKey: "styles.section.description",
    aliases: ["style studio", "tone", "formal", "email", "restyle", "rewrite"],
  }),
  row("dictation.styles.dictationStyle", CLEANUP, "styles.picker.label", {
    descriptionKey: "styles.picker.description",
    groupKey: "styles.section.title",
    aliases: ["default style", "style", "plain"],
  }),
  row("dictation.styles.list", CLEANUP, "styles.list.title", {
    groupKey: "styles.section.title",
    aliases: ["new style", "styles", "custom style"],
  }),
  row("assistant.enabled", ASSISTANT, "dictationAgent.enabled", {
    descriptionKey: "dictationAgent.enabledDescription",
    aliases: ["voice agent", "assistant", "agent", "command mode", "wake word", "hey"],
    available: agentAllowed,
  }),
  ...llmEditor(
    "assistant.model",
    ASSISTANT,
    "dictationAgent",
    "settingsSearch.titles.assistantModel",
    assistantOn,
    ["assistant", "agent"]
  ),
  row("assistant.screenContext", ASSISTANT, "dictationAgent.screenContext.enable", {
    descriptionKey: "dictationAgent.screenContext.enableDescription",
    groupKey: "dictationAgent.screenContext.title",
    aliases: ["screenshot", "screen", "vision", "screen capture", "context"],
    // Rendered (off, "managed by your organization") even when policy blocks it.
    available: assistantOn,
  }),
  row("assistant.visionOverride", ASSISTANT, "dictationAgent.screenContext.visionModel", {
    descriptionKey: "dictationAgent.screenContext.visionModelDescription",
    groupKey: "dictationAgent.screenContext.title",
    aliases: ["vision", "image model", "multimodal", "screenshot model"],
    value: "llm.dictationAgentVision",
    available: all(screenContextOn, (ctx) =>
      ctx.visionOverrideAllowed ? true : { reason: R.managedByOrg }
    ),
  }),
  row("assistant.name", ASSISTANT, "settingsPage.agentConfig.agentName", {
    descriptionKey: "settingsPage.agentConfig.helper",
    groupKey: "settingsPage.agentConfig.title",
    aliases: ["agent name", "wake word", "name", "hey", "call"],
    value: "agentName",
    available: agentAllowed,
  }),
  row("assistant.prompt", ASSISTANT, "dictationAgent.prompt.title", {
    descriptionKey: "dictationAgent.prompt.description",
    aliases: ["system prompt", "instructions", "prompt studio"],
    available: assistantOn,
  }),
  row("translation.enabled", TRANSLATION, "dictationTranslation.enabled", {
    descriptionKey: "dictationTranslation.enabledDescription",
    aliases: ["translate", "translator", "interpreter", "translation"],
  }),
  row("translation.source", TRANSLATION, "dictationTranslation.sourceLanguage", {
    descriptionKey: "dictationTranslation.sourceLanguageDescription",
    aliases: ["source language", "from language", "spoken language"],
    available: translationOn,
  }),
  row("translation.targets", TRANSLATION, "dictationTranslation.targetsLabel", {
    descriptionKey: "dictationTranslation.maxTargets",
    aliases: ["target language", "to language", "translate to"],
    value: "translationTargets",
    available: translationOn,
  }),
  ...llmEditor(
    "translation.model",
    TRANSLATION,
    "dictationTranslation",
    "settingsSearch.titles.translationModel",
    translationOn,
    ["translate", "translation"]
  ),
  row("translation.prompt", TRANSLATION, "dictationTranslation.prompt.title", {
    descriptionKey: "dictationTranslation.prompt.description",
    aliases: ["translation prompt", "instructions", "system prompt"],
    available: translationOn,
  }),
  row(
    "notes.formatting.autoTitle",
    NOTE_FORMATTING,
    "settingsPage.noteFormatting.autoGenerateTitle",
    {
      descriptionKey: "settingsPage.noteFormatting.autoGenerateTitleDescription",
      aliases: ["note title", "auto title", "rename notes"],
    }
  ),
  ...llmEditor(
    "notes.formatting.model",
    NOTE_FORMATTING,
    "noteFormatting",
    "settingsSearch.titles.noteFormattingModel",
    () => true,
    ["summary", "meeting notes", "enhance", "summarize", "formatting"]
  ),
  ...llmEditor(
    "chat.model",
    CHAT,
    "chatIntelligence",
    "settingsSearch.titles.chatModel",
    agentAllowed,
    ["chat", "agent"]
  ),
  row("chat.prompt", CHAT, "agentMode.settings.systemPrompt", {
    descriptionKey: "agentMode.settings.systemPromptDescription",
    aliases: ["chat prompt", "instructions", "custom instructions", "persona"],
    available: agentAllowed,
  }),

  // ── Privacy & Data ───────────────────────────────────────────────────────
  page("page.privacyData", PRIVACY, "settingsModal.sections.privacyData.label", {
    descriptionKey: "settingsModal.sections.privacyData.description",
    aliases: ["privacy", "data", "permissions"],
  }),
  row("privacy.cloud", PRIVACY, "settingsPage.openWhisprCloud.label", {
    descriptionKey: "settingsPage.openWhisprCloud.description",
    aliases: ["cloud", "account", "offline", "local only", "no internet", "airplane"],
  }),
  row("privacy.cloudBackup", PRIVACY, "settingsPage.privacy.cloudBackup", {
    descriptionKey: "settingsPage.privacy.cloudBackupDescription",
    fallbackAnchor: "privacy.cloud",
    aliases: ["backup", "sync", "cloud notes", "sync notes"],
    available: signedIn,
  }),
  row("privacy.insightsSync", PRIVACY, "settingsPage.privacy.insightsSync", {
    descriptionKey: "settingsPage.privacy.insightsSyncDescription",
    aliases: ["insights", "stats", "statistics", "sync"],
    available: cloudOn,
  }),
  row("privacy.leaderboard", PRIVACY, "insights.leaderboard.title", {
    descriptionKey: "settingsPage.privacy.leaderboardDescription",
    aliases: ["leaderboard", "ranking", "compete"],
    available: cloudOn,
  }),
  row("privacy.usageAnalytics", PRIVACY, "settingsPage.privacy.usageAnalytics", {
    descriptionKey: "settingsPage.privacy.usageAnalyticsDescription",
    aliases: ["telemetry", "analytics", "tracking", "usage data"],
    available: cloudOn,
  }),
  row("privacy.audioRetention", PRIVACY, "settingsPage.privacy.audioRetention", {
    descriptionKey: "settingsPage.privacy.audioRetentionDescription",
    aliases: ["recordings", "audio files", "keep audio", "retention", "delete audio"],
  }),
  row("privacy.audioStorage", PRIVACY, "settingsPage.privacy.audioStorageUsage", {
    aliases: ["disk space", "delete audio", "clear audio", "storage"],
  }),
  row("privacy.history", PRIVACY, "settingsPage.privacy.dataRetention", {
    descriptionKey: "settingsPage.privacy.dataRetentionDescription",
    aliases: ["history", "save transcriptions", "transcript history", "local history"],
  }),
  row("privacy.transcriptRetention", PRIVACY, "settingsPage.privacy.transcriptRetention", {
    descriptionKey: "settingsPage.privacy.transcriptRetentionDescription",
    aliases: ["delete history", "retention", "auto delete", "keep transcripts"],
  }),
  row("privacy.saveDiscarded", PRIVACY, "settingsPage.privacy.saveDiscarded", {
    descriptionKey: "settingsPage.privacy.saveDiscardedDescription",
    aliases: ["cancelled", "discarded", "canceled recordings"],
  }),
  row("privacy.permissions", PRIVACY, "settingsPage.permissions.title", {
    descriptionKey: "settingsPage.permissions.description",
    aliases: ["permissions", "access", "allow"],
  }),
  row("privacy.permissions.microphone", PRIVACY, "settingsPage.permissions.microphoneTitle", {
    descriptionKey: "settingsPage.permissions.microphoneDescription",
    groupKey: "settingsPage.permissions.title",
    aliases: ["mic permission", "microphone access", "allow microphone"],
  }),
  row("privacy.permissions.accessibility", PRIVACY, "settingsPage.permissions.accessibilityTitle", {
    descriptionKey: "settingsPage.permissions.accessibilityDescription",
    groupKey: "settingsPage.permissions.title",
    aliases: ["accessibility", "paste permission", "macos"],
    available: onPlatform("darwin", R.macOnly),
  }),
  row("privacy.permissions.systemAudio", PRIVACY, "settingsPage.permissions.systemAudioTitle", {
    descriptionKey: "settingsPage.permissions.systemAudioDescription",
    fallbackAnchor: "privacy.permissions",
    groupKey: "settingsPage.permissions.title",
    aliases: ["system audio", "screen recording", "loopback", "meeting audio"],
  }),
  row(
    "privacy.permissions.resetAccessibility",
    PRIVACY,
    "settingsPage.permissions.resetAccessibility.label",
    {
      descriptionKey: "settingsPage.permissions.resetAccessibility.rowDescription",
      groupKey: "settingsPage.permissions.title",
      aliases: ["troubleshoot", "reset permissions", "paste not working"],
      available: onPlatform("darwin", R.macOnly),
    }
  ),

  // ── System ───────────────────────────────────────────────────────────────
  page("page.system", SYSTEM, "settingsModal.sections.system.label", {
    descriptionKey: "settingsModal.sections.system.description",
    aliases: ["system", "about", "advanced"],
  }),
  row("system.updates.version", SYSTEM, "settingsPage.general.updates.currentVersion", {
    groupKey: "settingsPage.general.updates.title",
    aliases: ["version", "about", "update", "build"],
  }),
  row("system.updates.auto", SYSTEM, "settingsPage.general.updates.automaticUpdates", {
    descriptionKey: "settingsPage.general.updates.automaticUpdatesDescription",
    fallbackAnchor: "system.updates.version",
    groupKey: "settingsPage.general.updates.title",
    aliases: ["auto update", "updates", "upgrade app"],
  }),
  row("system.updates.check", SYSTEM, "settingsPage.general.updates.checkForUpdates", {
    groupKey: "settingsPage.general.updates.title",
    aliases: ["update", "new version", "upgrade app"],
  }),
  row("system.developer.debug", SYSTEM, "developerSection.debugMode.label", {
    descriptionKey: "developerSection.description",
    groupKey: "developerSection.title",
    aliases: ["debug", "logs", "logging", "diagnostics", "verbose", "troubleshoot"],
  }),
  row("system.developer.logs", SYSTEM, "developerSection.openLogsFolder", {
    fallbackAnchor: "system.developer.debug",
    groupKey: "developerSection.title",
    aliases: ["logs", "log file", "log folder"],
  }),
  row("system.data.modelCache", SYSTEM, "settingsPage.developer.modelCache", {
    groupKey: "settingsPage.developer.dataManagementTitle",
    aliases: ["delete models", "clear cache", "disk space", "downloaded models", "storage"],
  }),
  row("system.data.reset", SYSTEM, "settingsPage.developer.resetAppData", {
    descriptionKey: "settingsPage.developer.resetAppDataDescription",
    groupKey: "settingsPage.developer.dataManagementTitle",
    aliases: ["factory reset", "wipe", "clear data", "start over", "uninstall"],
  }),

  // ── Elsewhere in the app ─────────────────────────────────────────────────
  {
    id: "elsewhere.dictionary",
    kind: "elsewhere",
    elsewhere: { view: "dictionary" },
    titleKey: "sidebar.dictionary",
    descriptionKey: "settingsSearch.elsewhere.dictionary",
    aliases: ["glossary", "snippets", "vocabulary", "custom words", "replacements", "jargon"],
    aliasKeys: ["dictionary.tabSnippets", "dictionary.tabGlossary"],
  },
  ...(
    [
      ["calendars", ["calendar", "google calendar", "outlook", "meetings"], false],
      ["connectors", ["gmail", "email", "drafts", "connectors"], true],
      ["api", ["api key", "developer", "rest api"], true],
      ["mcp", ["mcp", "claude desktop", "model context protocol"], true],
      ["cli", ["terminal", "command line", "cli", "shell"], false],
    ] as const
  ).map(([section, aliases, needsCloud]): SettingDescriptor => ({
    id: `elsewhere.integrations.${section}`,
    kind: "elsewhere",
    elsewhere: { view: "integrations", integrationsSection: section },
    titleKey: `integrations.nav.sections.${section}`,
    descriptionKey: "settingsSearch.elsewhere.integrations",
    aliases: ["integrations", ...aliases],
    available: needsCloud ? cloudOn : undefined,
  })),
];

const BY_ID = new Map(SETTINGS_SEARCH_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

export function findSettingDescriptor(
  id: string | undefined | null
): SettingDescriptor | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Where a setting id lives in Settings; undefined for unknown ids and app pages. */
export function locateSetting(id: string): SettingsLocation | undefined {
  return findSettingDescriptor(id)?.location;
}

/** True when it can be opened now; otherwise why not (or null: not listed). */
export function settingAvailability(
  descriptor: SettingDescriptor,
  ctx: SettingsSearchContext
): SettingAvailability {
  return descriptor.available ? descriptor.available(ctx) : true;
}

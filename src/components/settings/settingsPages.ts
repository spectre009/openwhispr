import type { InferenceScope } from "../../config/inferenceScopes";
import type { PromptKind } from "../../config/prompts/registry";

/**
 * The Settings pages and their nav tree: groups → pages, or a parent whose
 * sub-pages show under it while one of them is open. Kept free of React and
 * icons (icons are named here and mapped in settingsPageIcons.ts) so the
 * resolver and the search index run in plain tests.
 *
 * Destinations stay backward compatible: every string `openSettings` accepted
 * before pages (section ids, their aliases and legacy sub-tab names,
 * `#settingId`, `<section>#<settingId>`) resolves to a page here, as do the new
 * page ids, parent ids and `<pageId>#<settingId>`.
 */

export type SettingsPageId =
  | "account"
  | "plansBilling"
  | "workspace"
  | "recognition"
  | "cleanup"
  | "styles"
  | "output"
  | "assistant"
  | "translation"
  | "chat"
  | "liveRecording"
  | "fileTranscription"
  | "noteFormatting"
  | "appearance"
  | "audio"
  | "notifications"
  | "floatingIcon"
  | "startup"
  | "noteFiles"
  | "hotkeys"
  | "privacyData"
  | "system";

/** Nav items that hold sub-pages; opening one opens its first visible sub-page. */
export type SettingsParentId = "dictation" | "notes" | "app";

export type SettingsNavGroupId = "account" | "features" | "setup" | "data" | "elsewhere";

/** Icons by name, mapped to components in settingsPageIcons.ts. */
export type SettingsIconName =
  | "UserCircle"
  | "CreditCard"
  | "Users"
  | "Mic"
  | "AudioLines"
  | "Wand2"
  | "Pencil"
  | "ClipboardCheck"
  | "Sparkles"
  | "Languages"
  | "MessageSquare"
  | "NotebookPen"
  | "FileAudio"
  | "Upload"
  | "FileText"
  | "Sliders"
  | "Sun"
  | "Mic2"
  | "MessageCircle"
  | "LocateFixed"
  | "Play"
  | "FolderOpen"
  | "Keyboard"
  | "Shield"
  | "Wrench"
  | "BookOpen"
  | "Blocks";

/**
 * Blocks of the old Preferences section. SettingsPage wraps each in a
 * `show("<blockId>")` check, so a page renders the blocks listed for it.
 */
export type PreferencesBlockId =
  | "appearance"
  | "sounds"
  | "notifications"
  | "clipboard"
  | "noteFiles"
  | "granolaImport"
  | "floatingIcon"
  | "language.ui"
  | "language.transcription"
  | "startup"
  | "microphone"
  | "autoLearn"
  | "waylandPaste";

/** What decides which pages show. */
export interface SettingsPageContext {
  cloudDisabled: boolean;
  isSignedIn: boolean;
  /** The organization allows the voice assistant and chat (isAgentAllowed). */
  agentAllowed: boolean;
}

/** An AI feature page: its header shows the scope's provider · model and the prompt in use. */
export interface SettingsFeature {
  scope: InferenceScope;
  prompt?: PromptKind;
}

export interface SettingsPageDef {
  titleKey: string;
  descriptionKey: string;
  icon: SettingsIconName;
  /** False hides the page from the nav, and a destination naming it lands on `fallback`. */
  visible?: (ctx: SettingsPageContext) => boolean;
  /** Where a hidden page's destinations land; the default page when unset. */
  fallback?: SettingsPageId;
  /** Preferences blocks the page shows, in order. */
  blocks?: readonly PreferencesBlockId[];
  feature?: SettingsFeature;
}

const cloudOn = (ctx: SettingsPageContext) => !ctx.cloudDisabled;
const agentOn = (ctx: SettingsPageContext) => ctx.agentAllowed;

const pageKeys = (id: string) => ({
  titleKey: `settingsNav.pages.${id}.title`,
  descriptionKey: `settingsNav.pages.${id}.description`,
});
const sectionKeys = (section: string) => ({
  titleKey: `settingsModal.sections.${section}.label`,
  descriptionKey: `settingsModal.sections.${section}.description`,
});

export const SETTINGS_PAGES: Readonly<Record<SettingsPageId, SettingsPageDef>> = {
  account: { ...sectionKeys("account"), icon: "UserCircle", visible: cloudOn },
  plansBilling: { ...sectionKeys("plansBilling"), icon: "CreditCard", visible: cloudOn },
  workspace: {
    ...sectionKeys("workspace"),
    icon: "Users",
    visible: (ctx) => cloudOn(ctx) && ctx.isSignedIn,
    fallback: "account",
  },
  recognition: {
    ...pageKeys("recognition"),
    icon: "AudioLines",
    blocks: ["language.transcription"],
  },
  cleanup: {
    titleKey: "settingsNav.pages.cleanup.title",
    descriptionKey: "settingsPage.aiModels.enableTextCleanupDescription",
    icon: "Wand2",
    feature: { scope: "dictationCleanup", prompt: "cleanup" },
  },
  styles: {
    titleKey: "styles.section.title",
    descriptionKey: "styles.section.description",
    icon: "Pencil",
  },
  output: {
    ...pageKeys("output"),
    icon: "ClipboardCheck",
    blocks: ["clipboard", "autoLearn", "waylandPaste"],
  },
  assistant: {
    titleKey: "settingsPage.llms.tabs.dictationAgent",
    // Interpolated with {{agentName}}.
    descriptionKey: "dictationAgent.enabledDescription",
    icon: "Sparkles",
    visible: agentOn,
    fallback: "cleanup",
    feature: { scope: "dictationAgent", prompt: "dictationAgent" },
  },
  translation: {
    titleKey: "settingsPage.llms.tabs.dictationTranslation",
    descriptionKey: "dictationTranslation.description",
    icon: "Languages",
    feature: { scope: "dictationTranslation", prompt: "translate" },
  },
  chat: {
    titleKey: "settingsPage.llms.tabs.chatIntelligence",
    descriptionKey: "settingsNav.pages.chat.description",
    icon: "MessageSquare",
    visible: agentOn,
    fallback: "cleanup",
    feature: { scope: "chatIntelligence", prompt: "chatAgent" },
  },
  liveRecording: { ...pageKeys("liveRecording"), icon: "FileAudio" },
  fileTranscription: { ...pageKeys("fileTranscription"), icon: "Upload" },
  noteFormatting: {
    titleKey: "settingsPage.llms.tabs.noteFormatting",
    descriptionKey: "settingsNav.pages.noteFormatting.description",
    icon: "FileText",
    feature: { scope: "noteFormatting" },
  },
  appearance: { ...pageKeys("appearance"), icon: "Sun", blocks: ["appearance", "language.ui"] },
  audio: { ...pageKeys("audio"), icon: "Mic2", blocks: ["microphone", "sounds"] },
  notifications: {
    titleKey: "settingsPage.general.notifications.title",
    descriptionKey: "settingsPage.general.notifications.description",
    icon: "MessageCircle",
    blocks: ["notifications"],
  },
  floatingIcon: {
    titleKey: "settingsPage.general.floatingIcon.title",
    descriptionKey: "settingsPage.general.floatingIcon.description",
    icon: "LocateFixed",
    blocks: ["floatingIcon"],
  },
  startup: {
    titleKey: "settingsPage.general.startup.title",
    descriptionKey: "settingsPage.general.startup.description",
    icon: "Play",
    blocks: ["startup"],
  },
  noteFiles: {
    ...pageKeys("noteFiles"),
    icon: "FolderOpen",
    blocks: ["noteFiles", "granolaImport"],
  },
  hotkeys: { ...sectionKeys("hotkeys"), icon: "Keyboard" },
  privacyData: { ...sectionKeys("privacyData"), icon: "Shield" },
  system: { ...sectionKeys("system"), icon: "Wrench" },
};

/** App pages outside Settings the nav links to (the same ones settings search finds). */
export interface SettingsElsewhereLink {
  view: "dictionary" | "integrations";
}

export type SettingsNavItemDef =
  | { kind: "page"; page: SettingsPageId }
  | {
      kind: "parent";
      id: SettingsParentId;
      titleKey: string;
      icon: SettingsIconName;
      pages: readonly SettingsPageId[];
    }
  | {
      kind: "elsewhere";
      id: string;
      titleKey: string;
      icon: SettingsIconName;
      location: SettingsElsewhereLink;
    };

export interface SettingsNavGroupDef {
  id: SettingsNavGroupId;
  labelKey: string;
  items: readonly SettingsNavItemDef[];
}

export const SETTINGS_NAV: readonly SettingsNavGroupDef[] = [
  {
    id: "account",
    labelKey: "settingsModal.groups.account",
    items: [
      { kind: "page", page: "account" },
      { kind: "page", page: "plansBilling" },
      { kind: "page", page: "workspace" },
    ],
  },
  {
    id: "features",
    labelKey: "settingsNav.groups.features",
    items: [
      {
        kind: "parent",
        id: "dictation",
        titleKey: "settingsNav.parents.dictation",
        icon: "Mic",
        // Stage 8 puts a Dictation overview first.
        pages: ["recognition", "cleanup", "styles", "output"],
      },
      { kind: "page", page: "assistant" },
      { kind: "page", page: "translation" },
      { kind: "page", page: "chat" },
      {
        kind: "parent",
        id: "notes",
        titleKey: "settingsNav.parents.notes",
        icon: "NotebookPen",
        pages: ["liveRecording", "fileTranscription", "noteFormatting"],
      },
    ],
  },
  {
    id: "setup",
    labelKey: "settingsNav.groups.setup",
    items: [
      {
        kind: "parent",
        id: "app",
        titleKey: "settingsNav.parents.app",
        icon: "Sliders",
        pages: [
          "appearance",
          "audio",
          "notifications",
          "floatingIcon",
          "startup",
          "noteFiles",
          "hotkeys",
        ],
      },
    ],
  },
  {
    id: "data",
    labelKey: "settingsNav.groups.data",
    items: [
      { kind: "page", page: "privacyData" },
      { kind: "page", page: "system" },
    ],
  },
  {
    id: "elsewhere",
    labelKey: "settingsSearch.groups.elsewhere",
    items: [
      {
        kind: "elsewhere",
        id: "dictionary",
        titleKey: "settingsNav.elsewhere.dictionary",
        icon: "BookOpen",
        location: { view: "dictionary" },
      },
      {
        kind: "elsewhere",
        id: "integrations",
        titleKey: "sidebar.integrations",
        icon: "Blocks",
        location: { view: "integrations" },
      },
    ],
  },
];

// ── Lookups ────────────────────────────────────────────────────────────────

interface PageTrail {
  group: SettingsNavGroupDef;
  parent?: Extract<SettingsNavItemDef, { kind: "parent" }>;
  /** Position of the page's top-level nav item (the page, or its parent). */
  topOrder: number;
}

const TRAILS = new Map<SettingsPageId, PageTrail>();
const PARENTS = new Map<SettingsParentId, Extract<SettingsNavItemDef, { kind: "parent" }>>();
let elsewhereOrder = -1;
{
  let topOrder = 0;
  for (const group of SETTINGS_NAV) {
    for (const item of group.items) {
      if (item.kind === "page") TRAILS.set(item.page, { group, topOrder });
      else if (item.kind === "parent") {
        PARENTS.set(item.id, item);
        for (const page of item.pages) TRAILS.set(page, { group, parent: item, topOrder });
      } else if (elsewhereOrder < 0) elsewhereOrder = topOrder;
      topOrder++;
    }
  }
}

/** Where the app pages outside Settings sit in the nav (search lists them there too). */
export const SETTINGS_ELSEWHERE_ORDER = elsewhereOrder;

/** Every page, in nav order. */
export const SETTINGS_PAGE_IDS: readonly SettingsPageId[] = [...TRAILS.keys()];

export function isSettingsPageId(value: unknown): value is SettingsPageId {
  return typeof value === "string" && TRAILS.has(value as SettingsPageId);
}

export function isSettingsParentId(value: unknown): value is SettingsParentId {
  return typeof value === "string" && PARENTS.has(value as SettingsParentId);
}

/** The parent a page sits under, if any. */
export function settingsPageParent(page: SettingsPageId): SettingsParentId | undefined {
  return TRAILS.get(page)?.parent?.id;
}

/**
 * Where a page sits: its nav group, its parent and the top-level nav item it
 * belongs to (the parent, or the page itself), which search groups results by.
 */
export function settingsPageTrail(page: SettingsPageId): {
  groupId: SettingsNavGroupId;
  groupLabelKey: string;
  parentId?: SettingsParentId;
  parentTitleKey?: string;
  topId: SettingsPageId | SettingsParentId;
  topTitleKey: string;
  topOrder: number;
  titleKey: string;
} {
  const trail = TRAILS.get(page);
  if (!trail) throw new Error(`Unknown settings page: ${page}`);
  const titleKey = SETTINGS_PAGES[page].titleKey;
  return {
    groupId: trail.group.id,
    groupLabelKey: trail.group.labelKey,
    parentId: trail.parent?.id,
    parentTitleKey: trail.parent?.titleKey,
    topId: trail.parent?.id ?? page,
    topTitleKey: trail.parent?.titleKey ?? titleKey,
    topOrder: trail.topOrder,
    titleKey,
  };
}

/** The top bar's trail after "Settings": the parent (or the nav group) and the page. */
export function settingsBreadcrumbKeys(page: SettingsPageId): [string, string] {
  const trail = settingsPageTrail(page);
  return [trail.parentTitleKey ?? trail.groupLabelKey, trail.titleKey];
}

export function isSettingsPageVisible(page: SettingsPageId, ctx: SettingsPageContext): boolean {
  return SETTINGS_PAGES[page].visible?.(ctx) ?? true;
}

/** Where Settings opens when nothing more specific was asked for. */
export function defaultSettingsPage(ctx: SettingsPageContext): SettingsPageId {
  return isSettingsPageVisible("account", ctx) ? "account" : "recognition";
}

/** The page actually shown: a hidden one (Cloud off, signed out, agent policy) falls back. */
export function shownSettingsPage(page: SettingsPageId, ctx: SettingsPageContext): SettingsPageId {
  let current = page;
  // Fallbacks chain at most once or twice (workspace → account → default).
  for (let step = 0; step < 4 && !isSettingsPageVisible(current, ctx); step++) {
    current = SETTINGS_PAGES[current].fallback ?? defaultSettingsPage(ctx);
  }
  return isSettingsPageVisible(current, ctx) ? current : "recognition";
}

/** A parent's first visible sub-page. */
export function firstSettingsPageOf(
  parent: SettingsParentId,
  ctx: SettingsPageContext
): SettingsPageId {
  const pages = PARENTS.get(parent)?.pages ?? [];
  return pages.find((page) => isSettingsPageVisible(page, ctx)) ?? defaultSettingsPage(ctx);
}

/** The nav as the context shows it: hidden pages dropped, then empty parents and groups. */
export function visibleSettingsNav(ctx: SettingsPageContext): SettingsNavGroupDef[] {
  return SETTINGS_NAV.map((group) => ({
    ...group,
    items: group.items
      .map((item): SettingsNavItemDef | null => {
        if (item.kind === "page") return isSettingsPageVisible(item.page, ctx) ? item : null;
        if (item.kind === "parent") {
          const pages = item.pages.filter((page) => isSettingsPageVisible(page, ctx));
          return pages.length ? { ...item, pages } : null;
        }
        return item;
      })
      .filter((item): item is SettingsNavItemDef => item !== null),
  })).filter((group) => group.items.length > 0);
}

// ── Legacy destinations ────────────────────────────────────────────────────

/** The nine sections Settings had before pages. */
export type LegacySettingsSection =
  | "account"
  | "plansBilling"
  | "workspace"
  | "general"
  | "hotkeys"
  | "speechToText"
  | "llms"
  | "privacyData"
  | "system";

const LEGACY_SECTION_PAGES: Readonly<Record<LegacySettingsSection, SettingsPageId>> = {
  account: "account",
  plansBilling: "plansBilling",
  workspace: "workspace",
  // Preferences' first block.
  general: "appearance",
  hotkeys: "hotkeys",
  speechToText: "recognition",
  llms: "cleanup",
  privacyData: "privacyData",
  system: "system",
};

/** The old Speech-to-Text and Language Models sub-tabs, each now a page. */
const LEGACY_SUB_TAB_PAGES: Readonly<
  Partial<Record<LegacySettingsSection, Record<string, SettingsPageId>>>
> = {
  speechToText: {
    dictation: "recognition",
    noteRecording: "liveRecording",
    upload: "fileTranscription",
  },
  llms: {
    dictationCleanup: "cleanup",
    dictationAgent: "assistant",
    dictationTranslation: "translation",
    noteFormatting: "noteFormatting",
    chatIntelligence: "chat",
  },
};

// The old AI Models sidebar had four items (transcription, meetings,
// intelligence, agentMode); they became speechToText + llms sub-tabs, and are
// pages now. "dictationAgent" is a live deep link (the Home GPU banner).
export const SECTION_ALIASES: Readonly<Record<string, LegacySettingsSection>> = {
  aiModels: "llms",
  agentConfig: "llms",
  agentMode: "llms",
  dictationAgent: "llms",
  intelligence: "llms",
  meetings: "llms",
  prompts: "llms",
  transcription: "speechToText",
  uploadTranscription: "speechToText",
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
};

export const LEGACY_SUB_TAB: Readonly<Record<string, string>> = {
  transcription: "dictation",
  uploadTranscription: "upload",
  dictationAgent: "dictationAgent",
  meetings: "noteFormatting",
  intelligence: "dictationCleanup",
  agentMode: "chatIntelligence",
  agentConfig: "chatIntelligence",
  aiModels: "dictationCleanup",
  prompts: "dictationCleanup",
};

export function isLegacySettingsSection(value: unknown): value is LegacySettingsSection {
  return typeof value === "string" && value in LEGACY_SECTION_PAGES;
}

/** The page an old section (and sub-tab) became. */
export function pageForLegacy(section: LegacySettingsSection, subTab?: string): SettingsPageId {
  return (subTab && LEGACY_SUB_TAB_PAGES[section]?.[subTab]) || LEGACY_SECTION_PAGES[section];
}

/**
 * The tabs Speech-to-Text and Language Models last showed were kept in these
 * keys. They're read once, mapped to pages, and removed: a bare `llms` or
 * `speechToText` destination (provider errors) uses the mapped page once.
 */
export const RETIRED_TAB_KEYS = {
  speechToText: "settings.speechToTextTab",
  llms: "settings.llmsTab",
} as const;

export type SavedTabSection = keyof typeof RETIRED_TAB_KEYS;
export type SavedLegacyTabs = Partial<Record<SavedTabSection, SettingsPageId>>;

export interface SettingsKeyValueStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/** Reads the retired tab keys as pages and removes them; a second call finds nothing. */
export function takeSavedLegacyTabs(storage: SettingsKeyValueStorage | undefined): SavedLegacyTabs {
  const tabs: SavedLegacyTabs = {};
  if (!storage) return tabs;
  for (const section of Object.keys(RETIRED_TAB_KEYS) as SavedTabSection[]) {
    const key = RETIRED_TAB_KEYS[section];
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
      if (raw !== null) storage.removeItem(key);
    } catch {
      continue;
    }
    if (raw === null) continue;
    let tab: unknown = raw;
    try {
      tab = JSON.parse(raw);
    } catch {
      // A bare string is a tab id too.
    }
    const page = typeof tab === "string" ? LEGACY_SUB_TAB_PAGES[section]?.[tab] : undefined;
    if (page) tabs[section] = page;
  }
  return tabs;
}

// ── Destinations ───────────────────────────────────────────────────────────

/** Where a setting lives. `subTab` is the Workspace page's tab. */
export interface SettingsLocation {
  page: SettingsPageId;
  subTab?: string;
}

/** Where a setting id lives, from the search registry (kept out of this module). */
export type LocateSetting = (settingId: string) => SettingsLocation | undefined;

export interface SettingsDestination extends SettingsLocation {
  /** A setting to scroll to and flash once the page renders. */
  settingId?: string;
  /** The retired saved tab this destination used up. */
  usedSavedTab?: SavedTabSection;
}

/**
 * A destination string: a page, parent, section or legacy name (`cleanup`,
 * `llms`, `meetings`), a setting (`#dictation.cleanup.model`), or both
 * (`appearance#preferences.theme`, the name being the fallback when the id is
 * unknown).
 */
export function parseSettingsDestination(destination: string | undefined): {
  name?: string;
  settingId?: string;
} {
  if (!destination) return {};
  const hash = destination.indexOf("#");
  if (hash < 0) return { name: destination };
  const name = destination.slice(0, hash) || undefined;
  const settingId = destination.slice(hash + 1) || undefined;
  return settingId ? { name, settingId } : { name };
}

/** The destination string that opens Settings at a setting (see parseSettingsDestination). */
export function settingDestination(settingId: string, page?: string): string {
  return `${page ?? ""}#${settingId}`;
}

/** A page, parent, section or legacy name, as a page. Undefined for unknown names. */
function pageForName(
  name: string,
  ctx: SettingsPageContext,
  savedTabs: SavedLegacyTabs | undefined
): { page: SettingsPageId; usedSavedTab?: SavedTabSection } | undefined {
  if (isSettingsPageId(name)) return { page: name };
  if (isSettingsParentId(name)) return { page: firstSettingsPageOf(name, ctx) };
  const section = SECTION_ALIASES[name] ?? name;
  if (!isLegacySettingsSection(section)) return undefined;
  const subTab = LEGACY_SUB_TAB[name];
  if (!subTab && (section === "llms" || section === "speechToText") && savedTabs?.[section]) {
    return { page: savedTabs[section] as SettingsPageId, usedSavedTab: section };
  }
  return { page: pageForLegacy(section, subTab) };
}

/**
 * Where a destination lands: a visible page (hidden ones fall back), the
 * Workspace tab when a setting names one, and the setting to reveal.
 */
export function resolveSettingsDestination(
  destination: string | undefined,
  {
    ctx,
    locateSetting,
    savedTabs,
  }: {
    ctx: SettingsPageContext;
    locateSetting?: LocateSetting;
    savedTabs?: SavedLegacyTabs;
  }
): SettingsDestination {
  const { name, settingId } = parseSettingsDestination(destination);
  // A known setting id names its own page (search moves settings by moving that).
  const located = settingId ? locateSetting?.(settingId) : undefined;
  let result: SettingsDestination;
  if (located) {
    result = located.subTab
      ? { page: located.page, subTab: located.subTab }
      : { page: located.page };
  } else {
    const named = name ? pageForName(name, ctx, savedTabs) : undefined;
    result = named ?? { page: defaultSettingsPage(ctx) };
  }
  const page = shownSettingsPage(result.page, ctx);
  if (page !== result.page) result = { ...result, page, subTab: undefined };
  if (result.subTab === undefined) delete result.subTab;
  return settingId ? { ...result, settingId } : result;
}

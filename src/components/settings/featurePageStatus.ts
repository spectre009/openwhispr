import {
  DEFAULT_PROMPT_ID,
  findPromptEntry,
  type PromptLibrary,
} from "../../config/prompts/library";
import type { SettingsState } from "../../stores/settingsStore";

/** i18next's `t`, narrowed to what the helpers need. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * What a feature page's header says beyond its provider · model (which comes
 * from the search context's describeLlm). Kept pure so it runs in plain tests.
 */

/** The prompt in use: the active library entry's name, or the built-in default. */
export function activePromptName(library: PromptLibrary | undefined, t: Translate): string {
  if (!library || library.activeId === DEFAULT_PROMPT_ID) {
    return t("promptStudio.library.defaultName");
  }
  const entry = findPromptEntry(library, library.activeId);
  if (!entry) return t("promptStudio.library.defaultName");
  return entry.name || t("promptStudio.library.untitled");
}

type NoteFormattingFields = Pick<
  SettingsState,
  | "noteFormattingMode"
  | "noteFormattingProvider"
  | "noteFormattingModel"
  | "noteFormattingRemoteUrl"
>;

/**
 * Note formatting borrows Cleanup's value for each field its own mode needs
 * and leaves empty (selectResolvedLLMConfig's fallback scope). Pass
 * policy-effective settings, as the editors show them.
 */
export function noteFormattingInheritsCleanup(settings: NoteFormattingFields): boolean {
  switch (settings.noteFormattingMode) {
    case "providers":
      return !settings.noteFormattingProvider || !settings.noteFormattingModel;
    case "local":
      return !settings.noteFormattingModel;
    case "self-hosted":
      return !settings.noteFormattingRemoteUrl || !settings.noteFormattingModel;
    default:
      // OpenWhispr Cloud picks its own model; enterprise resolves per scope.
      return false;
  }
}

/** The features that run on Cleanup's model besides Cleanup itself: Styles, and Note formatting when it inherits. */
export function cleanupSharedWith({
  stylesInUse,
  noteFormattingInherits,
}: {
  stylesInUse: boolean;
  noteFormattingInherits: boolean;
}): Array<"styles" | "noteFormatting"> {
  const shared: Array<"styles" | "noteFormatting"> = [];
  if (stylesInUse) shared.push("styles");
  if (noteFormattingInherits) shared.push("noteFormatting");
  return shared;
}

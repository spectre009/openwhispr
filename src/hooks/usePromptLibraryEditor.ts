import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../stores/settingsStore";
import { getDefaultPromptText, type PromptKind } from "../config/prompts";
import {
  DEFAULT_PROMPT_ID,
  findPromptEntry,
  normalizePromptName,
  type PromptLibrary,
  type PromptLibraryEntry,
} from "../config/prompts/library";

export type PromptLibraryRequest =
  | { type: "new" | "duplicate" | "rename" | "saveAsNew"; name: string }
  | { type: "delete" }
  | { type: "discard"; nextId: string };

export type PromptLibraryNotice = "deletedElsewhere" | null;

export interface PromptLibraryEditor {
  kind: PromptKind;
  library: PromptLibrary;
  /** The prompt being viewed and edited (an entry id or DEFAULT_PROMPT_ID). */
  selectedId: string;
  selectedEntry: PromptLibraryEntry | null;
  isDefaultSelected: boolean;
  isSelectedActive: boolean;
  /** The selected prompt as saved (the built-in text for Default). */
  savedText: string;
  /** What the editor shows: the unsaved draft, else the saved text. */
  editorText: string;
  isDirty: boolean;
  justSaved: boolean;
  notice: PromptLibraryNotice;
  request: PromptLibraryRequest | null;
  displayName: (id: string) => string;
  select: (id: string) => void;
  setDraft: (text: string) => void;
  discardDraft: () => void;
  save: () => boolean;
  activateSelected: () => void;
  activateDefault: () => void;
  startNew: () => void;
  startDuplicate: () => void;
  startRename: () => void;
  startSaveAsNew: () => void;
  startDelete: () => void;
  setRequestName: (name: string) => void;
  confirmRequest: () => void;
  cancelRequest: () => void;
}

/**
 * Selection, draft and actions for one kind's prompt library. The draft is
 * local to this editor: only save / save as new write the library, and every
 * write goes through the store's library actions (one read-modify-write of the
 * stored record each).
 */
export function usePromptLibraryEditor(
  kind: PromptKind,
  { uiLanguage, onEdit }: { uiLanguage?: string; onEdit?: () => void } = {}
): PromptLibraryEditor {
  const { t } = useTranslation();
  const library = useSettingsStore((s) => s.promptLibraries[kind]);
  const createPrompt = useSettingsStore((s) => s.createPrompt);
  const savePrompt = useSettingsStore((s) => s.savePrompt);
  const renamePrompt = useSettingsStore((s) => s.renamePrompt);
  const deletePrompt = useSettingsStore((s) => s.deletePrompt);
  const activatePrompt = useSettingsStore((s) => s.activatePrompt);

  const [chosenId, setChosenId] = useState<string>(() => library.activeId);
  const [draftState, setDraftState] = useState<{ id: string; text: string } | null>(null);
  const [request, setRequest] = useState<PromptLibraryRequest | null>(null);
  const [notice, setNotice] = useState<PromptLibraryNotice>(null);
  const [justSaved, setJustSaved] = useState(false);

  // A prompt deleted in another window can't stay selected: fall back to the one in use.
  const chosenEntry = findPromptEntry(library, chosenId);
  const selectedId = chosenId === DEFAULT_PROMPT_ID || chosenEntry ? chosenId : library.activeId;
  const selectedEntry = findPromptEntry(library, selectedId) ?? null;
  const isDefaultSelected = !selectedEntry;
  const defaultText = getDefaultPromptText(kind, uiLanguage);
  const savedText = selectedEntry ? selectedEntry.text : defaultText;
  const draft = draftState && draftState.id === selectedId ? draftState.text : null;
  const isDirty = !isDefaultSelected && draft !== null && draft !== savedText;
  const editorText = draft ?? savedText;

  const displayName = useCallback(
    (id: string) => {
      if (id === DEFAULT_PROMPT_ID) return t("promptStudio.library.defaultName");
      return findPromptEntry(library, id)?.name || t("promptStudio.library.untitled");
    },
    [library, t]
  );

  const selectNow = (id: string) => {
    setChosenId(id);
    setDraftState(null);
    setNotice(null);
    setJustSaved(false);
  };

  const select = (id: string) => {
    if (id === selectedId) return;
    if (isDirty) {
      setRequest({ type: "discard", nextId: id });
      return;
    }
    selectNow(id);
  };

  const setDraft = (text: string) => {
    if (isDefaultSelected) return;
    setDraftState({ id: selectedId, text });
    setJustSaved(false);
  };

  const save = () => {
    if (!selectedEntry || draft === null || !draft.trim()) return false;
    const saved = savePrompt(kind, selectedEntry.id, draft);
    if (saved || draft === savedText) {
      setDraftState(null);
      setJustSaved(true);
      return true;
    }
    if (!findPromptEntry(useSettingsStore.getState().promptLibraries[kind], selectedEntry.id)) {
      // Deleted in another window meanwhile: keep the edits as a new prompt
      // rather than lose them with the selection.
      const id = createPrompt(kind, { name: selectedEntry.name, text: draft });
      if (id) {
        selectNow(id);
        setJustSaved(true);
        setNotice("deletedElsewhere");
        return true;
      }
    }
    return false;
  };

  const copyName = (name: string) => t("promptStudio.library.copyName", { name });

  const confirmRequest = () => {
    if (!request) return;
    if (request.type === "delete") {
      if (selectedEntry) deletePrompt(kind, selectedEntry.id);
      setRequest(null);
      selectNow(useSettingsStore.getState().promptLibraries[kind].activeId);
      return;
    }
    if (request.type === "discard") {
      setRequest(null);
      selectNow(request.nextId);
      return;
    }
    const name = normalizePromptName(request.name);
    if (!name) return;
    setRequest(null);
    if (request.type === "rename") {
      if (selectedEntry) renamePrompt(kind, selectedEntry.id, name);
      return;
    }
    // New starts empty; Duplicate and Save as new copy what the editor shows,
    // so an unsaved draft moves into the copy and the original stays as saved.
    const text = request.type === "new" ? "" : editorText;
    const id = createPrompt(kind, { name, text });
    if (!id) return;
    selectNow(id);
    onEdit?.();
  };

  return {
    kind,
    library,
    selectedId,
    selectedEntry,
    isDefaultSelected,
    isSelectedActive: library.activeId === selectedId,
    savedText,
    editorText,
    isDirty,
    justSaved,
    notice,
    request,
    displayName,
    select,
    setDraft,
    discardDraft: () => setDraftState(null),
    save,
    activateSelected: () => {
      if (isDirty) return;
      activatePrompt(kind, selectedId);
    },
    activateDefault: () => {
      activatePrompt(kind, DEFAULT_PROMPT_ID);
    },
    startNew: () => setRequest({ type: "new", name: t("promptStudio.library.newName") }),
    startDuplicate: () =>
      setRequest({
        type: "duplicate",
        name: copyName(
          isDefaultSelected ? t("promptStudio.library.defaultShort") : displayName(selectedId)
        ),
      }),
    startRename: () => {
      if (selectedEntry) setRequest({ type: "rename", name: selectedEntry.name });
    },
    startSaveAsNew: () =>
      setRequest({ type: "saveAsNew", name: copyName(displayName(selectedId)) }),
    startDelete: () => {
      if (selectedEntry) setRequest({ type: "delete" });
    },
    setRequestName: (name: string) =>
      setRequest((current) => (current && "name" in current ? { ...current, name } : current)),
    confirmRequest,
    cancelRequest: () => setRequest(null),
  };
}

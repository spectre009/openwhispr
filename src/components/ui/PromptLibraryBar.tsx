import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Input } from "./input";
import { ConfirmDialog } from "./dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Copy, Pencil, Plus, RotateCcw, Trash2, CheckCircle, Info, Check, Save } from "../icons";
import {
  DEFAULT_PROMPT_ID,
  PROMPT_NAME_MAX_LENGTH,
  normalizePromptName,
} from "../../config/prompts/library";
import type { PromptLibraryEditor } from "../../hooks/usePromptLibraryEditor";

interface PromptLibraryBarProps {
  editor: PromptLibraryEditor;
  className?: string;
}

const NAME_DIALOG_TITLES = {
  new: "promptStudio.library.dialogs.newTitle",
  duplicate: "promptStudio.library.dialogs.duplicateTitle",
  rename: "promptStudio.library.dialogs.renameTitle",
  saveAsNew: "promptStudio.library.dialogs.saveAsNewTitle",
} as const;

/**
 * Save / Save as new / Discard for the selected prompt's draft. Nothing is
 * written until one of these is clicked.
 */
export function PromptDraftActions({ editor }: { editor: PromptLibraryEditor }) {
  const { t } = useTranslation();
  const canSave = editor.isDirty && editor.editorText.trim().length > 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {editor.isDirty ? (
        <span className="text-xs text-warning">● {t("promptStudio.library.unsaved")}</span>
      ) : (
        editor.justSaved && (
          <span className="flex items-center gap-1 text-xs text-success">
            <Check className="w-3 h-3" />
            {t("promptStudio.library.saved")}
          </span>
        )
      )}
      <span className="flex-1" />
      {editor.isDirty && (
        <Button onClick={editor.discardDraft} variant="ghost" size="sm" className="h-8">
          {t("promptStudio.library.actions.discard")}
        </Button>
      )}
      <Button
        onClick={editor.startSaveAsNew}
        variant="outline"
        size="sm"
        className="h-8"
        disabled={!editor.editorText.trim()}
      >
        {t("promptStudio.library.actions.saveAsNew")}
      </Button>
      <Button onClick={editor.save} size="sm" className="h-8" disabled={!canSave}>
        <Save className="w-3.5 h-3.5" />
        {t("promptStudio.common.save")}
      </Button>
    </div>
  );
}

/**
 * The prompt picker shared by Prompt Studio and the Chat prompt editor: Default
 * first, then the saved prompts (the one in use marked), the library actions,
 * and the "not in use" banner with "Use this prompt".
 */
export default function PromptLibraryBar({ editor, className = "" }: PromptLibraryBarProps) {
  const { t } = useTranslation();
  const { library, selectedEntry, isDefaultSelected, request } = editor;
  const inUseBadge = (
    <span className="ms-2 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-px rounded-full bg-primary/10 text-primary">
      {t("promptStudio.library.inUse")}
    </span>
  );
  const canUseSelected = isDefaultSelected || !!selectedEntry?.text.trim();

  const nameRequest = request && "name" in request ? request : null;
  const nameTitle = nameRequest ? t(NAME_DIALOG_TITLES[nameRequest.type]) : "";
  const nameValid = !!nameRequest && normalizePromptName(nameRequest.name).length > 0;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1 max-w-sm">
          <Select value={editor.selectedId} onValueChange={editor.select}>
            <SelectTrigger
              className="h-9 text-xs"
              aria-label={t("promptStudio.library.pickerLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_PROMPT_ID} className="text-xs">
                <span dir="auto">{editor.displayName(DEFAULT_PROMPT_ID)}</span>
                {library.activeId === DEFAULT_PROMPT_ID && inUseBadge}
              </SelectItem>
              {library.entries.length > 0 && <SelectSeparator />}
              {library.entries.map((entry) => (
                <SelectItem key={entry.id} value={entry.id} className="text-xs">
                  <span dir="auto">{editor.displayName(entry.id)}</span>
                  {library.activeId === entry.id && inUseBadge}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={editor.startDuplicate} variant="ghost" size="sm" className="h-8 px-2">
          <Copy className="w-3.5 h-3.5" />
          {t("promptStudio.library.actions.duplicate")}
        </Button>
        <Button
          onClick={editor.startRename}
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          disabled={isDefaultSelected}
        >
          <Pencil className="w-3.5 h-3.5" />
          {t("promptStudio.library.actions.rename")}
        </Button>
        <Button
          onClick={editor.startDelete}
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-destructive hover:text-destructive"
          disabled={isDefaultSelected}
        >
          <Trash2 className="w-3.5 h-3.5" />
          {t("promptStudio.library.actions.delete")}
        </Button>
        <span className="flex-1" />
        <Button onClick={editor.startNew} variant="outline" size="sm" className="h-8">
          <Plus className="w-3.5 h-3.5" />
          {t("promptStudio.library.actions.new")}
        </Button>
      </div>

      {editor.isSelectedActive ? (
        library.activeId !== DEFAULT_PROMPT_ID && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle className="w-3.5 h-3.5 text-success" />
              {t("promptStudio.library.selectedInUse")}
            </p>
            <Button
              onClick={editor.activateDefault}
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
            >
              <RotateCcw className="w-3 h-3" />
              {t("promptStudio.library.actions.useDefault")}
            </Button>
          </div>
        )
      ) : (
        <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <Info className="w-3.5 h-3.5 text-primary shrink-0" />
            <p dir="auto" className="flex-1 min-w-48 text-xs text-muted-foreground leading-relaxed">
              {t("promptStudio.library.notInUse", {
                active: editor.displayName(library.activeId),
              })}
              {editor.isDirty && <> {t("promptStudio.library.saveFirst")}</>}
              {!editor.isDirty && !canUseSelected && <> {t("promptStudio.library.emptyPrompt")}</>}
            </p>
            <Button
              onClick={editor.activateSelected}
              size="sm"
              className="h-8"
              disabled={editor.isDirty || !canUseSelected}
            >
              {t("promptStudio.library.actions.useThis")}
            </Button>
          </div>
        </div>
      )}

      {editor.notice === "deletedElsewhere" && (
        <p className="mt-2 text-xs text-warning">{t("promptStudio.library.deletedElsewhere")}</p>
      )}

      <ConfirmDialog
        open={!!nameRequest}
        onOpenChange={(open) => !open && editor.cancelRequest()}
        title={nameTitle}
        confirmText={t(
          nameRequest?.type === "rename"
            ? "promptStudio.library.dialogs.renameConfirm"
            : "promptStudio.library.dialogs.createConfirm"
        )}
        cancelText={t("promptStudio.library.dialogs.cancel")}
        confirmDisabled={!nameValid}
        onConfirm={editor.confirmRequest}
      >
        <div className="space-y-1.5">
          <label htmlFor="prompt-library-name" className="text-xs font-medium text-foreground/60">
            {t("promptStudio.library.dialogs.nameLabel")}
          </label>
          <Input
            dir="auto"
            id="prompt-library-name"
            value={nameRequest?.name ?? ""}
            maxLength={PROMPT_NAME_MAX_LENGTH}
            onChange={(event) => editor.setRequestName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && nameValid) {
                event.preventDefault();
                editor.confirmRequest();
              }
            }}
          />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={request?.type === "delete"}
        onOpenChange={(open) => !open && editor.cancelRequest()}
        title={t("promptStudio.library.dialogs.deleteTitle", {
          name: editor.displayName(editor.selectedId),
        })}
        description={
          editor.isSelectedActive
            ? t("promptStudio.library.dialogs.deleteInUseDescription")
            : t("promptStudio.library.dialogs.deleteDescription")
        }
        confirmText={t("promptStudio.library.actions.delete")}
        cancelText={t("promptStudio.library.dialogs.cancel")}
        variant="destructive"
        onConfirm={editor.confirmRequest}
      />

      <ConfirmDialog
        open={request?.type === "discard"}
        onOpenChange={(open) => !open && editor.cancelRequest()}
        title={t("promptStudio.library.dialogs.discardTitle")}
        description={t("promptStudio.library.dialogs.discardDescription", {
          name: editor.displayName(editor.selectedId),
        })}
        confirmText={t("promptStudio.library.actions.discard")}
        cancelText={t("promptStudio.library.dialogs.cancel")}
        variant="destructive"
        onConfirm={editor.confirmRequest}
      />
    </div>
  );
}

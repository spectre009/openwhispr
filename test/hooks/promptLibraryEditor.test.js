const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The prompt library editor behind Prompt Studio and the Chat prompt editor:
// the flow of keeping a saved prompt, making an edited copy, and switching to
// it (Duplicate, Rename, edit, Save, Use this prompt), plus Default staying
// read-only and deletes asking first.

async function mountEditor(t, initialStorage) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", ...initialStorage },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-prompt-editor-hook-" });
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePromptLibraryEditor } = await vite.ssrLoadModule("/hooks/usePromptLibraryEditor.ts");

  const current = { editor: null, edits: 0 };
  function Harness() {
    current.editor = usePromptLibraryEditor("cleanup", {
      uiLanguage: "en",
      onEdit: () => {
        current.edits += 1;
      },
    });
    return null;
  }
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const act = (fn) => React.act(async () => fn(current.editor));
  return { storage, useSettingsStore, current, act, i18n };
}

const library = (useSettingsStore) => useSettingsStore.getState().promptLibraries.cleanup;

test("keep a prompt, make an edited copy, and switch to it", async (t) => {
  const original = "CLEANUP RULES\n\nKNOWN WORDS AND EXPRESSIONS\n- Little Buddy";
  const { storage, useSettingsStore, current, act } = await mountEditor(t, {
    "customPrompt.cleanup": original,
  });

  // The migrated prompt is selected and in use.
  assert.equal(current.editor.selectedId, "migrated");
  assert.equal(current.editor.isSelectedActive, true);
  assert.equal(current.editor.displayName("migrated"), "My prompt");

  // Duplicate: a named copy, selected, opened for editing; the original stays in use.
  await act((editor) => editor.startDuplicate());
  assert.deepEqual(current.editor.request, { type: "duplicate", name: "My prompt (copy)" });
  await act((editor) => editor.setRequestName("Without glossary"));
  await act((editor) => editor.confirmRequest());
  const copyId = current.editor.selectedId;
  assert.notEqual(copyId, "migrated");
  assert.equal(current.edits, 1, "the editor switches to Customize");
  assert.equal(current.editor.isSelectedActive, false);
  assert.equal(current.editor.editorText, original);
  assert.equal(storage.getItem("customPrompt.cleanup"), original);

  // Rename it.
  await act((editor) => editor.startRename());
  await act((editor) => editor.setRequestName("No glossary"));
  await act((editor) => editor.confirmRequest());
  assert.equal(current.editor.displayName(copyId), "No glossary");

  // Edit: a draft only, until Save.
  const edited = "CLEANUP RULES";
  await act((editor) => editor.setDraft(edited));
  assert.equal(current.editor.isDirty, true);
  assert.equal(library(useSettingsStore).entries[1].text, original, "the draft isn't saved");
  // A dirty prompt can't be put in use (the saved text would be, not the draft).
  await act((editor) => editor.activateSelected());
  assert.equal(library(useSettingsStore).activeId, "migrated");

  await act((editor) => editor.save());
  assert.equal(current.editor.isDirty, false);
  assert.equal(current.editor.justSaved, true);
  assert.equal(library(useSettingsStore).entries[1].text, edited);
  assert.equal(storage.getItem("customPrompt.cleanup"), original, "saving doesn't switch");

  // Use this prompt.
  await act((editor) => editor.activateSelected());
  assert.equal(library(useSettingsStore).activeId, copyId);
  assert.equal(storage.getItem("customPrompt.cleanup"), edited);
  assert.equal(useSettingsStore.getState().customPrompts.cleanup, edited);

  // Back to the built-in default in one click, without deleting anything.
  await act((editor) => editor.activateDefault());
  assert.equal(storage.getItem("customPrompt.cleanup"), "");
  assert.deepEqual(
    library(useSettingsStore).entries.map((entry) => entry.name),
    ["My prompt", "No glossary"]
  );
});

test("Default is read-only, and switching away from a draft asks first", async (t) => {
  const { useSettingsStore, current, act, i18n } = await mountEditor(t, {
    "customPrompt.cleanup": "Mine.",
  });

  await act((editor) => editor.select("default"));
  assert.equal(current.editor.isDefaultSelected, true);
  assert.equal(current.editor.savedText, i18n.getFixedT("en", "prompts")("cleanupPrompt"));
  await act((editor) => editor.setDraft("Edited default"));
  assert.equal(current.editor.isDirty, false, "the built-in prompt takes no draft");
  await act((editor) => editor.startRename());
  await act((editor) => editor.startDelete());
  assert.equal(current.editor.request, null, "Default can't be renamed or deleted");

  // Duplicate to customize makes an editable copy of the built-in text.
  await act((editor) => editor.startDuplicate());
  assert.equal(current.editor.request.name, "Default (copy)");
  await act((editor) => editor.confirmRequest());
  assert.equal(current.editor.isDefaultSelected, false);
  assert.equal(current.editor.editorText, current.editor.savedText);

  await act((editor) => editor.setDraft("Changed."));
  await act((editor) => editor.select("migrated"));
  assert.deepEqual(current.editor.request, { type: "discard", nextId: "migrated" });
  await act((editor) => editor.cancelRequest());
  assert.equal(current.editor.isDirty, true, "cancel keeps the draft");
  await act((editor) => editor.select("migrated"));
  await act((editor) => editor.confirmRequest());
  assert.equal(current.editor.selectedId, "migrated");
  assert.equal(current.editor.isDirty, false);
  assert.equal(library(useSettingsStore).entries.length, 2);
});

test("New starts empty and can't be used until it has text; Delete asks first", async (t) => {
  const { useSettingsStore, current, act } = await mountEditor(t, {
    "customPrompt.cleanup": "Mine.",
  });

  await act((editor) => editor.startNew());
  assert.equal(current.editor.request.name, "New prompt");
  await act((editor) => editor.confirmRequest());
  const id = current.editor.selectedId;
  assert.equal(current.editor.editorText, "");
  await act((editor) => editor.activateSelected());
  assert.equal(library(useSettingsStore).activeId, "migrated", "an empty prompt isn't used");

  await act((editor) => editor.setDraft("Fresh rules."));
  await act((editor) => editor.save());
  await act((editor) => editor.activateSelected());
  assert.equal(library(useSettingsStore).activeId, id);

  await act((editor) => editor.startDelete());
  assert.deepEqual(current.editor.request, { type: "delete" });
  assert.equal(library(useSettingsStore).entries.length, 2, "nothing deleted before confirming");
  await act((editor) => editor.confirmRequest());
  assert.equal(library(useSettingsStore).entries.length, 1);
  assert.equal(library(useSettingsStore).activeId, "default", "deleting the one in use");
  assert.equal(current.editor.selectedId, "default");
});

test("a prompt deleted in another window doesn't take the unsaved edits with it", async (t) => {
  const { storage, useSettingsStore, current, act } = await mountEditor(t, {
    "customPrompt.cleanup": "Mine.",
  });
  await act((editor) => editor.setDraft("Mine, edited."));

  // Another window deletes the prompt; this window hasn't heard yet.
  const record = JSON.parse(storage.getItem("promptLibrary.cleanup"));
  storage.setItem(
    "promptLibrary.cleanup",
    JSON.stringify({ ...record, activeId: "default", entries: [] })
  );
  storage.setItem("customPrompt.cleanup", "");

  await act((editor) => editor.save());
  assert.equal(current.editor.notice, "deletedElsewhere");
  const entries = library(useSettingsStore).entries;
  assert.equal(entries.length, 1, "the edits were kept as a new prompt");
  assert.notEqual(entries[0].id, "migrated", "the deleted one wasn't resurrected");
  assert.deepEqual([entries[0].name, entries[0].text], ["My prompt", "Mine, edited."]);
  assert.equal(current.editor.selectedId, entries[0].id);
  assert.equal(storage.getItem("customPrompt.cleanup"), "", "and it isn't put in use");
});

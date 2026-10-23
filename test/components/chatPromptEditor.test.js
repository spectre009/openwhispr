const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// The Chat prompt editor edits a draft: typing writes nothing (no store update,
// no localStorage key, so no cross-window storage events), and only Save writes
// the library record and its cache.

function findAll(node, predicate, found = []) {
  if (!node) return found;
  if (predicate(node)) found.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, found);
  return found;
}

const reactProps = (node) => {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  assert.ok(key, "React props are attached to the host node");
  return node[key];
};

test("the Chat prompt editor writes only on Save, never per keystroke", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", "customPrompt.chatAgent": "Be terse." },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-prompt-editor-",
    mockModules: {
      "/InferenceConfigEditor": "export default function InferenceConfigEditor() { return null; }",
      // Radix Select needs a fuller DOM (a native <select> with options); the
      // picker isn't what this test is about.
      "./select": `
        export const Select = ({ children }) => children;
        export const SelectTrigger = () => null;
        export const SelectValue = () => null;
        export const SelectContent = () => null;
        export const SelectItem = () => null;
        export const SelectSeparator = () => null;
      `,
    },
  });
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { default: ChatAgentSettings } = await vite.ssrLoadModule(
    "/components/settings/ChatAgentSettings.tsx"
  );

  const writes = [];
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    writes.push(key);
    setItem(key, value);
  };
  const recordBefore = storage.getItem("promptLibrary.chatAgent");
  assert.ok(recordBefore, "the migrated library exists");

  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(ChatAgentSettings)));

  const textareas = () => findAll(container, (node) => node.nodeName === "TEXTAREA");
  assert.equal(textareas().length, 1);
  assert.equal(textareas()[0].getAttribute("readonly"), null, "a saved prompt is editable");

  for (const value of ["Be terse. U", "Be terse. Use", "Be terse. Use bullet points."]) {
    await React.act(async () => reactProps(textareas()[0]).onChange({ target: { value } }));
  }

  assert.deepEqual(
    writes.filter((key) => key.includes("chatAgent")),
    [],
    "typing writes no prompt key"
  );
  assert.equal(useSettingsStore.getState().customPrompts.chatAgent, "Be terse.");
  assert.equal(storage.getItem("promptLibrary.chatAgent"), recordBefore);
  assert.ok(container.textContent.includes(i18n.t("promptStudio.library.unsaved")));

  const saveButton = findAll(
    container,
    (node) =>
      node.nodeName === "BUTTON" && node.textContent.trim() === i18n.t("promptStudio.common.save")
  )[0];
  assert.ok(saveButton, "the Save button is shown");
  await React.act(async () => reactProps(saveButton).onClick());

  assert.deepEqual(
    writes.filter((key) => key.includes("chatAgent")),
    ["promptLibrary.chatAgent", "customPrompt.chatAgent"],
    "Save is one write of the record and its cache"
  );
  const library = JSON.parse(storage.getItem("promptLibrary.chatAgent"));
  assert.equal(library.entries[0].text, "Be terse. Use bullet points.");
  assert.equal(storage.getItem("customPrompt.chatAgent"), "Be terse. Use bullet points.");
  assert.equal(useSettingsStore.getState().customPrompts.chatAgent, "Be terse. Use bullet points.");
  assert.ok(!container.textContent.includes(i18n.t("promptStudio.library.unsaved")));
});

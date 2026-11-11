const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// OpenRouter as a speech-to-text provider (#2105, #3016), in the fork's one
// speech-to-text picker (settings/TranscriptionConfigEditor.tsx with
// modelPicker/sttOptions.ts and the custom endpoint's fields,
// SttCustomEndpointFields.tsx), which replaced upstream's TranscriptionModelPicker.

const noop = () => {};
const OPENROUTER_URL = "https://openrouter.ai/api/v1";

function electronApi() {
  const fixed = {
    getPlatform: () => "darwin",
    checkParakeetInstallation: async () => ({ supported: true }),
    listParakeetModels: async () => ({ success: true, models: [] }),
    listWhisperModels: async () => ({ success: true, models: [] }),
  };
  return new Proxy(fixed, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string" && prop.startsWith("on")) return () => noop;
      return async () => undefined;
    },
  });
}

function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (node.props && predicate(node.props)) return node;
  return find(node.props?.children, predicate);
}

const SURFACE_CONTEXT = { dictation: "dictation", fileTranscription: "upload" };
const key = (surface, name) =>
  surface === "fileTranscription" ? `upload${name[0].toUpperCase()}${name.slice(1)}` : name;

// Mounts a component for one surface (called inside a harness so its hooks and
// effects run), wired to the real settings store; returns its element tree.
async function load(t) {
  installBrowserGlobals(t, { window: { location: { search: "" }, electronAPI: electronApi() } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-stt-openrouter-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t(key) { return key; }, i18n: { language: "en" } }; }`,
    },
  });
  const container = installHookDom(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { default: Fields } = await vite.ssrLoadModule(
    "/components/settings/SttCustomEndpointFields.tsx"
  );
  const { default: Editor } = await vite.ssrLoadModule(
    "/components/settings/TranscriptionConfigEditor.tsx"
  );
  const stt = await vite.ssrLoadModule("/components/settings/modelPicker/sttOptions.ts");
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");

  const mount = async (render) => {
    let tree;
    function Harness() {
      tree = render();
      return null;
    }
    const root = createRoot(container);
    await React.act(async () => {
      root.render(
        React.createElement(
          ToastContext.Provider,
          { value: { toast: noop } },
          React.createElement(Harness)
        )
      );
    });
    return { tree: () => tree, unmount: () => React.act(async () => root.unmount()) };
  };
  return { useSettingsStore, Fields, Editor, stt, mount };
}

// Custom endpoints pointed at OpenRouter predate its own entry. Leaving the
// endpoint field must not move them onto it: that swaps their model, reads a
// different key slot and drops the WAV re-encode only Custom applies.
test("leaving a Custom endpoint set to OpenRouter keeps the Custom setup", async (t) => {
  const { useSettingsStore, Fields, stt, mount } = await load(t);
  for (const surface of ["dictation", "fileTranscription"]) {
    useSettingsStore.setState({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      [key(surface, "cloudTranscriptionProvider")]: "custom",
      [key(surface, "cloudTranscriptionModel")]: "microsoft/mai-transcribe-2",
      [key(surface, "cloudTranscriptionBaseUrl")]: OPENROUTER_URL,
    });
    // The picker keeps calling it a custom endpoint, too.
    assert.equal(stt.isCustomTranscriptionUrl(OPENROUTER_URL), true);

    const fields = await mount(() =>
      Fields({ surface, inheritedUrl: "", inheritedModel: "", onModel: noop })
    );
    try {
      const urlInput = find(
        fields.tree(),
        (props) => typeof props.onBlur === "function" && props.value === OPENROUTER_URL
      );
      assert.ok(urlInput, `${surface}: the Custom endpoint field renders`);
      // Focus leaves the field for good: not a window switch, nor a move inside it.
      const leave = {
        currentTarget: { contains: () => false, ownerDocument: { activeElement: null } },
        relatedTarget: null,
      };
      await React.act(async () => urlInput.props.onBlur(leave));

      const state = useSettingsStore.getState();
      assert.equal(state[key(surface, "cloudTranscriptionProvider")], "custom", surface);
      assert.equal(
        state[key(surface, "cloudTranscriptionModel")],
        "microsoft/mai-transcribe-2",
        surface
      );
    } finally {
      await fields.unmount();
    }
  }
});

// OpenRouter's catalog moves faster than our releases, so the store and the
// request resolver keep a vendor-prefixed id the shortlist does not list. The
// picker writes nothing when it opens, and shows that id as the selection.
test("opening Settings keeps an OpenRouter model outside the shortlist", async (t) => {
  const { useSettingsStore, Editor, mount } = await load(t);
  for (const surface of ["dictation", "fileTranscription"]) {
    useSettingsStore.setState({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      openrouterApiKey: "sk-or-test",
      [key(surface, "transcriptionMode")]: "providers",
      [key(surface, "cloudTranscriptionProvider")]: "openrouter",
      [key(surface, "cloudTranscriptionModel")]: "qwen/qwen3-asr-flash-2026-02-10",
    });

    const editor = await mount(() => Editor({ surface }));
    const picker = find(editor.tree(), (props) => props.summary && props.groups);
    await editor.unmount();

    assert.equal(
      useSettingsStore.getState()[key(surface, "cloudTranscriptionModel")],
      "qwen/qwen3-asr-flash-2026-02-10",
      surface
    );
    assert.ok(picker, `${surface}: the picker renders`);
    assert.equal(picker.props.summary.title.text, "qwen/qwen3-asr-flash-2026-02-10", surface);
    const group = picker.props.groups.find((entry) => entry.id === "provider:openrouter");
    assert.equal(group.options[0].model, "qwen/qwen3-asr-flash-2026-02-10", surface);
  }
});

// Deepgram via OpenRouter drops the dictionary, so it is offered for File
// Transcription only. The fork's picker never rewrites a saved choice when it
// opens: a dictation pick of it stays, flagged, and is no longer offered there.
test("Deepgram via OpenRouter: offered for uploads only; a saved dictation pick is flagged", async (t) => {
  const { useSettingsStore, Editor, mount } = await load(t);
  for (const surface of ["dictation", "fileTranscription"]) {
    useSettingsStore.setState({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      openrouterApiKey: "sk-or-test",
      [key(surface, "transcriptionMode")]: "providers",
      [key(surface, "cloudTranscriptionProvider")]: "openrouter",
      [key(surface, "cloudTranscriptionModel")]: "deepgram/nova-3",
    });

    const editor = await mount(() => Editor({ surface }));
    const picker = find(editor.tree(), (props) => props.summary && props.groups);
    await editor.unmount();

    assert.equal(
      useSettingsStore.getState()[key(surface, "cloudTranscriptionModel")],
      "deepgram/nova-3",
      `${SURFACE_CONTEXT[surface]}: nothing is written on open`
    );
    const offered = picker.props.groups
      .find((entry) => entry.id === "provider:openrouter")
      .options.some((option) => option.model === "deepgram/nova-3");
    if (surface === "dictation") {
      assert.equal(offered, false);
      assert.equal(picker.props.summary.warning?.key, "modelPicker.stt.reasons.uploadOnly");
    } else {
      assert.equal(offered, true);
      assert.equal(picker.props.summary.warning, undefined);
    }
  }
});

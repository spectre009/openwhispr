const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

function elements(node, found = []) {
  if (Array.isArray(node)) node.forEach((child) => elements(child, found));
  else if (node?.props) {
    found.push(node);
    elements(node.props.children, found);
  }
  return found;
}

test("equal-generation workspace changes clear credentials and consent and ignore stale setup responses", async (t) => {
  let root;
  t.after(() => root && React.act(async () => root.unmount()));
  const pending = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        enterpriseAudioStatus: (input) =>
          new Promise((resolve) => pending.push({ input, resolve })),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-audio-settings-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "const t=(key)=>key; export function useTranslation(){return {t};}",
    },
  });
  const { useEnterpriseIdentityStore: store } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { EnterpriseAudioSettings } = await vite.ssrLoadModule(
    "/components/settings/EnterpriseAudioSettings.tsx"
  );
  const identity = (workspaceId) => ({
    accountId: "account-a",
    workspaceId,
    authGeneration: 1,
    config: {
      workspaceId,
      generation: 1,
      providers: [{ provider: "openai-compatible", version: 1, config: { batch: {} } }],
    },
  });
  store.setState(identity("workspace-a"));
  let tree;
  function Harness() {
    tree = EnterpriseAudioSettings();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const find = (predicate) => elements(tree).find(predicate);
  const password = () => find((node) => node.props.type === "password");
  const consent = () => find((node) => node.props.ariaLabel === "enterprise.audio.probeConsent");
  const status = {
    success: true,
    slots: [{ slot: "http", present: false }],
    operations: ["batch"],
    configFingerprint: "a".repeat(64),
  };
  await React.act(async () => pending[0].resolve(status));
  await React.act(async () => {
    password().props.onChange({ target: { value: "workspace-a-test-secret" } });
    consent().props.onChange(true);
  });
  assert.equal(password().props.value, "workspace-a-test-secret");
  assert.equal(consent().props.checked, true);
  await React.act(async () => store.setState(identity("workspace-b")));
  assert.equal(consent().props.checked, false);
  assert.equal(password(), undefined);
  assert.equal(pending[1].input.context.workspaceId, "workspace-b");
  await React.act(async () => store.setState(identity("workspace-c")));
  await React.act(async () => pending[1].resolve(status));
  assert.equal(password(), undefined);
  await React.act(async () => pending[2].resolve(status));
  assert.equal(password().props.value, "");
  assert.equal(consent().props.checked, false);

  // A failed probe shows its translated reason, never the raw check code.
  globalThis.window.electronAPI.enterpriseAudioTest = async () => ({
    success: true,
    passed: false,
    code: "TIMEOUT",
    messageKey: "enterprise.audio.checks.timeout",
  });
  await React.act(async () => consent().props.onChange(true));
  await React.act(async () =>
    find((node) => node.props.children === "enterprise.audio.testBatch").props.onClick()
  );
  assert.equal(
    find((node) => node.props.role === "status").props.children,
    "enterprise.audio.checks.timeout"
  );
});

const click = (element) =>
  element.dispatchEvent({
    type: "click",
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  });

// Upstream's mode cards became the fork's speech-to-text picker: while the managed setup
// answers, Live Recording and File Transcription show its card (with the opt-out) instead of
// their picker, and a pick goes through the picker's selection adapter (selectStt.ts).
test("meeting and upload picks leave the shared enterprise setup mode to its explicit controls", async (t) => {
  let root;
  t.after(() => root && React.act(async () => root.unmount()));
  const meetings = [];
  const uploads = [];
  installBrowserGlobals(t, {
    initialStorage: { _providerSettingsMigrated: "1", uploadTranscriptionMigrated: "true" },
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: async (options) => {
          meetings.push(options);
          return { success: false };
        },
        transcribeAudioFile: async (_path, options) => {
          uploads.push(options);
          return { success: true, text: "local" };
        },
        transcribeAudioFileByok: async (options) => {
          uploads.push(options);
          return { success: true, text: "managed" };
        },
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-audio-selection-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      // The picker itself is covered by modelPickerStt*.test.js; here only whether it shows.
      "/TranscriptionConfigEditor": `
        import React from "react";
        export default function Editor({ surface }) {
          return React.createElement("div", { "data-stt-editor": surface });
        }
      `,
      "/EnterpriseAudioSettings": "export function EnterpriseAudioSettings() { return null; }",
    },
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const { getSettings, useSettingsStore, selectResolvedUploadTranscription } =
    await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { isManagedTranscriptionActive } = await vite.ssrLoadModule(
    "/services/managedTranscription.ts"
  );
  const { MeetingTranscriptionPanel } = await vite.ssrLoadModule(
    "/components/settings/MeetingSettings.tsx"
  );
  const { UploadTranscriptionPanel } = await vite.ssrLoadModule(
    "/components/settings/UploadSettings.tsx"
  );
  const { commitSttSelection } = await vite.ssrLoadModule(
    "/components/settings/modelPicker/selectStt.ts"
  );
  const { buildSttPickerOptions } = await vite.ssrLoadModule(
    "/components/settings/modelPicker/sttOptions.ts"
  );
  const { prepareTranscription } = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");
  usePolicyStore.setState({ status: "unmanaged", accountId: "account-a", authGeneration: 1 });
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-a" });
  const record = {
    provider: "openai-compatible",
    mode: "managed_default",
    allowManualSetup: true,
    version: 1,
    config: {
      batch: { defaultDeployment: "company-batch" },
      realtime: { defaultDeployment: "company-realtime" },
    },
  };
  useEnterpriseIdentityStore.setState({
    status: "ready",
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    config: { generation: 1, providers: [record] },
  });
  root = createRoot(container);
  const picker = () =>
    findElement(container, (element) => element.getAttribute?.("data-stt-editor") != null);
  const personalSetup = () =>
    findElement(
      container,
      (element) =>
        element.tagName === "BUTTON" &&
        element.textContent === "settingsPage.aiModels.managedEnterprise.usePersonalSetup"
    );
  const setupMode = () => useSettingsStore.getState().enterpriseTranscriptionSetupMode;
  for (const Panel of [MeetingTranscriptionPanel, UploadTranscriptionPanel]) {
    const meeting = Panel === MeetingTranscriptionPanel;
    const surface = meeting ? "liveRecording" : "fileTranscription";
    const modeKey = meeting ? "meetingTranscriptionMode" : "uploadTranscriptionMode";
    // The picker's context as the editor reads it, with the organization's setup available.
    const pickerContext = () => {
      const { status, policy, appVersion } = usePolicyStore.getState();
      return {
        policy: { status, policy, appVersion },
        cloudDisabled: false,
        isSignedIn: true,
        keys: {},
        localModels: [{ id: "base", engine: "whisper" }],
        managedAvailable: true,
        current: {
          mode: useSettingsStore.getState()[modeKey],
          cloudProvider: "",
          cloudModel: "",
          cloudBaseUrl: "",
          localProvider: "whisper",
          localModel: "base",
          remoteUrl: "",
          remoteModel: "",
        },
      };
    };
    // A pick in the surface's picker, as the editor commits it.
    const pick = (mode, provider = "", model = "") =>
      React.act(async () =>
        commitSttSelection(
          surface,
          { mode, provider, model },
          {
            context: pickerContext(),
            effectiveMode: useSettingsStore.getState()[modeKey],
            store: useSettingsStore.getState,
            requestSignIn() {},
          }
        )
      );
    const enterpriseOffered = () =>
      buildSttPickerOptions(surface, pickerContext()).some((group) => group.id === "enterprise");
    const routedToEnterprise = async () => {
      if (meeting) {
        await prepareTranscription();
        return meetings.at(-1).provider === "enterprise-realtime";
      }
      const settings = selectResolvedUploadTranscription(getSettings());
      await transcribeFile(
        "/recording.wav",
        { ...settings, isOpenWhisprCloud: false, getApiKey: () => "", language: "auto" },
        false
      );
      return Boolean(uploads.at(-1).managed);
    };
    await React.act(async () => {
      useSettingsStore.setState({
        isSignedIn: true,
        meetingFollowsTranscription: false,
        meetingTranscriptionMode: "local",
        uploadTranscriptionMode: "local",
        uploadUseLocalWhisper: true,
        enterpriseTranscriptionSetupMode: "auto",
      });
      useEnterpriseIdentityStore.setState({ config: { generation: 1, providers: [record] } });
      root.render(React.createElement(Panel, { key: surface }));
    });

    // A managed default rollout shows the managed setup and the explicit opt-out, no picker,
    // so no ordinary pick can move dictation or the other context off the gateway.
    assert.equal(picker(), null);
    assert.ok(personalSetup());
    assert.equal(setupMode(), "auto");
    assert.equal(isManagedTranscriptionActive(), true);
    assert.equal(await routedToEnterprise(), true);

    // The explicit opt-out is the only control that selects the personal setup.
    await React.act(async () => click(personalSetup()));
    assert.equal(setupMode(), "manual");
    assert.ok(picker(), "the picker shows under the personal setup");
    assert.equal(enterpriseOffered(), true, "the picker offers the organization's setup back");
    await pick("local", "whisper", "base");
    assert.equal(setupMode(), "manual");
    assert.equal(useSettingsStore.getState()[modeKey], "local");
    assert.equal(await routedToEnterprise(), false);
    if (!meeting) assert.equal(uploads.at(-1).provider, "whisper");

    const cloudModeKey = meeting ? "meetingCloudTranscriptionMode" : "uploadCloudTranscriptionMode";
    const personalCloudMode = useSettingsStore.getState()[cloudModeKey];
    await pick("enterprise");
    assert.equal(setupMode(), "managed");
    assert.equal(picker(), null);
    assert.equal(await routedToEnterprise(), true);

    // Neither pick nor a second enterprise pick overwrites the personal choice, so the
    // opt-out returns to it instead of an unroutable "enterprise".
    await pick("enterprise");
    const personal = useSettingsStore.getState();
    assert.equal(personal[modeKey], "local");
    assert.equal(personal[cloudModeKey], personalCloudMode);
    await React.act(async () => click(personalSetup()));
    assert.ok(picker());
    assert.equal(useSettingsStore.getState()[modeKey], "local");
    assert.equal(await routedToEnterprise(), false);

    // Required profiles win over a stored opt-out and offer no personal setup.
    for (const overrides of [{ mode: "managed_required" }, { allowManualSetup: false }]) {
      await React.act(async () => {
        useSettingsStore.setState({ enterpriseTranscriptionSetupMode: "manual" });
        useEnterpriseIdentityStore.setState({
          config: { generation: 1, providers: [{ ...record, ...overrides }] },
        });
      });
      assert.equal(picker(), null);
      assert.equal(personalSetup(), null);
      assert.equal(await routedToEnterprise(), true);
    }
  }
});

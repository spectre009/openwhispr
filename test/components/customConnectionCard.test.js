const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// The custom connection on AI Connections, rendered in the real Settings
// (happy-dom, stubbed preload standing in for main): with none, Connections
// offers "Add custom connection" and the Recognition row "Save as connection"
// (an Azure operation URL says why it can't); saved and in use, its card under
// In use shows the masked key and "Used by"; a feature holding another key
// shows "different key · Update"; Remove is refused while a feature uses it;
// Replace key names and updates every user; Check connection reports a
// rejected key and remembers deployments; Edit endpoint moves every user
// along; unused, it's a row whose "Manage" opens the same content, and it's
// removed; and a policy allowing no custom endpoint leaves only a note.

const AZURE = "https://littlebuddy-foundry-eus2.openai.azure.com";
const STT_KEY = "stt-SECRETKEY-7777";
const CHAT_KEY = "chat-SECRETKEY-8888";
const NEW_KEY = "replaced-SECRETKEY-9999";
const STT = "CUSTOM_TRANSCRIPTION_API_KEY";
const CHAT = "CHAT_AGENT_CUSTOM_API_KEY";

// Main, as far as the card can tell: the slots it holds and what it answered.
const main = { mismatched: new Set(), check: null, store: null };

let dom;
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      customConnectionCompare: async ({ slots }) =>
        Object.fromEntries(slots.map((slot) => [slot, !main.mismatched.has(slot)])),
      // Main copies, then announces; the store re-reads the connection's key.
      customConnectionCopyKey: async () => {
        main.store.setState({ customConnectionApiKey: STT_KEY });
        return { success: true };
      },
      customConnectionSaveKey: async ({ key }) => {
        main.store.setState({ customConnectionApiKey: key });
        return { success: true };
      },
      customConnectionApplyKey: async () => ({ success: true }),
      customConnectionDeleteKey: async () => {
        main.store.setState({ customConnectionApiKey: "" });
        return { success: true };
      },
      customConnectionCheck: async () => main.check,
    },
  });
});

test.after(async () => {
  await dom.close();
});

test(
  "the custom connection: save from a row, Used by, key mismatch, remove refused, replace, check, edit and policy",
  { timeout: 90000 },
  async (t) => {
    const consoleOutput = captureConsole(t);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const h = React.createElement;
    const win = dom.window;
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-custom-connection-card-",
      resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    });
    await vite.ssrLoadModule("/i18n.ts");
    const { default: SettingsModal } = await vite.ssrLoadModule("/components/SettingsModal.tsx");
    const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
    const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const { maskApiKey } = await vite.ssrLoadModule("/utils/maskApiKey.ts");
    const { default: reasoningService } = await vite.ssrLoadModule("/services/ReasoningService.ts");
    t.after(() => reasoningService.destroy());
    main.store = useSettingsStore;
    win.HTMLElement.prototype.scrollIntoView = () => {};

    const doc = win.document;
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const root = createRoot(host);
    t.after(async () => {
      await React.act(async () => root.unmount());
      host.remove();
    });
    const act = async (fn, ms = 30) => {
      await React.act(async () => {
        await fn();
        await settle(ms);
      });
      await settle();
    };
    const calls = (name) => dom.calls.filter(([called]) => called === name).map(([, args]) => args);
    const page = () => doc.querySelector('[data-settings-page-id="connections"]');
    // The connection's one anchor: its card, its row, "Add custom connection" or the policy note.
    const group = () => page().querySelector('[data-setting-id="connections.custom"]');
    // The card's content: on the card, or under the row once "Manage" opens it.
    const card = () => group().querySelector("[data-custom-connection]");
    const endpoints = () => page().querySelector('[data-setting-id="connections.endpoints"]');
    const dialog = (selector) => doc.querySelector(selector);
    const buttonIn = (scope, text) =>
      [...scope.querySelectorAll("button")].find((button) => button.textContent.trim() === text);
    const noRawSecret = (when) => {
      const html = doc.documentElement.outerHTML;
      const values = [...doc.querySelectorAll("input, textarea")].map((input) => input.value);
      for (const secret of [STT_KEY, CHAT_KEY, NEW_KEY]) {
        assert.ok(!html.includes(secret), `${when}: ${secret} rendered`);
        assert.ok(!values.some((value) => value.includes(secret)), `${when}: ${secret} in a field`);
      }
    };
    const type = async (input, text) => {
      await act(() => {
        const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
        setter.call(input, text);
        input.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
    };

    await act(() =>
      root.render(
        h(
          ToastProvider,
          null,
          h(
            SettingsProvider,
            null,
            h(SettingsModal, {
              open: true,
              request: { section: "connections", id: 1 },
              onRequestClose: () => true,
              railItems: [],
              activeView: "home",
              onSelectView: () => {},
              onOpenSearch: () => {},
              onOpenElsewhere: () => {},
            })
          )
        )
      )
    );
    // Recognition and Chat on Little Buddy with the same key (as hydration
    // leaves them), File Transcription pinned to a deployment URL. The voice
    // assistant has no model of its own, so it answers through Chat.
    await act(() =>
      useSettingsStore.setState({
        customConnection: null,
        customConnectionApiKey: "",
        customTranscriptionApiKey: STT_KEY,
        chatAgentCustomApiKey: STT_KEY,
        transcriptionMode: "providers",
        cloudTranscriptionMode: "byok",
        cloudTranscriptionProvider: "custom",
        cloudTranscriptionModel: "gpt-4o-transcribe",
        cloudTranscriptionBaseUrl: `${AZURE}/`,
        meetingTranscriptionMode: "local",
        meetingLocalTranscriptionProvider: "whisper",
        uploadTranscriptionMode: "providers",
        uploadCloudTranscriptionProvider: "custom",
        uploadCloudTranscriptionModel: "gpt-4o-transcribe",
        uploadCloudTranscriptionBaseUrl: `${AZURE}/openai/deployments/stt/audio/transcriptions?api-version=2025-03-01-preview`,
        cleanupMode: "providers",
        cleanupProvider: "openai",
        cleanupModel: "gpt-5-mini",
        chatAgentMode: "providers",
        chatAgentProvider: "custom",
        chatAgentModel: "gpt-5-mini",
        chatAgentCloudBaseUrl: `${AZURE}/openai/v1`,
      })
    );

    // ── No connection yet ────────────────────────────────────────────────────
    assert.ok(group(), "the group is always rendered");
    assert.ok(group().querySelector("[data-custom-connection-add]"), "Add custom connection");
    assert.equal(card(), null);
    const recognitionRow = endpoints().querySelector('[data-endpoint-feature="recognition"]');
    assert.ok(recognitionRow.querySelector('[data-save-as-connection="recognition"]'));
    const uploadRow = endpoints().querySelector('[data-endpoint-feature="fileTranscription"]');
    assert.equal(uploadRow.querySelector("[data-save-as-connection]"), null);
    assert.ok(
      uploadRow.querySelector('[data-save-as-refused="azureResourceOnly"]'),
      "an operation URL says why it can't be saved"
    );
    noRawSecret("before saving");

    // ── Save as connection, from Recognition ─────────────────────────────────
    await act(() =>
      recognitionRow.querySelector('[data-save-as-connection="recognition"]').click()
    );
    const saveAs = dialog('[data-custom-connection-dialog="saveAs"]');
    assert.ok(saveAs, "the Save as connection dialog");
    const [nameField, endpointField] = saveAs.querySelectorAll("input");
    assert.equal(nameField.value, "littlebuddy-foundry-eus2");
    assert.equal(endpointField.value, AZURE, "prefilled with the resource origin");
    assert.ok(
      saveAs
        .querySelector('[data-endpoint-preview="azure"]')
        .textContent.includes(`${AZURE}/openai/v1`)
    );
    assert.ok(saveAs.querySelector("[data-source-key]").textContent.includes(maskApiKey(STT_KEY)));
    noRawSecret("in the dialog");
    await type(nameField, "Little Buddy");
    await act(() => saveAs.querySelector("[data-dialog-save]").click());
    assert.deepEqual(calls("customConnectionCopyKey"), [[{ fromSlot: STT }]]);
    assert.equal(calls("customConnectionSaveKey").length, 0);
    const saved = useSettingsStore.getState().customConnection;
    assert.equal(saved.name, "Little Buddy");
    assert.equal(saved.endpoint, AZURE);
    assert.deepEqual(saved.models, { language: ["gpt-5-mini"], speech: ["gpt-4o-transcribe"] });
    assert.equal(win.localStorage.getItem("customConnection"), JSON.stringify(saved));
    assert.equal(dialog("[data-custom-connection-dialog]"), null, "the dialog closed");

    // ── The card: in use, so under In use ────────────────────────────────────
    assert.ok(card(), "the card");
    assert.ok(group().hasAttribute("data-connection-card"));
    assert.equal(
      page().querySelector(
        '[data-connection-group="inUse"] [data-setting-id="connections.custom"]'
      ),
      group(),
      "among the connections in use"
    );
    assert.equal(group().querySelector("[data-custom-connection-add]"), null);
    assert.ok(card().textContent.includes("Little Buddy"));
    assert.ok(card().querySelector('[data-custom-connection-kind="azure"]'));
    assert.ok(card().textContent.includes("littlebuddy-foundry-eus2.openai.azure.com"));
    assert.ok(
      card().querySelector("[data-custom-connection-key]").textContent.includes(maskApiKey(STT_KEY))
    );
    const usedBy = () =>
      [...card().querySelectorAll("[data-connection-use]")].map((chip) =>
        chip.getAttribute("data-connection-use")
      );
    assert.deepEqual(usedBy(), ["recognition", "assistant", "chat", "fileTranscription"]);
    assert.ok(
      card()
        .querySelector("[data-custom-connection-models]")
        .textContent.includes("gpt-4o-transcribe")
    );
    assert.equal(card().querySelector("[data-key-mismatch]"), null, "every key matches");
    // The rows it covers moved to the card.
    assert.equal(endpoints().querySelector('[data-endpoint-feature="recognition"]'), null);
    assert.ok(
      endpoints().textContent.includes("Every custom endpoint in use goes through Little Buddy.")
    );
    assert.equal(endpoints().querySelector("[data-save-as-connection]"), null);
    noRawSecret("on the card");

    // ── Chat holds another key: "different key · Update" ─────────────────────
    main.mismatched = new Set([CHAT]);
    await act(() => useSettingsStore.setState({ chatAgentCustomApiKey: CHAT_KEY }));
    const chat = card().querySelector('[data-connection-use="chat"]');
    assert.ok(chat.hasAttribute("data-key-mismatch"));
    assert.ok(chat.textContent.includes("different key"));
    assert.ok(chat.textContent.includes("Update"));
    assert.equal(
      card().querySelector('[data-connection-use="recognition"]').hasAttribute("data-key-mismatch"),
      false
    );
    await act(() => chat.querySelector(`[data-key-update="${CHAT}"]`).click());
    assert.deepEqual(calls("customConnectionApplyKey"), [[{ slots: [CHAT] }]]);
    noRawSecret("with a mismatch");

    // ── Remove is refused while features use it ──────────────────────────────
    const openMenu = () =>
      act(() =>
        card()
          .querySelector("[data-custom-connection-menu]")
          .dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      );
    await openMenu();
    await act(() => doc.querySelector("[data-custom-connection-remove]").click());
    const inUse = dialog("[data-custom-connection-in-use]");
    assert.ok(inUse, "the in-use dialog");
    assert.deepEqual(
      [...inUse.querySelectorAll("[data-in-use-feature]")].map((link) =>
        link.getAttribute("data-in-use-feature")
      ),
      ["recognition", "assistant", "chat", "fileTranscription"]
    );
    assert.equal(calls("customConnectionDeleteKey").length, 0, "nothing deleted");
    assert.ok(useSettingsStore.getState().customConnection, "still there");
    await act(() => buttonIn(inUse, "Close").click());
    assert.equal(dialog("[data-custom-connection-in-use]"), null);

    // ── Replace key: names every user, updates their slots ───────────────────
    await act(() => card().querySelector("[data-custom-connection-replace]").click());
    const replace = dialog("[data-custom-connection-replace-dialog]");
    assert.deepEqual(
      [...replace.querySelectorAll("[data-replace-feature]")].map((chip) =>
        chip.getAttribute("data-replace-feature")
      ),
      ["recognition", "assistant", "chat", "fileTranscription"]
    );
    const field = replace.querySelector('input[type="password"]');
    assert.equal(field.value, "", "starts empty");
    await type(field, NEW_KEY);
    await act(() => replace.querySelector("[data-replace-confirm]").click());
    assert.deepEqual(calls("customConnectionSaveKey"), [[{ key: NEW_KEY, applyTo: [STT, CHAT] }]]);
    assert.equal(dialog("[data-custom-connection-replace-dialog]"), null, "closed");
    noRawSecret("after replacing");

    // ── Check connection: a rejected key ─────────────────────────────────────
    main.check = { status: "auth", httpStatus: 401, discovery: "unavailable" };
    await act(() => card().querySelector("[data-custom-connection-check]").click());
    assert.deepEqual(calls("customConnectionCheck").at(-1), [{ endpoint: AZURE }]);
    const result = card().querySelector('[data-check-status="auth"]');
    assert.ok(result.textContent.includes("Key rejected (401)"));
    assert.ok(result.textContent.includes("Recognition"), "names what fails");
    // Deployments found join the remembered models.
    main.check = {
      status: "ok",
      discovery: "listed",
      deployments: [{ id: "gpt-4.1-mini", model: "gpt-4.1-mini-2025-04-14" }],
    };
    await act(() => card().querySelector("[data-custom-connection-check]").click());
    assert.ok(
      card().querySelector('[data-check-status="ok"]').textContent.includes("gpt-4.1-mini")
    );
    assert.deepEqual(useSettingsStore.getState().customConnection.models.language, [
      "gpt-5-mini",
      "gpt-4.1-mini",
    ]);

    // ── Edit endpoint: every feature on it moves along, models and keys kept ─
    await openMenu();
    const menuItem = (text) =>
      [...doc.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.textContent.trim() === text
      );
    await act(() => menuItem("Edit endpoint").click());
    const edit = dialog('[data-custom-connection-dialog="edit"]');
    assert.ok(edit, "the edit dialog");
    assert.equal(edit.querySelector('input[type="password"]'), null, "no key field");
    const NEXT = "https://littlebuddy-westus.openai.azure.com";
    await type(edit.querySelectorAll("input")[1], `${NEXT}/openai/v1/`);
    await act(() => edit.querySelector("[data-dialog-save]").click());
    const moved = useSettingsStore.getState();
    assert.equal(moved.customConnection.endpoint, NEXT);
    assert.equal(moved.customConnection.name, "Little Buddy");
    assert.equal(moved.cloudTranscriptionBaseUrl, NEXT);
    assert.equal(moved.chatAgentCloudBaseUrl, `${NEXT}/openai/v1`);
    assert.equal(
      moved.uploadCloudTranscriptionBaseUrl,
      `${NEXT}/openai/deployments/stt/audio/transcriptions?api-version=2025-03-01-preview`
    );
    assert.equal(moved.chatAgentModel, "gpt-5-mini");
    assert.equal(moved.cloudTranscriptionProvider, "custom");
    assert.equal(win.localStorage.getItem("cloudTranscriptionBaseUrl"), NEXT);
    assert.deepEqual(usedBy(), ["recognition", "assistant", "chat", "fileTranscription"]);
    assert.ok(card().textContent.includes("littlebuddy-westus.openai.azure.com"));

    // ── Unused, it can be removed: key first, then the setting ───────────────
    await act(() =>
      useSettingsStore.setState({
        cloudTranscriptionProvider: "groq",
        uploadCloudTranscriptionProvider: "openai",
        chatAgentProvider: "openai",
      })
    );
    // Saved during this visit, it follows its live group: a row under Saved, not in use.
    assert.ok(group().hasAttribute("data-connection-row"), "a row now");
    assert.equal(
      page().querySelector(
        '[data-connection-group="saved"] [data-setting-id="connections.custom"]'
      ),
      group()
    );
    assert.ok(group().textContent.includes("Little Buddy"));
    assert.ok(group().querySelector('[data-custom-connection-kind="azure"]'));
    assert.ok(group().textContent.includes("littlebuddy-westus.openai.azure.com"));
    assert.equal(card(), null, "closed");
    const toggle = group().querySelector("[data-connection-toggle]");
    assert.equal(toggle.textContent.trim(), "Manage");
    await act(() => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.ok(card(), "Manage opens the card's content under the row");
    assert.deepEqual(usedBy(), []);
    noRawSecret("in the row");
    await openMenu();
    await act(() => doc.querySelector("[data-custom-connection-remove]").click());
    const confirm = [...doc.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(
      (element) => element.textContent.includes("Remove Little Buddy?")
    );
    assert.ok(confirm, "a confirmation");
    await act(() => buttonIn(confirm, "Remove").click());
    assert.equal(calls("customConnectionDeleteKey").length, 1);
    assert.equal(useSettingsStore.getState().customConnection, null);
    assert.equal(win.localStorage.getItem("customConnection"), "null");
    assert.ok(group().querySelector("[data-custom-connection-add]"), "back to Add");

    // ── A policy that allows no custom endpoint: said, and nothing to set up ─
    const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
    const scope = (allowedByokProviders) => ({
      allowedModes: ["providers", "local"],
      allowedByokProviders,
    });
    await act(() =>
      usePolicyStore.setState({
        status: "managed",
        appVersion: "1.10.3",
        policy: {
          version: 1,
          transcription: scope(["groq", "openai"]),
          llm: { ...scope(["openai"]), allowedEnterpriseProviders: [] },
          features: { agentEnabled: true, webSearchEnabled: true, screenContextEnabled: true },
          sharing: { externalLinkSharing: "allowed" },
          dataRetention: {
            audioRetentionMaxDays: null,
            localHistoryMode: "user_choice",
            cloudBackupAllowed: true,
          },
          minAppVersion: null,
        },
      })
    );
    assert.ok(group(), "still a search target");
    assert.equal(group().querySelector("[data-custom-connection-add]"), null);
    assert.ok(group().querySelector("[data-custom-connection-managed]"));

    assert.deepEqual(consoleOutput.errors, [], "nothing logged an error");
  }
);

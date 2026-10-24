const nodeTest = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The language-model picker's options (settings/modelPicker/options.ts), per
// scope × policy × sign-in × Cloud switch × Copilot × keys × local models: what
// policy and `allowedModes` rule out is hidden, as the old editor hid it; what
// the user can fix is listed unavailable with its reason and a link; nothing
// else is offered or taken away.

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };

const managedPolicy = (llm = {}) => ({
  status: "managed",
  appVersion: "1.10.3",
  policy: {
    version: 1,
    transcription: { allowedModes: ["providers"], allowedByokProviders: ["groq"] },
    llm: {
      allowedModes: ["openwhispr", "providers", "local", "self-hosted", "enterprise"],
      allowedByokProviders: ["openai", "anthropic", "groq", "copilot", "custom", "openrouter"],
      allowedEnterpriseProviders: ["bedrock"],
      ...llm,
    },
    features: { agentEnabled: true, webSearchEnabled: true, screenContextEnabled: true },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    minAppVersion: null,
  },
});

const SCOPES = [
  "dictationCleanup",
  "dictationAgent",
  "dictationAgentVision",
  "dictationTranslation",
  "noteFormatting",
  "chatIntelligence",
];
const COPILOT_SCOPES = new Set(["dictationCleanup", "noteFormatting", "dictationTranslation"]);
const ALL_KEYS = {
  openai: true,
  anthropic: true,
  gemini: true,
  groq: true,
  openrouter: true,
  tinfoil: true,
  corti: true,
};
const COPILOT_MODELS = [
  { id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
];

// Cases run as subtests of one test, which owns the browser globals and Vite.
const subtests = [];
const test = (name, fn) => subtests.push([name, fn]);

let lib;
let registry;

async function load(t) {
  if (lib) return lib;
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-model-picker-options-" });
  registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");
  lib = await vite.ssrLoadModule("/components/settings/modelPicker/options.ts");
  return lib;
}

const LOCAL_MODEL = () => {
  const provider = registry.modelRegistry.getAllProviders()[0];
  return { provider: provider.id, model: provider.models[0] };
};

function context(scope, overrides = {}) {
  return {
    policy: UNMANAGED,
    cloudDisabled: false,
    isSignedIn: true,
    allowedModes: scope === "dictationAgentVision" ? ["providers"] : undefined,
    keys: ALL_KEYS,
    copilot: { signedIn: true, login: "octocat", models: COPILOT_MODELS },
    localModels: [],
    current: { mode: "providers", provider: "groq", model: "llama-3.3-70b-versatile" },
    managedDeployment: null,
    ...overrides,
  };
}

const groupIds = (groups) => groups.map((group) => group.id);
const find = (groups, id) => groups.flatMap((group) => group.options).find((o) => o.id === id);

test("a full setup offers every connection, all pickable, in order", async (t) => {
  const { buildModelPickerOptions } = await load(t);
  const { provider, model } = LOCAL_MODEL();
  const groups = buildModelPickerOptions(
    "dictationCleanup",
    context("dictationCleanup", { localModels: [{ id: model.id, name: model.name }] })
  );
  assert.deepEqual(groupIds(groups), [
    "cloud",
    "copilot",
    "provider:openai",
    "provider:anthropic",
    "provider:gemini",
    "provider:groq",
    "provider:openrouter",
    "provider:tinfoil",
    "provider:corti",
    "custom",
    "local",
    "selfHosted",
    "enterprise",
  ]);
  for (const group of groups) {
    for (const option of group.options) assert.equal(option.available, true, option.id);
  }
  const cloud = find(groups, "cloud");
  assert.deepEqual(
    [cloud.mode, cloud.cloudMode, cloud.provider, cloud.model],
    ["openwhispr", "openwhispr", "", ""],
    "Cloud is Automatic, with no model"
  );
  const local = find(groups, `local:${model.id}`);
  assert.deepEqual(
    [local.mode, local.cloudMode, local.provider, local.model],
    ["local", "byok", provider, model.id]
  );
  const groq = find(groups, "provider:groq:llama-3.3-70b-versatile");
  assert.deepEqual([groq.mode, groq.cloudMode, groq.provider], ["providers", "byok", "groq"]);
  assert.equal(find(groups, "custom").action, "configureCustom");
  assert.equal(find(groups, "selfHosted").action, "configureSelfHosted");
  assert.equal(find(groups, "enterprise").action, "configureEnterprise");
  assert.equal(find(groups, "openrouter:search").action, "searchOpenRouter");
  assert.deepEqual(find(groups, "local:download").link, {
    kind: "settings",
    destination: "connections#connections.localModels",
    labelKey: "modelPicker.links.openLocalModels",
  });
});

test("Copilot: offered on its scopes, listed unavailable elsewhere, sign-in when signed out", async (t) => {
  const { buildModelPickerOptions } = await load(t);
  for (const scope of SCOPES) {
    for (const signedIn of [true, false]) {
      const groups = buildModelPickerOptions(
        scope,
        context(scope, { copilot: { signedIn, login: "octocat", models: COPILOT_MODELS } })
      );
      const copilot = groups.find((group) => group.id === "copilot");
      const label = `${scope}, signed ${signedIn ? "in" : "out"}`;
      if (!COPILOT_SCOPES.has(scope)) {
        assert.deepEqual(
          copilot.options.map((o) => [o.id, o.available]),
          [["copilot:unsupported", { reasonKey: "modelPicker.reasons.copilotScope" }]],
          label
        );
      } else if (signedIn) {
        assert.deepEqual(
          copilot.options.map((o) => [o.id, o.available]),
          [
            ["copilot:claude-haiku-5.5", true],
            ["copilot:gpt-6-luna", true],
          ],
          label
        );
        assert.equal(copilot.meta.text, "@octocat");
      } else {
        assert.deepEqual(
          copilot.options.map((o) => [o.id, o.available]),
          [
            [
              "copilot:signIn",
              {
                reasonKey: "modelPicker.reasons.copilotSignedOut",
                link: {
                  kind: "settings",
                  destination: "connections#connections.copilot",
                  labelKey: "modelPicker.links.signInCopilot",
                },
              },
            ],
          ],
          label
        );
      }
    }
  }
});

test("while the Copilot sign-in is still being read, Copilot is neither offered nor flagged", async (t) => {
  const { buildModelPickerOptions, describePickerSelection } = await load(t);
  const copilot = { signedIn: false, checking: true, models: COPILOT_MODELS };
  const current = { mode: "providers", provider: "copilot", model: "claude-haiku-5.5" };
  const ctx = context("dictationCleanup", { copilot, current });
  const group = buildModelPickerOptions("dictationCleanup", ctx).find((g) => g.id === "copilot");
  assert.deepEqual(
    group.options.map((o) => [o.id, o.available]),
    [["copilot:checking", { reasonKey: "reasoning.copilot.loading" }]]
  );
  assert.equal(describePickerSelection("dictationCleanup", ctx).warning, undefined);
  // Chat still says why it can't use Copilot at all.
  assert.deepEqual(
    buildModelPickerOptions("chatIntelligence", context("chatIntelligence", { copilot }))
      .find((g) => g.id === "copilot")
      .options.map((o) => o.id),
    ["copilot:unsupported"]
  );
});

test("a saved Copilot pick the live list doesn't carry stays listed and selected", async (t) => {
  const { buildModelPickerOptions, selectedOptionId } = await load(t);
  const current = { mode: "providers", provider: "copilot", model: "mai-code-2-flash" };
  const groups = buildModelPickerOptions(
    "dictationCleanup",
    context("dictationCleanup", { current })
  );
  assert.equal(selectedOptionId(current), "copilot:mai-code-2-flash");
  assert.equal(find(groups, "copilot:mai-code-2-flash").available, true);
});

test("OpenWhispr Cloud: off → Privacy & Data, signed out → sign in, policy → hidden", async (t) => {
  const { buildModelPickerOptions } = await load(t);
  for (const scope of SCOPES) {
    const offered = scope !== "dictationAgentVision";
    const off = find(
      buildModelPickerOptions(scope, context(scope, { cloudDisabled: true, isSignedIn: false })),
      "cloud"
    );
    const signedOut = find(
      buildModelPickerOptions(scope, context(scope, { isSignedIn: false })),
      "cloud"
    );
    const signedIn = find(buildModelPickerOptions(scope, context(scope)), "cloud");
    if (!offered) {
      assert.equal(off, undefined, "the vision override offers API-key providers only");
      assert.equal(signedOut, undefined);
      assert.equal(signedIn, undefined);
      continue;
    }
    assert.deepEqual(off.available, {
      reasonKey: "modelPicker.reasons.cloudOff",
      link: {
        kind: "settings",
        destination: "privacyData#privacy.cloud",
        labelKey: "modelPicker.links.openPrivacy",
      },
    });
    assert.deepEqual(signedOut.available, {
      reasonKey: "modelPicker.reasons.signedOut",
      link: { kind: "signIn", labelKey: "modelPicker.links.signIn" },
    });
    assert.equal(signedIn.available, true);

    // A policy without Cloud hides it, whatever the switch says.
    const noCloud = managedPolicy({ allowedModes: ["providers", "local"] });
    for (const cloudDisabled of [true, false]) {
      const groups = buildModelPickerOptions(
        scope,
        context(scope, { policy: noCloud, cloudDisabled })
      );
      assert.equal(find(groups, "cloud"), undefined, `${scope}: policy hides Cloud`);
    }
  }
});

test("API keys: connected providers first, the rest listed with Add an API key", async (t) => {
  const { buildModelPickerOptions } = await load(t);
  for (const scope of SCOPES) {
    const groups = buildModelPickerOptions(
      scope,
      context(scope, { keys: { groq: true, openrouter: true } })
    );
    const ids = groupIds(groups);
    const at = (id) => ids.indexOf(id);
    assert.ok(at("provider:groq") < at("custom"), `${scope}: connected before Custom`);
    assert.ok(at("provider:openrouter") < at("custom"), scope);
    for (const provider of ["openai", "anthropic", "gemini", "tinfoil", "corti"]) {
      assert.ok(at(`provider:${provider}`) > at("custom"), `${scope}: ${provider} after Custom`);
      const group = groups.find((entry) => entry.id === `provider:${provider}`);
      assert.deepEqual(
        group.options.map((o) => [o.id, o.available]),
        [
          [
            `provider:${provider}:addKey`,
            {
              reasonKey: "modelPicker.reasons.noKey",
              link: {
                kind: "settings",
                destination: `connections#connections.${provider}`,
                labelKey: "modelPicker.links.addKey",
              },
            },
          ],
        ],
        `${scope}: ${provider}`
      );
    }
    assert.ok(
      groups
        .find((entry) => entry.id === "provider:groq")
        .options.every((o) => o.available === true && o.provider === "groq")
    );
  }
});

test("OpenRouter lists the current model and a catalog search, not its catalog", async (t) => {
  const { buildModelPickerOptions } = await load(t);
  const current = {
    mode: "providers",
    provider: "openrouter",
    model: "google/gemini-3.5-flash-lite",
  };
  const group = buildModelPickerOptions(
    "chatIntelligence",
    context("chatIntelligence", { current })
  ).find((entry) => entry.id === "provider:openrouter");
  assert.deepEqual(
    group.options.map((o) => [o.id, o.model, o.action ?? null]),
    [
      ["openrouter:google/gemini-3.5-flash-lite", "google/gemini-3.5-flash-lite", null],
      ["openrouter:search", "", "searchOpenRouter"],
    ]
  );
});

test("Tinfoil lists its live catalog", async (t) => {
  const { buildModelPickerOptions } = await load(t);
  const groups = buildModelPickerOptions(
    "dictationCleanup",
    context("dictationCleanup", { tinfoilModels: [{ id: "live-model", name: "Live Model" }] })
  );
  assert.deepEqual(
    groups.find((entry) => entry.id === "provider:tinfoil").options.map((o) => o.id),
    ["provider:tinfoil:live-model"]
  );
});

test("the vision override offers API-key providers and Custom only", async (t) => {
  const { buildModelPickerOptions } = await load(t);
  const { model } = LOCAL_MODEL();
  const groups = buildModelPickerOptions(
    "dictationAgentVision",
    context("dictationAgentVision", {
      localModels: [{ id: model.id, name: model.name }],
      managedDeployment: { provider: "bedrock", model: "x" },
    })
  );
  assert.deepEqual(groupIds(groups), [
    "copilot",
    "provider:openai",
    "provider:anthropic",
    "provider:gemini",
    "provider:groq",
    "provider:openrouter",
    "provider:tinfoil",
    "provider:corti",
    "custom",
  ]);
  for (const option of groups.flatMap((group) => group.options)) {
    assert.equal(option.mode, "providers", option.id);
  }
});

test("local: downloaded models only, plus Download more models", async (t) => {
  const { buildModelPickerOptions, pickAvailability } = await load(t);
  const provider = registry.modelRegistry.getAllProviders()[0];
  const [downloaded, notDownloaded] = provider.models;
  const ctx = context("dictationCleanup", {
    localModels: [
      { id: downloaded.id, name: downloaded.name },
      { id: "not-in-the-registry", name: "Stray" },
    ],
  });
  const local = buildModelPickerOptions("dictationCleanup", ctx).find((g) => g.id === "local");
  assert.deepEqual(
    local.options.map((o) => o.id),
    [`local:${downloaded.id}`, "local:download"]
  );
  assert.equal(
    pickAvailability(
      "dictationCleanup",
      { mode: "local", provider: provider.id, model: notDownloaded.id },
      ctx
    ),
    null,
    "a model that isn't downloaded can't be picked"
  );
  const none = buildModelPickerOptions(
    "dictationCleanup",
    context("dictationCleanup", { localModels: [] })
  ).find((g) => g.id === "local");
  assert.deepEqual(
    none.options.map((o) => [o.id, o.label.key]),
    [["local:download", "modelPicker.local.download"]]
  );
});

test("policy: forbidden providers and modes are hidden, enterprise follows its allowlist", async (t) => {
  const { buildModelPickerOptions } = await load(t);
  const policy = managedPolicy({
    allowedModes: ["providers", "enterprise"],
    allowedByokProviders: ["openai", "copilot"],
    allowedEnterpriseProviders: ["bedrock"],
  });
  for (const scope of ["dictationCleanup", "chatIntelligence"]) {
    const groups = buildModelPickerOptions(scope, context(scope, { policy }));
    assert.deepEqual(
      groupIds(groups),
      ["copilot", "provider:openai", "enterprise"],
      `${scope}: Cloud, local, self-hosted, Custom and other providers are hidden`
    );
    const copilot = groups.find((group) => group.id === "copilot").options;
    assert.equal(
      copilot[0].available === true,
      scope === "dictationCleanup",
      `${scope}: Copilot pickable only where it can serve`
    );
  }

  // No enterprise provider allowed: no enterprise group.
  const noEnterprise = managedPolicy({ allowedEnterpriseProviders: [] });
  assert.equal(
    find(
      buildModelPickerOptions(
        "dictationCleanup",
        context("dictationCleanup", { policy: noEnterprise })
      ),
      "enterprise"
    ),
    undefined
  );

  // Chat with only Copilot allowed has no API-key mode at all (Copilot can't serve it).
  const copilotOnly = managedPolicy({
    allowedModes: ["providers"],
    allowedByokProviders: ["copilot"],
  });
  assert.deepEqual(
    buildModelPickerOptions(
      "chatIntelligence",
      context("chatIntelligence", { policy: copilotOnly })
    ),
    []
  );
  assert.deepEqual(
    groupIds(
      buildModelPickerOptions(
        "dictationCleanup",
        context("dictationCleanup", { policy: copilotOnly })
      )
    ),
    ["copilot"]
  );

  // While the policy is loading or failed, nothing is offered.
  for (const status of ["loading", "error"]) {
    const groups = buildModelPickerOptions(
      "dictationCleanup",
      context("dictationCleanup", { policy: { status, policy: null, appVersion: "1.10.3" } })
    );
    assert.deepEqual(groups, [], status);
  }
});

test("the organization's managed deployment is offered while the setup mode is manual", async (t) => {
  const { buildModelPickerOptions } = await load(t);
  const groups = buildModelPickerOptions(
    "dictationCleanup",
    context("dictationCleanup", {
      managedDeployment: { provider: "bedrock", model: "anthropic.claude-sonnet-4-20250514-v1:0" },
    })
  );
  const enterprise = groups.find((group) => group.id === "enterprise");
  assert.deepEqual(
    enterprise.options.map((o) => [o.id, o.action]),
    [
      ["enterprise:managed", "useManaged"],
      ["enterprise", "configureEnterprise"],
    ]
  );
});

test("the selection marks its option and the button describes it", async (t) => {
  const { selectedOptionId, describePickerSelection } = await load(t);
  const cases = [
    [{ mode: "openwhispr", provider: "", model: "" }, "cloud"],
    [
      { mode: "providers", provider: "copilot", model: "claude-haiku-5.5" },
      "copilot:claude-haiku-5.5",
    ],
    [{ mode: "providers", provider: "groq", model: "x" }, "provider:groq:x"],
    [{ mode: "providers", provider: "openrouter", model: "a/b" }, "openrouter:a/b"],
    [{ mode: "providers", provider: "custom", model: "m" }, "custom"],
    [{ mode: "local", provider: "qwen", model: "q" }, "local:q"],
    [{ mode: "self-hosted", provider: "lan", model: "m" }, "selfHosted"],
    [{ mode: "enterprise", provider: "bedrock", model: "m" }, "enterprise"],
    [{ mode: "providers", provider: "", model: "" }, null],
  ];
  for (const [current, id] of cases) assert.equal(selectedOptionId(current), id, current.mode);

  const copilot = describePickerSelection(
    "dictationCleanup",
    context("dictationCleanup", {
      current: { mode: "providers", provider: "copilot", model: "claude-haiku-5.5" },
    })
  );
  assert.deepEqual(copilot, {
    icon: "copilot",
    title: { text: "Claude Haiku 5.5" },
    sub: { text: "GitHub Copilot · @octocat" },
    warning: undefined,
  });

  const cloudOff = describePickerSelection(
    "dictationTranslation",
    context("dictationTranslation", {
      cloudDisabled: true,
      isSignedIn: false,
      current: { mode: "openwhispr", provider: "", model: "" },
    })
  );
  assert.deepEqual(cloudOff.warning, { key: "modelPicker.reasons.cloudOff" });
  assert.deepEqual(cloudOff.title, { key: "modelPicker.cloud.automatic" });

  const noKey = describePickerSelection(
    "chatIntelligence",
    context("chatIntelligence", {
      keys: {},
      current: { mode: "providers", provider: "groq", model: "llama-3.3-70b-versatile" },
    })
  );
  assert.deepEqual(noKey.warning, { key: "modelPicker.reasons.noKey" });
  assert.deepEqual(noKey.sub, { key: "modelPicker.trigger.apiKey", params: { provider: "Groq" } });

  const visionUnset = describePickerSelection(
    "dictationAgentVision",
    context("dictationAgentVision", { current: { mode: "providers", provider: "groq", model: "" } })
  );
  assert.deepEqual(visionUnset.sub, {
    key: "modelPicker.trigger.optionalUnset.dictationAgentVision",
  });

  const custom = describePickerSelection(
    "dictationCleanup",
    context("dictationCleanup", {
      current: {
        mode: "providers",
        provider: "custom",
        model: "my-model",
        cloudBaseUrl: "https://user:pass@llm.example.com:8443/v1?token=x",
      },
    })
  );
  assert.deepEqual(custom.sub, {
    key: "modelPicker.trigger.custom",
    params: { host: "llm.example.com:8443" },
  });
});

test("note formatting shows each field it borrows from Cleanup", async (t) => {
  const { noteFormattingFields } = await load(t);
  const own = {
    noteFormattingMode: "providers",
    noteFormattingProvider: "",
    noteFormattingModel: "",
    noteFormattingCloudBaseUrl: "",
    noteFormattingRemoteUrl: "",
  };
  const inherited = { provider: "copilot", model: "claude-haiku-5.5" };
  assert.deepEqual(noteFormattingFields(own, inherited), [
    { field: "provider", value: { text: "GitHub Copilot" }, inherited: true },
    { field: "model", value: { text: "Claude Haiku 5.5" }, inherited: true },
  ]);
  // Its own provider, Cleanup's model: only the model is borrowed.
  assert.deepEqual(
    noteFormattingFields(
      { ...own, noteFormattingProvider: "openai" },
      { provider: "openai", model: "claude-haiku-5.5" }
    ).map((field) => [field.field, field.inherited]),
    [
      ["provider", false],
      ["model", true],
    ]
  );
  // Self-hosted: the server and the model, host only.
  assert.deepEqual(
    noteFormattingFields(
      { ...own, noteFormattingMode: "self-hosted", noteFormattingModel: "qwen3:8b" },
      { provider: "lan", model: "qwen3:8b", remoteUrl: "http://192.168.1.5:11434/v1" }
    ),
    [
      { field: "server", value: { text: "192.168.1.5:11434" }, inherited: true },
      { field: "model", value: { text: "qwen3:8b" }, inherited: false },
    ]
  );
  // A custom provider borrowed with its endpoint.
  assert.deepEqual(
    noteFormattingFields(own, {
      provider: "custom",
      model: "m",
      cloudBaseUrl: "https://llm.example.com/v1",
    }).map((field) => [field.field, field.inherited]),
    [
      ["provider", true],
      ["endpoint", true],
      ["model", true],
    ]
  );
  // Everything its own, or Cloud: nothing inherited, the picker shows as usual.
  assert.equal(
    noteFormattingFields(
      { ...own, noteFormattingProvider: "groq", noteFormattingModel: "x" },
      { provider: "groq", model: "x" }
    ),
    null
  );
  assert.equal(noteFormattingFields({ ...own, noteFormattingMode: "openwhispr" }, inherited), null);
});

nodeTest("the model picker's options", async (t) => {
  await load(t);
  for (const [name, fn] of subtests) await t.test(name, fn);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Settings has one scroller (the layer's content pane): a wheel over a Settings
// body always scrolls the page. Long read-only text uses ClampedText ("Show
// all") and editable text AutoGrowTextarea, never a capped box that scrolls by
// itself. Dialogs keep their own scroll; they're allowed below by name.

const SRC = path.join(__dirname, "..", "..", "src", "components");
const SETTINGS_DIR = path.join(SRC, "settings");
const MODEL_PICKER_DIR = path.join(SETTINGS_DIR, "modelPicker");

const FILES = [
  "SettingsPage.tsx",
  "ui/PromptStudio.tsx",
  "ui/StyleStudio.tsx",
  "ui/PromptTestSet.tsx",
  "ui/PromptLibraryBar.tsx",
  // The OpenRouter and custom-endpoint model lists under a feature's model picker.
  "ui/SearchableModelList.tsx",
  "OpenAICompatiblePanel.tsx",
  ...fs
    .readdirSync(SETTINGS_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => `settings/${name}`),
  ...fs
    .readdirSync(MODEL_PICKER_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => `settings/modelPicker/${name}`),
];

// Each entry must still match, so a removed scroller takes its entry with it.
const ALLOWED_SCROLLERS = [
  {
    file: "settings/SettingsLayer.tsx",
    snippet: '"flex-1 overflow-y-auto pb-3"',
    why: "the Settings nav, beside the content",
  },
  {
    file: "settings/SettingsLayer.tsx",
    snippet: 'className="min-w-0 flex-1 overflow-y-auto bg-background dark:bg-surface-1"',
    why: "the one content scroller",
  },
  {
    file: "SettingsPage.tsx",
    snippet: '<DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">',
    why: "a dialog",
  },
  {
    file: "settings/WorkspaceDeveloperTab.tsx",
    snippet: '<div className="space-y-2 max-h-72 overflow-y-auto">',
    why: "the scope list inside the Create API key dialog",
  },
  {
    file: "settings/modelPicker/ModelPicker.tsx",
    snippet:
      'className="max-h-[min(420px,var(--radix-popover-content-available-height))] overflow-y-auto pb-1"',
    why: "the model picker's menu, a popup portaled outside the page",
  },
  // Upstream's team settings (#3110), all inside the Team settings dialog or a popup.
  {
    file: "settings/TeamSettingsDialog.tsx",
    snippet: 'className="max-h-[85vh] max-w-md gap-5 overflow-y-auto rounded-[28px] p-5"',
    why: "a dialog",
  },
  {
    file: "settings/TeamMembersPanel.tsx",
    snippet: 'const ROWS_SCROLLER = "max-h-[clamp(9rem,calc(85vh-25rem),22rem)] overflow-y-auto";',
    why: "the members table inside the Team settings dialog",
  },
  {
    file: "settings/TeamSpacesPanel.tsx",
    snippet:
      'className="max-h-64 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/40"',
    why: "the teamspaces table inside the Team settings dialog",
  },
  {
    file: "settings/TeamSpacesPanel.tsx",
    snippet:
      'className="max-h-[min(18rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-0 overflow-y-auto rounded-xl p-1.5"',
    why: "the add-teamspace search's popup",
  },
  {
    file: "settings/WorkspaceGuestsTab.tsx",
    snippet: 'className="max-h-72 w-72 overflow-y-auto p-1.5"',
    why: "a guest's invite-to menu, a popup portaled outside the page",
  },
];

const VERTICAL_SCROLL = /\boverflow-(?:y-)?(?:auto|scroll)\b|overflowY:\s*["'](?:auto|scroll)["']/;
const RAW_TEXTAREA = /<(?:textarea|Textarea)\b/;

const read = (file) => fs.readFileSync(path.join(SRC, file), "utf8").split(/\r?\n/);

test("Settings bodies have no inner vertical scrollers outside the allow-list", () => {
  const offenders = [];
  const used = new Set();
  for (const file of FILES) {
    read(file).forEach((line, index) => {
      if (!VERTICAL_SCROLL.test(line)) return;
      const allowed = ALLOWED_SCROLLERS.find(
        (entry) => entry.file === file && line.includes(entry.snippet)
      );
      if (allowed) used.add(allowed);
      else offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "Use ClampedText for long read-only text and AutoGrowTextarea for editors"
  );
  const stale = ALLOWED_SCROLLERS.filter((entry) => !used.has(entry)).map(
    (entry) => `${entry.file}: ${entry.snippet}`
  );
  assert.deepEqual(stale, [], "allow-list entries that no longer match anything");
});

test("Settings bodies edit text in AutoGrowTextarea, not a fixed-height textarea", () => {
  const offenders = [];
  for (const file of FILES) {
    read(file).forEach((line, index) => {
      if (RAW_TEXTAREA.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("the former capped scrollers and editors use the shared components", () => {
  const uses = (file, name) => read(file).some((line) => line.includes(`<${name}`));
  for (const file of ["ui/PromptStudio.tsx", "ui/StyleStudio.tsx", "ui/PromptTestSet.tsx"]) {
    assert.ok(uses(file, "ClampedText"), `${file} clamps its read-only text`);
    assert.ok(uses(file, "AutoGrowTextarea"), `${file} grows its editors`);
  }
  assert.ok(uses("settings/ChatAgentSettings.tsx", "ClampedText"));
  assert.ok(uses("settings/ChatAgentSettings.tsx", "AutoGrowTextarea"));
  // The long model list (OpenRouter's catalog) grows with the page, a page of models at a time.
  assert.ok(
    read("ui/SearchableModelList.tsx").some((line) => line.includes("MODEL_LIST_PAGE_SIZE")),
    "SearchableModelList caps by count with Show more"
  );
});

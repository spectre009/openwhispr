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

const FILES = [
  "SettingsPage.tsx",
  "ui/PromptStudio.tsx",
  "ui/StyleStudio.tsx",
  "ui/PromptTestSet.tsx",
  "ui/PromptLibraryBar.tsx",
  ...fs
    .readdirSync(SETTINGS_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => `settings/${name}`),
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
});

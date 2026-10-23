const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyGlossary,
  glossaryCanonicalTerms,
  ruleAppliesToApp,
} = require("../../src/utils/glossary.ts");

// Synthetic fixture mirroring the first-run seed (helpers/glossaryRules.js).
const LITTLE_BUDDY = Object.freeze({
  id: "rule-little-buddy",
  canonical: "Little Buddy",
  enabled: true,
  revision: 1,
  apps: ["github.exe", "Code.exe", "WindowsTerminal.exe", "Obsidian.exe"],
  spellings: [
    { text: "littlebuddy", scope: "anywhere" },
    { text: "everybody", scope: "start" },
    { text: "every body", scope: "start" },
    { text: "buddy", scope: "start" },
    { text: "buddies", scope: "start" },
    { text: "little buddies", scope: "start" },
  ],
});

const apply = (text, targetApp, extra = {}) =>
  applyGlossary(text, [LITTLE_BUDDY], { targetApp, ...extra });

const CORRECTED = [
  [
    "Code.exe",
    "Hello, everybody. I need you to take a look at the build.",
    "Hello, Little Buddy. I need you to take a look at the build.",
  ],
  [
    "github.exe",
    "Alright everybody, check if we have a dedicated section.",
    "Alright Little Buddy, check if we have a dedicated section.",
  ],
  [
    "WindowsTerminal.exe",
    "Hello buddies. So we forked this project.",
    "Hello Little Buddy. So we forked this project.",
  ],
  [
    "Obsidian.exe",
    "Hello, buddy. Take a look at these notes.",
    "Hello, Little Buddy. Take a look at these notes.",
  ],
  [
    "code.exe",
    "Hello, everybody. I need you to take a look at the build.",
    "Hello, Little Buddy. I need you to take a look at the build.",
  ],
];

for (const [app, input, expected] of CORRECTED) {
  test(`${app}: a misheard opening becomes the canonical form`, () => {
    const result = apply(input, app);
    assert.equal(result.text, expected);
    assert.equal(result.fired.length, 1);
    assert.equal(result.fired[0].ruleId, "rule-little-buddy");
    assert.equal(result.fired[0].scope, "start");
    assert.equal(result.fired[0].to, "Little Buddy");
    // The offset indexes the input, so a later stage can show the exact span.
    const { index, from } = result.fired[0];
    assert.equal(input.slice(index, index + from.length), from);
  });
}

test("ms-teams.exe: a group greeting stays as said", () => {
  const input = "Hello everybody, quick reminder that the all hands moved.";
  assert.deepEqual(apply(input, "ms-teams.exe"), { text: input, fired: [] });
});

test("an unknown target app gets no start-of-dictation corrections", () => {
  const input = "Hello, everybody. I need you to look at this.";
  for (const app of [null, undefined, ""]) {
    assert.deepEqual(apply(input, app), { text: input, fired: [] });
  }
});

test("a start spelling is never replaced mid-text", () => {
  const input = "I told everybody about the outage.";
  assert.deepEqual(apply(input, "Code.exe"), { text: input, fired: [] });
  assert.equal(
    apply("Hello team, everybody needs this.", "Code.exe").text,
    "Hello team, everybody needs this."
  );
});

test("an anywhere spelling applies in any app and with no app", () => {
  for (const app of [null, "ms-teams.exe", "Code.exe"]) {
    const result = apply("So littlebuddy, check this.", app);
    assert.equal(result.text, "So Little Buddy, check this.", String(app));
    assert.equal(result.fired[0].scope, "anywhere");
  }
  assert.equal(
    apply("Ask LittleBuddy and littlebuddy twice.", null).text,
    "Ask Little Buddy and Little Buddy twice."
  );
});

test("whole words only: a spelling inside another word never matches", () => {
  assert.equal(apply("Hiking buddy trip", "Code.exe").text, "Hiking buddy trip");
  assert.equal(apply("littlebuddyish", null).text, "littlebuddyish");
  assert.equal(apply("Hello buddyguard", "Code.exe").text, "Hello buddyguard");
});

test("greetings and surrounding punctuation are kept", () => {
  assert.equal(apply("Okay everybody", "Code.exe").text, "Okay Little Buddy");
  assert.equal(apply("All right, buddy!", "Code.exe").text, "All right, Little Buddy!");
  assert.equal(apply("  Hey… every body, look.", "Code.exe").text, "  Hey… Little Buddy, look.");
  assert.equal(
    apply("Everybody, check the logs.", "Code.exe").text,
    "Little Buddy, check the logs."
  );
  // The longest spelling wins over a shorter one it contains.
  assert.equal(apply("Hello little buddies. So", "Code.exe").text, "Hello Little Buddy. So");
});

test("a disabled rule changes nothing", () => {
  const disabled = { ...LITTLE_BUDDY, enabled: false };
  for (const [app, input] of [
    ["Code.exe", "Hello, everybody. I need you."],
    [null, "So littlebuddy, check this."],
  ]) {
    assert.deepEqual(applyGlossary(input, [disabled], { targetApp: app }), {
      text: input,
      fired: [],
    });
  }
  assert.deepEqual(glossaryCanonicalTerms([disabled]), []);
});

test("a snippet trigger overlapping a glossary spelling wins", () => {
  const snippets = [{ trigger: "hello everybody", replacement: "Hi team!" }];
  const input = "Hello everybody, see you at noon.";
  assert.deepEqual(apply(input, "Code.exe", { snippets }), { text: input, fired: [] });
  // A trigger elsewhere leaves the opening correctable.
  assert.equal(
    apply("Hello everybody, cal link please.", "Code.exe", {
      snippets: [{ trigger: "cal link", replacement: "https://cal.example/x" }],
    }).text,
    "Hello Little Buddy, cal link please."
  );
});

test("app matching is case-insensitive and only names listed apps", () => {
  assert.equal(ruleAppliesToApp(LITTLE_BUDDY, "OBSIDIAN.EXE"), true);
  assert.equal(ruleAppliesToApp(LITTLE_BUDDY, " code.exe "), true);
  assert.equal(ruleAppliesToApp(LITTLE_BUDDY, "chrome.exe"), false);
  assert.equal(ruleAppliesToApp(LITTLE_BUDDY, null), false);
});

test("only canonical forms are offered to hint lists, never spellings", () => {
  const terms = glossaryCanonicalTerms([
    LITTLE_BUDDY,
    { ...LITTLE_BUDDY, id: "dup", canonical: "little buddy" },
  ]);
  assert.deepEqual(terms, ["Little Buddy"]);
  for (const spelling of LITTLE_BUDDY.spellings) {
    assert.ok(!terms.includes(spelling.text));
  }
});

test("text already in canonical form is not reported as a correction", () => {
  const rule = {
    ...LITTLE_BUDDY,
    spellings: [{ text: "little buddy", scope: "anywhere" }],
  };
  assert.deepEqual(applyGlossary("Little Buddy, hi", [rule]), {
    text: "Little Buddy, hi",
    fired: [],
  });
  assert.equal(applyGlossary("little buddy, hi", [rule]).text, "Little Buddy, hi");
});

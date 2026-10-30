const test = require("node:test");
const assert = require("node:assert/strict");

// Connections on Settings › AI Connections, grouped by state: In use (most
// active uses first, ties in today's order), Saved, not in use, and the rest
// folded under "Add a provider"; a first run shows the starter cards and folds
// the rest. A visit's groups are frozen once its inputs have loaded: a known
// connection keeps its group, a new one takes its live group, a removed one is
// dropped, and the next visit regroups.

async function load() {
  const mod = await import("../../src/components/settings/connectionGroups.ts");
  return mod.default ?? mod;
}

const COMMON = ["openai", "anthropic", "gemini", "groq"];

/** The user's setup: Little Buddy and Copilot in use, three unused keys, Cloud off. */
function userSetup(overrides = {}) {
  return {
    connections: {
      custom: { activeUses: 5, saved: true },
      copilot: { activeUses: 3, saved: true },
      groq: { activeUses: 0, saved: true },
      gemini: { activeUses: 0, saved: true },
      openrouter: { activeUses: 0, saved: true },
      ...overrides,
    },
    cloudOff: true,
    common: COMMON,
  };
}

test("grouped: in use by uses, saved without a use, the rest to add", async () => {
  const { groupConnections, connectionsLayout } = await load();
  const input = userSetup();
  assert.equal(connectionsLayout(input), "grouped");
  assert.deepEqual(groupConnections(input), {
    layout: "grouped",
    inUse: ["custom", "copilot"],
    saved: ["gemini", "groq", "openrouter"],
    add: [
      "openai",
      "anthropic",
      "mistral",
      "tinfoil",
      "corti",
      "xai",
      "deepgram",
      "assemblyai",
      "azure-speech",
      "cloud",
    ],
  });
});

test("in use orders by active uses, ties in today's order (Copilot, providers, Cloud, custom)", async () => {
  const { groupConnections } = await load();
  const groups = groupConnections({
    connections: {
      custom: { activeUses: 1, saved: true },
      cloud: { activeUses: 1, saved: true },
      deepgram: { activeUses: 2, saved: true },
      openai: { activeUses: 1, saved: true },
      copilot: { activeUses: 1, saved: false },
    },
    cloudOff: false,
    common: COMMON,
  });
  assert.deepEqual(groups.inUse, ["deepgram", "copilot", "openai", "cloud", "custom"]);
});

test("a connection a feature uses stays in use without a key or sign-in", async () => {
  const { groupConnections } = await load();
  const groups = groupConnections({
    connections: {
      openai: { activeUses: 1, saved: false },
      copilot: { activeUses: 2, saved: false },
    },
    cloudOff: false,
    common: COMMON,
  });
  assert.deepEqual(groups.inUse, ["copilot", "openai"]);
  assert.ok(!groups.add.includes("openai"));
});

test("Cloud: saved while on and signed in, else to add; the custom connection is never in add", async () => {
  const { groupConnections } = await load();
  const used = { openai: { activeUses: 1, saved: true } };
  const on = groupConnections({
    connections: { ...used, cloud: { activeUses: 0, saved: true } },
    cloudOff: false,
    common: COMMON,
  });
  assert.ok(on.saved.includes("cloud"));
  const signedOut = groupConnections({
    connections: { ...used, cloud: { activeUses: 0, saved: false } },
    cloudOff: false,
    common: COMMON,
  });
  assert.ok(signedOut.add.includes("cloud"));
  for (const groups of [on, signedOut]) {
    assert.ok(!Object.values(groups).flat().includes("custom"), "no custom connection: none");
  }

  // An unused custom connection is saved (it exists), never folded.
  const withCustom = groupConnections({
    connections: { ...used, custom: { activeUses: 0, saved: false } },
    cloudOff: true,
    common: COMMON,
  });
  assert.ok(withCustom.saved.includes("custom"));
  assert.ok(!withCustom.add.includes("custom"));
});

test("first run: Copilot, the starters, saved providers and Cloud while on; the rest folded", async () => {
  const { groupConnections, connectionsLayout } = await load();
  const input = {
    connections: {
      openrouter: { activeUses: 0, saved: true },
      copilot: { activeUses: 0, saved: true },
    },
    cloudOff: false,
    common: COMMON,
  };
  assert.equal(connectionsLayout(input), "firstRun");
  assert.deepEqual(groupConnections(input), {
    layout: "firstRun",
    cards: ["copilot", "openai", "anthropic", "gemini", "groq", "openrouter", "cloud"],
    fold: ["mistral", "tinfoil", "corti", "xai", "deepgram", "assemblyai", "azure-speech"],
  });

  // Cloud off folds it; a custom connection (unused) is a card.
  const off = groupConnections({
    ...input,
    cloudOff: true,
    connections: { ...input.connections, custom: { activeUses: 0, saved: true } },
  });
  assert.equal(off.layout, "firstRun");
  assert.ok(!off.cards.includes("cloud"));
  assert.equal(off.fold.at(-1), "cloud");
  assert.equal(off.cards.at(-1), "custom");
  assert.ok(!off.fold.includes("custom"));
});

test("freezing: a known connection keeps its group and place, both ways", async () => {
  const { groupConnections, freezeGroups } = await load();
  const snapshot = groupConnections(userSetup());

  // A key added in the fold and one removed from Saved: nothing moves.
  const live = userSetup({
    openai: { activeUses: 0, saved: true },
    groq: { activeUses: 0, saved: false },
  });
  assert.deepEqual(groupConnections(live).saved, ["openai", "gemini", "openrouter"]);
  assert.deepEqual(freezeGroups(snapshot, live), snapshot);

  // In use losing its uses, or a saved key gaining one: still where it was.
  const used = userSetup({
    copilot: { activeUses: 0, saved: true },
    gemini: { activeUses: 4, saved: true },
  });
  assert.deepEqual(freezeGroups(snapshot, used), snapshot);

  // The first-run layout holds too, even once something is in use.
  const firstRun = groupConnections({ connections: {}, cloudOff: false, common: COMMON });
  const frozen = freezeGroups(firstRun, {
    connections: { deepgram: { activeUses: 1, saved: true } },
    cloudOff: false,
    common: COMMON,
  });
  assert.deepEqual(frozen, firstRun);
});

test("freezing: a new custom connection takes its live group; a removed one is dropped", async () => {
  const { groupConnections, freezeGroups } = await load();
  const base = userSetup();
  delete base.connections.custom;
  const snapshot = groupConnections(base);
  assert.deepEqual(snapshot.inUse, ["copilot"]);

  const used = freezeGroups(snapshot, {
    ...base,
    connections: { ...base.connections, custom: { activeUses: 4, saved: true } },
  });
  assert.deepEqual(used.inUse, ["copilot", "custom"], "joins In use, at the end");
  const unused = freezeGroups(snapshot, {
    ...base,
    connections: { ...base.connections, custom: { activeUses: 0, saved: true } },
  });
  assert.deepEqual(unused.saved, ["gemini", "groq", "openrouter", "custom"]);

  // Known, then removed: dropped from its group.
  const withCustom = groupConnections(userSetup());
  const removed = freezeGroups(withCustom, base);
  assert.deepEqual(removed.inUse, ["copilot"]);
  assert.ok(!Object.values(removed).flat().includes("custom"));

  // A first run's new custom connection is a card.
  const firstRun = groupConnections({ connections: {}, cloudOff: false, common: COMMON });
  const added = freezeGroups(firstRun, {
    connections: { custom: { activeUses: 0, saved: true } },
    cloudOff: false,
    common: COMMON,
  });
  assert.equal(added.cards.at(-1), "custom");
});

test("a visit: frozen once ready, live until then, regrouped on the next visit", async () => {
  const { stepVisit, NO_VISIT, groupConnections } = await load();
  const setup = userSetup();
  const changed = userSetup({ openai: { activeUses: 0, saved: true } });

  // Hidden: live, nothing kept.
  const hidden = stepVisit(NO_VISIT, { active: false, ready: true, input: setup });
  assert.equal(hidden.visit, NO_VISIT);
  assert.equal(hidden.started, false);

  // Shown, inputs loaded: the first render starts the visit and takes the snapshot.
  const first = stepVisit(NO_VISIT, { active: true, ready: true, input: setup });
  assert.equal(first.started, true);
  assert.deepEqual(first.visit.snapshot, groupConnections(setup));
  // Later renders keep it and return the same visit (no state update).
  const later = stepVisit(first.visit, { active: true, ready: true, input: changed });
  assert.equal(later.visit, first.visit);
  assert.equal(later.started, false);
  assert.deepEqual(later.groups.add.includes("openai"), true, "the new key stays in the fold");

  // Hiding ends the visit; showing again regroups.
  const ended = stepVisit(later.visit, { active: false, ready: true, input: changed });
  assert.equal(ended.visit, NO_VISIT);
  const next = stepVisit(ended.visit, { active: true, ready: true, input: changed });
  assert.equal(next.started, true);
  assert.ok(next.groups.saved.includes("openai"), "the next visit regroups");
});

test("not frozen until secrets have hydrated and Copilot's status has loaded", async () => {
  const { stepVisit, NO_VISIT } = await load();
  // Startup: no secrets yet, Copilot unknown.
  const empty = { connections: {}, cloudOff: true, common: COMMON };
  const start = stepVisit(NO_VISIT, { active: true, ready: false, input: empty });
  assert.equal(start.started, true);
  assert.equal(start.visit.snapshot, null, "nothing frozen yet");
  assert.equal(start.groups.layout, "firstRun");

  // Still loading: live on every render, and no state update while nothing changes.
  const loading = stepVisit(start.visit, { active: true, ready: false, input: userSetup() });
  assert.equal(loading.visit, start.visit);
  assert.equal(loading.groups.layout, "grouped");
  assert.deepEqual(loading.groups.saved, ["gemini", "groq", "openrouter"]);

  // Loaded: frozen from this render on, without restarting the visit.
  const ready = stepVisit(loading.visit, { active: true, ready: true, input: userSetup() });
  assert.equal(ready.started, false);
  assert.ok(ready.visit.snapshot);
  const after = stepVisit(ready.visit, {
    active: true,
    ready: true,
    input: userSetup({ groq: { activeUses: 0, saved: false } }),
  });
  assert.deepEqual(after.groups.saved, ["gemini", "groq", "openrouter"], "frozen now");
});

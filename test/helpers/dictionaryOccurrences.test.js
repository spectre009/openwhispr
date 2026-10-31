const test = require("node:test");
const assert = require("node:assert/strict");

const {
  alignTokens,
  appearanceKinds,
  attributeFix,
  createDictionaryOccurrencesService,
  historyItemDictionary,
  maskExpansions,
  normalizeOccurrencesRequest,
  offsetTokens,
  prepareWords,
  rowAppearances,
  snippetAround,
  spellingKey,
} = require("../../src/helpers/dictionaryOccurrences.js");
const {
  countDictionaryUsage,
  usageTokens,
  withoutExpansions,
} = require("../../src/helpers/dictionaryUsage.js");

// Where dictionary words appeared in a dictation (dictionaryOccurrences.js):
// the word-level alignment of the raw transcript with the final text, each
// appearance's kind (speech got it, fixed after speech, changed after speech)
// with offsets into the real texts, what speech wrote, who fixed it from the
// recorded steps, snippets, and the main service's paging, totals, variants
// and lifecycle. The measured patterns (Little Buddy, Aishwaria,
// AriaEvent.view, Sean → Shawn) with made-up dictation text.

const appearances = (raw, final, words, options = {}) =>
  rowAppearances({ raw, final }, prepareWords(words), options);
const only = (raw, final, word, options) => {
  const result = appearances(raw, final, [word], options);
  return result.words[0]?.appearances ?? [];
};

test("tokens with offsets are usage's tokens, in place", () => {
  for (const text of [
    "Little Buddy, can you ping Aishwaria?",
    "the ariaevent/view numbers",
    "Café Ångström and 会議の資料",
    "Cafe\u0301 NFC",
  ]) {
    const { tokens, starts, ends } = offsetTokens(text);
    assert.deepEqual(tokens, usageTokens(text), text);
    tokens.forEach((token, index) => {
      assert.equal(
        text.slice(starts[index], ends[index]).normalize("NFC").toLowerCase(),
        token,
        `${text}: ${token} sits where its offsets say`
      );
    });
  }
});

test("“LittleBuddy” → “Little Buddy”: fixed after speech, and speech wrote LittleBuddy", () => {
  const final = "Little Buddy, can you ping Aishwaria about it?";
  const result = appearances("LittleBuddy, can you ping ash varia about it", final, [
    "Little Buddy",
    "Aishwaria",
  ]);
  assert.equal(result.aligned, true);
  const [buddy, aishwaria] = result.words;
  assert.equal(buddy.appearances.length, 1);
  assert.equal(buddy.appearances[0].kind, "fix");
  assert.equal(buddy.appearances[0].speechWrote, "LittleBuddy");
  assert.equal(final.slice(buddy.appearances[0].start, buddy.appearances[0].end), "Little Buddy");
  assert.equal(aishwaria.appearances[0].speechWrote, "ash varia", "case and spacing as written");
});

test("a mixed row: one appearance speech got, one fixed after it", () => {
  const raw = "little buddy and Littbuddy";
  const final = "Little Buddy and Little Buddy";
  const list = only(raw, final, "Little Buddy");
  assert.deepEqual(
    list.map((appearance) => [appearance.kind, appearance.speechWrote]),
    [
      ["ok", null],
      ["fix", "Littbuddy"],
    ]
  );
  assert.deepEqual(appearanceKinds(list), ["ok", "fix"]);
  assert.equal(final.slice(list[1].start, list[1].end), "Little Buddy");
  assert.equal(raw.slice(list[1].rawStart, list[1].rawEnd), "Littbuddy");
  // The row summary counts this row once, as speech got it: the documented difference.
  const [summary] = countDictionaryUsage([{ raw, final }], ["Little Buddy"]).words;
  assert.deepEqual([summary.bothRows, summary.missedRows], [1, 0]);
});

test("case and punctuation alone are the same word: speech got it", () => {
  const list = only("the ariaevent/view numbers", "The AriaEvent.view numbers.", "AriaEvent.view");
  assert.deepEqual(
    list.map((appearance) => appearance.kind),
    ["ok"]
  );
});

test("pure insertions and ambiguous rewrites leave what speech wrote unknown", () => {
  // Nothing was there: cleanup added the name.
  const inserted = only("hello there", "Hello there, Little Buddy.", "Little Buddy");
  assert.deepEqual(
    inserted.map((appearance) => [appearance.kind, appearance.speechWrote]),
    [["fix", null]]
  );
  // The changed run reaches past the word: which part became it is a guess.
  const rewritten = only("ash varia said hi", "Aishwaria told me hi", "Aishwaria");
  assert.deepEqual(
    rewritten.map((appearance) => [appearance.kind, appearance.speechWrote]),
    [["fix", null]]
  );
  // More than four tokens isn't a spelling.
  const long = only("ping the one two three four guy", "Ping Aishwaria guy", "Aishwaria");
  assert.equal(long[0].speechWrote, null);
});

test("a word dropped beside a fix is trimmed off what speech wrote", () => {
  const list = only("please tell sean and mike", "Please tell Shawn, Mike", "Shawn");
  assert.deepEqual(
    list.map((appearance) => [appearance.kind, appearance.speechWrote]),
    [["fix", "sean"]]
  );
  // Split words stay whole: "work tree" → worktree, "co-pilot" → CoPilot.
  assert.equal(
    only("ask work tree to build", "Ask worktree to build", "worktree")[0].speechWrote,
    "work tree"
  );
  assert.equal(only("the co-pilot app", "The CoPilot app", "CoPilot")[0].speechWrote, "co-pilot");
});

test("changed after speech: in raw, gone from the final text, offsets into raw", () => {
  const raw = "kusto is down again";
  const list = only(raw, "It is down again.", "Kusto");
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "chg");
  assert.equal(raw.slice(list[0].start, list[0].end), "kusto");
});

test("snippet expansions are skipped for matching, and offsets still point into the real text", () => {
  const expansion = "https://cal.example/Gizmo";
  const final = `Book here: ${expansion} and ask Gizmo.`;
  const list = only("book here my cal link and ask gizmo", final, "Gizmo", {
    snippetExpansions: [expansion],
  });
  assert.equal(list.length, 1, "the expansion's Gizmo isn't one");
  assert.equal(list[0].kind, "ok");
  assert.equal(final.slice(list[0].start, list[0].end), "Gizmo");
  assert.ok(list[0].start > final.indexOf(expansion) + expansion.length);
  const masked = maskExpansions(final, [expansion]);
  assert.equal(masked.length, final.length, "blanked, not removed");
  assert.deepEqual(usageTokens(masked), usageTokens(withoutExpansions(final, [expansion])));
});

test("the alignment is bounded: over the cap a row has no appearances", () => {
  const raw = Array.from({ length: 60 }, (_, i) => `r${i}`).join(" ");
  const final = `Kusto ${Array.from({ length: 60 }, (_, i) => `f${i}`).join(" ")}`;
  assert.equal(alignTokens(usageTokens(raw), usageTokens(final), { maxCells: 100 }), null);
  const result = appearances(raw, final, ["Kusto"], { maxCells: 100 });
  assert.deepEqual(result, { aligned: false, words: [] });
  assert.equal(appearances(raw, final, ["Kusto"]).aligned, true, "under the default cap");
  assert.deepEqual(appearances(null, "Kusto", ["Kusto"]), { aligned: false, words: [] });
});

test("row summaries and the alignment agree on rows that aren't mixed", () => {
  const words = ["Little Buddy", "Aishwaria", "Kusto", "AriaEvent.view", "the"];
  const rows = [
    { raw: "little buddy open kusto", final: "Little Buddy, open Kusto." },
    { raw: "LittleBuddy open the dashboard", final: "Little Buddy, open the dashboard." },
    { raw: "ping ash varia", final: "Ping Aishwaria." },
    { raw: "kusto said no", final: "They said no." },
    { raw: "the ariaevent/view numbers", final: "The AriaEvent.view numbers." },
    { raw: "nothing here", final: "Nothing here." },
    { raw: "hello", final: "Hello, Little Buddy." },
  ];
  const summary = countDictionaryUsage(rows, words).words;
  const totals = Object.fromEntries(words.map((word) => [word, { ok: 0, fix: 0, chg: 0 }]));
  for (const row of rows) {
    const result = rowAppearances(row, prepareWords(words));
    for (const { word, appearances: list } of result.words) {
      const kinds = appearanceKinds(list);
      assert.ok(kinds.length === 1, `${word} isn't mixed in "${row.final}"`);
      totals[word][kinds[0]] += 1;
    }
  }
  for (const entry of summary) {
    assert.deepEqual(
      totals[entry.word],
      { ok: entry.bothRows, fix: entry.missedRows, chg: entry.heard - entry.bothRows },
      entry.word
    );
  }
});

test("snippets: at most 60 characters a side, cut at word boundaries", () => {
  const before = "one two three four five six seven eight nine ten eleven twelve thirteen ";
  const after = " alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
  const text = `${before}Kusto${after}`;
  const start = before.length;
  const snippet = snippetAround(text, start, start + 5);
  assert.equal(snippet.match, "Kusto");
  assert.ok(Array.from(snippet.before).length <= 60);
  assert.ok(Array.from(snippet.after).length <= 60);
  assert.match(snippet.before, /^…[a-z]/, "an ellipsis, then a whole word");
  assert.match(snippet.after, /[a-z]…$/);
  assert.ok(text.includes(snippet.before.slice(1)));
  assert.ok(text.includes(snippet.after.slice(0, -1)));
  assert.deepEqual(snippetAround("Ask Kusto now", 4, 9), {
    before: "Ask ",
    match: "Kusto",
    after: " now",
  });
});

const step = (kind, output, extra = {}) => ({
  kind,
  outcome: "ok",
  output,
  detail: null,
  ...extra,
});

test("who fixed it comes only from the recorded steps", () => {
  const glossary = [
    step("stt", "LittleBuddy, hi"),
    step("glossary", "Little Buddy, hi", {
      detail: JSON.stringify({
        rulesFired: [{ ruleId: "r1", from: "LittleBuddy", to: "Little Buddy" }],
      }),
    }),
    step("cleanup", "Little Buddy, hi."),
  ];
  assert.equal(attributeFix(glossary, "little buddy"), "glossary");
  const cleanup = [step("stt", "ping ash varia"), step("cleanup", "Ping Aishwaria.")];
  assert.equal(attributeFix(cleanup, "Aishwaria"), "cleanup");
  const styled = [step("stt", "ping ash varia"), step("style", "Ping Aishwaria!")];
  assert.equal(attributeFix(styled, "Aishwaria"), "style");
  // The cleanup step received the word already: not cleanup's doing.
  const already = [step("stt", "ping aishwaria"), step("cleanup", "Ping Aishwaria.")];
  assert.equal(attributeFix(already, "Aishwaria"), null);
  // A failed cleanup changed nothing; no steps, nothing named.
  const failed = [step("stt", "ping ash varia"), step("cleanup", null, { outcome: "failed" })];
  assert.equal(attributeFix(failed, "Aishwaria"), null);
  assert.equal(attributeFix([], "Aishwaria"), null);
});

test("History's dictionary in a dictation: words, kinds, offsets, and who fixed each", () => {
  const raw = "littlebuddy can you ping ash varia about kusto";
  const final = "Little Buddy, can you ping Aishwaria about Kusto?";
  const steps = [
    step("stt", raw),
    step("glossary", "Little Buddy can you ping ash varia about kusto", {
      detail: { rulesFired: [{ ruleId: "r1", from: "littlebuddy", to: "Little Buddy" }] },
    }),
    step("cleanup", final),
  ];
  const found = historyItemDictionary(
    { raw, final },
    ["Little Buddy", "Aishwaria", "Kusto", "Never"],
    { steps }
  );
  assert.equal(found.aligned, true);
  const byWord = Object.fromEntries(found.words.map((entry) => [entry.word, entry.appearances]));
  assert.deepEqual(Object.keys(byWord), ["Little Buddy", "Aishwaria", "Kusto"]);
  assert.deepEqual(
    byWord["Little Buddy"].map((a) => [a.kind, a.speechWrote, a.by]),
    [["fix", "littlebuddy", "glossary"]]
  );
  assert.deepEqual(
    byWord.Aishwaria.map((a) => [a.kind, a.speechWrote, a.by]),
    [["fix", "ash varia", "cleanup"]]
  );
  assert.deepEqual(
    byWord.Kusto.map((a) => [a.kind, a.by]),
    [["ok", null]]
  );
  const kusto = byWord.Kusto[0];
  assert.equal(final.slice(kusto.start, kusto.end), "Kusto");
  // Without the owner's steps: never named.
  const blind = historyItemDictionary({ raw, final }, ["Aishwaria"], { steps: [] });
  assert.equal(blind.words[0].appearances[0].by, null);
});

test("an occurrences request is validated: kind, range, cursor and limit", () => {
  assert.deepEqual(normalizeOccurrencesRequest(undefined), {
    kind: null,
    range: null,
    cursor: null,
    limit: 20,
  });
  assert.equal(normalizeOccurrencesRequest({ kind: "all" }).kind, null);
  assert.equal(normalizeOccurrencesRequest({ kind: "fix", limit: 500 }).limit, 50);
  assert.equal(normalizeOccurrencesRequest({ limit: 0 }).limit, 1);
  assert.equal(normalizeOccurrencesRequest({ kind: "maybe" }), null);
  assert.equal(normalizeOccurrencesRequest({ range: { start: "x", end: "y" } }), null);
  assert.equal(
    normalizeOccurrencesRequest({
      range: { start: "2026-10-23T00:00:00Z", end: "2026-10-16T00:00:00Z" },
    }),
    null,
    "an end before its start"
  );
  assert.equal(normalizeOccurrencesRequest({ cursor: { timestamp: "2026", id: 0 } }), null);
  assert.equal(spellingKey("Ash-Varia"), spellingKey("ash varia"));
});

// ─── The service, over a stand-in database ───

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function fakeDb(rows, { steps = {} } = {}) {
  const db = {
    rows,
    revision: 1,
    reads: 0,
    textReads: 0,
    onRead: null,
    getHistoryContentRevision: () => db.revision,
    getDictionaryOccurrenceRows: ({ since }) => {
      db.reads += 1;
      db.onRead?.();
      return db.rows
        .filter((row) => row.at >= since)
        .sort((a, b) => (a.sort_key < b.sort_key ? 1 : a.sort_key > b.sort_key ? -1 : b.id - a.id));
    },
    getDictionaryOccurrenceTexts: (ids) => {
      db.textReads += 1;
      return db.rows
        .filter((row) => ids.includes(row.id))
        .map((row) => ({ ...row, timestamp: row.sort_key }));
    },
    getHistoryStepRows: (ids, owner) =>
      owner === "account:a"
        ? ids.flatMap((id) => (steps[id] ?? []).map((s) => ({ ...s, transcription_id: id })))
        : [],
  };
  return db;
}

const dictation = (id, daysAgo, raw, final) => ({
  id,
  sort_key: sqlTime(NOW - daysAgo * DAY),
  at: sqlTime(NOW - daysAgo * DAY),
  raw,
  final,
});

function service(db, overrides = {}) {
  const state = {
    owner: "account:a",
    policy: { synced: true, enabled: true, forcedOff: false, resolved: true },
  };
  const svc = createDictionaryOccurrencesService({
    db,
    getOwner: () => state.owner,
    getPolicy: () => state.policy,
    getGeneration: () => 7,
    now: () => NOW,
    ...overrides,
  });
  return { svc, state };
}

const ROWS = [
  dictation(1, 1, "littlebuddy open the board", "Little Buddy, open the board."),
  dictation(2, 2, "little buddy and littbuddy", "Little Buddy and Little Buddy."),
  dictation(3, 3, "little buddy hi", "Little Buddy, hi."),
  dictation(4, 4, "little buddy said no", "They said no."),
  dictation(5, 9, "littlebuddy ping", "Little Buddy, ping."),
  dictation(6, 10, "nothing to see", "Nothing to see."),
  dictation(7, 11, "littlebuddy", "LittleBuddy."),
  dictation(8, 120, "littlebuddy old", "Little Buddy, old."),
];

test("occurrences: newest first, totals by kind, mixed rows in each, pages by cursor", async () => {
  const db = fakeDb(ROWS, {
    steps: {
      1: [
        {
          kind: "stt",
          outcome: "ok",
          output: "littlebuddy open the board",
          context: JSON.stringify({ targetApp: "Teams.exe" }),
        },
        {
          kind: "glossary",
          outcome: "ok",
          output: "Little Buddy open the board",
          detail: JSON.stringify({
            rulesFired: [{ ruleId: "r", from: "littlebuddy", to: "Little Buddy" }],
          }),
        },
      ],
    },
  });
  const { svc } = service(db);
  const all = await svc.getOccurrences("Little Buddy", { limit: 2 });
  assert.equal(all.available, true);
  assert.equal(all.generation, 7);
  assert.deepEqual(all.totals, { all: 5, ok: 2, fix: 3, chg: 1 }, "row 2 counts as ok and fix");
  assert.deepEqual(
    all.items.map((item) => [item.id, item.kinds]),
    [
      [1, ["fix"]],
      [2, ["ok", "fix"]],
    ]
  );
  const first = all.items[0];
  assert.equal(first.app, "Teams.exe");
  assert.equal(first.by, "glossary");
  assert.equal(first.speechWrote, "littlebuddy");
  assert.deepEqual(first.snippet, {
    kind: "fix",
    before: "",
    match: "Little Buddy",
    after: ", open the board.",
  });
  assert.ok(all.nextCursor);
  const rest = await svc.getOccurrences("Little Buddy", { limit: 2, cursor: all.nextCursor });
  assert.deepEqual(
    rest.items.map((item) => item.id),
    [3, 4]
  );
  assert.equal(rest.items[1].snippet.kind, "chg", "changed: a snippet of the raw transcript");
  assert.equal(rest.items[1].app, null, "no steps: no app");
  const last = await svc.getOccurrences("Little Buddy", { limit: 2, cursor: rest.nextCursor });
  assert.deepEqual(
    last.items.map((item) => item.id),
    [5]
  );
  assert.equal(
    last.nextCursor,
    null,
    "row 7's case-only change and row 8 past 90 days aren't listed"
  );
  // One kind: its rows only, the snippet at that kind.
  const fixed = await svc.getOccurrences("Little Buddy", { kind: "fix" });
  assert.deepEqual(
    fixed.items.map((item) => item.id),
    [1, 2, 5]
  );
  assert.equal(fixed.items[1].speechWrote, "littbuddy");
  const got = await svc.getOccurrences("Little Buddy", { kind: "ok" });
  assert.deepEqual(
    got.items.map((item) => [item.id, item.snippet.kind, item.speechWrote]),
    [
      [2, "ok", null],
      [3, "ok", null],
    ]
  );
  // The index is built once for this History revision.
  assert.equal(db.reads, 1);
});

test("a histogram week's bounds filter the list and its totals", async () => {
  const db = fakeDb(ROWS);
  const { svc } = service(db);
  const range = {
    start: new Date(NOW - 7 * DAY).toISOString(),
    end: new Date(NOW).toISOString(),
  };
  const week = await svc.getOccurrences("Little Buddy", { range });
  assert.deepEqual(
    week.items.map((item) => item.id),
    [1, 2, 3, 4]
  );
  assert.deepEqual(week.totals, { all: 4, ok: 2, fix: 2, chg: 1 });
});

test("speech variants: top spellings, how often each stayed as written", async () => {
  const db = fakeDb([
    dictation(1, 1, "ping sean today", "Ping Shawn today."),
    dictation(2, 2, "ask sean and mike", "Ask Shawn, Mike."),
    dictation(3, 3, "tell shaun hi", "Tell Shawn hi."),
    dictation(4, 4, "sean bean is an actor", "Sean Bean is an actor."),
    dictation(5, 5, "sean penn too", "Sean Penn too."),
    dictation(6, 6, "shawn is here", "Shawn is here."),
  ]);
  const { svc } = service(db);
  const result = await svc.getSpeechVariants("Shawn");
  assert.equal(result.available, true);
  assert.deepEqual(result.variants, [
    { spelling: "sean", count: 2, keptInFinal: 2 },
    { spelling: "shaun", count: 1, keptInFinal: 0 },
  ]);
  // One spelling's own numbers, listed or not.
  const asked = await svc.getSpeechVariants("Shawn", { spelling: "Sean" });
  assert.deepEqual(asked.requested, { spelling: "Sean", count: 2, keptInFinal: 2 });
  const unseen = await svc.getSpeechVariants("Shawn", { spelling: "Shorn" });
  assert.deepEqual(unseen.requested, { spelling: "Shorn", count: 0, keptInFinal: 0 });
});

test("unavailable without durable History for this owner; nothing read", async () => {
  const db = fakeDb(ROWS);
  const { svc, state } = service(db);
  state.policy = { ...state.policy, enabled: false };
  assert.deepEqual(await svc.getOccurrences("Little Buddy"), {
    available: false,
    reason: "history-off",
  });
  assert.deepEqual(await svc.getSpeechVariants("Little Buddy"), {
    available: false,
    reason: "history-off",
  });
  state.policy = { ...state.policy, enabled: true, forcedOff: true };
  assert.equal((await svc.getOccurrences("Little Buddy")).reason, "policy-off");
  assert.equal(db.reads, 0);
  assert.deepEqual(await svc.getOccurrences("Little Buddy", { kind: "nope" }), {
    available: false,
    reason: "invalid",
  });
});

test("an owner switch, policy off or a deletion during a request delivers nothing stale", async () => {
  // The owner changes while History is read.
  const switching = fakeDb(ROWS);
  const owned = service(switching);
  switching.onRead = () => {
    owned.state.owner = "account:b";
  };
  const switched = await owned.svc.getOccurrences("Little Buddy");
  assert.equal(switched.available, false);
  assert.equal(switched.reason, "owner-changed");
  assert.equal(switched.items, undefined);

  // History's policy goes off meanwhile.
  const policyDb = fakeDb(ROWS);
  const policed = service(policyDb);
  policyDb.onRead = () => {
    policed.state.policy = { ...policed.state.policy, forcedOff: true };
  };
  const off = await policed.svc.getSpeechVariants("Little Buddy");
  assert.deepEqual(off, { available: false, reason: "policy-off" });

  // A row is deleted meanwhile: read again, and the deleted row isn't delivered.
  const deleting = fakeDb(ROWS);
  const { svc } = service(deleting);
  let once = true;
  deleting.onRead = () => {
    if (!once) return;
    once = false;
    deleting.rows = deleting.rows.filter((row) => row.id !== 1);
    deleting.revision += 1;
  };
  const fresh = await svc.getOccurrences("Little Buddy");
  assert.equal(fresh.available, true);
  assert.ok(!fresh.items.some((item) => item.id === 1), "the deleted row isn't delivered");
  assert.equal(fresh.totals.all, 4);
  assert.equal(deleting.reads, 2, "read again after the change");
});

test("the services report counts only (a privacy canary)", async () => {
  const MARKERS = ["Zqxcanaryword", "zqxspeechwrote", "zqxsnippetcontext"];
  const db = fakeDb([
    dictation(1, 1, "zqxsnippetcontext ask zqxspeechwrote", "zqxsnippetcontext ask Zqxcanaryword."),
  ]);
  const reported = [];
  const { svc } = service(db, { onComputed: (fields) => reported.push(fields) });
  const page = await svc.getOccurrences("Zqxcanaryword");
  assert.equal(page.items[0].speechWrote, "zqxspeechwrote", "the renderer gets it");
  await svc.getSpeechVariants("Zqxcanaryword");
  assert.ok(reported.length >= 2);
  const serialized = JSON.stringify(reported);
  for (const marker of MARKERS) {
    assert.equal(serialized.toLowerCase().includes(marker.toLowerCase()), false, marker);
  }
  for (const fields of reported) {
    for (const [key, value] of Object.entries(fields)) {
      if (key === "kind") continue;
      assert.equal(typeof value, "number", `${key} is a count`);
    }
  }
});

test("timing: one word's index over 5,000 rows, its first page and its variants", async () => {
  const words = [
    "little",
    "buddy",
    "open",
    "the",
    "board",
    "ping",
    "ash",
    "varia",
    "kusto",
    "today",
  ];
  const rows = Array.from({ length: 5000 }, (_, i) => {
    const raw = Array.from({ length: 40 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(
      " "
    );
    const final = i % 3 === 0 ? `${raw.replace("ash varia", "Aishwaria")}.` : `${raw}.`;
    return dictation(i + 1, (i % 85) + 0.5, raw, final);
  });
  const { svc } = service(fakeDb(rows));
  const started = process.hrtime.bigint();
  const page = await svc.getOccurrences("the");
  const indexMs = Number(process.hrtime.bigint() - started) / 1e6;
  const variantsStarted = process.hrtime.bigint();
  await svc.getSpeechVariants("Aishwaria");
  const variantsMs = Number(process.hrtime.bigint() - variantsStarted) / 1e6;
  console.log(
    `occurrences: "the" in ${page.totals.all} of 5,000 rows, index + first page ${indexMs.toFixed(1)} ms; variants ${variantsMs.toFixed(1)} ms`
  );
  assert.ok(page.totals.all > 4000);
  assert.ok(indexMs < 2000, `took ${indexMs.toFixed(1)} ms`);
});

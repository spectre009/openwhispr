// Settings › AI Connections' "Last recorded use" (stage B of "check that every
// AI connection works"), main's half. Real requests report how they ended,
// once each, at the provider boundary and after their retries:
//
//   { descriptorId, slot, feature, ok, code, startedAt }
//
// `descriptorId` is stage A's check descriptor (connectionOutcomeTargets.js
// maps a request to it), `feature` the one that sent it (Styles apart from
// Cleanup; the assistant's vision requests are the assistant's), `code` "OK"
// or the failure's code (providerHttpErrors.js). Cancels, yields, a missing
// key and local checks of a reply aren't recorded (connectionFailureCode).
//
// `recordConnectionOutcome` is the one writer, and it never throws into a
// request. Each descriptor keeps its last outcome and its last failure, in
// memory and in the history database's `connection_outcomes` (local only,
// never synced, exported or indexed); logs carry the feature and the code.
//
// Fenced like the checks: environment.js's onSecretChanged (every write, copy
// or removal of a key, a Copilot sign-in or sign-out, Reset app data) clears
// the outcomes recorded under that slot, and an outcome whose request started
// before its slot's key last changed is dropped. OpenWhispr Cloud's go at
// sign-out the same way.

const { descriptorSlot, isOutcomeFeature } = require("./connectionOutcomeTargets.js");
const { sourcesOf } = require("./connectionChecks");

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9:._@/-]{1,160}$/;
// A renderer reads the same clock; its start may still land a moment after
// main's own reading.
const FUTURE_SLACK_MS = 5000;

const OUTCOMES_SCOPE = "connection-outcomes";

/** The outcome as main keeps it, or null when anything about it isn't one. */
function validateOutcome(input, at) {
  if (!input || typeof input !== "object") return null;
  const { descriptorId, feature, ok, code } = input;
  if (typeof descriptorId !== "string" || !ID_PATTERN.test(descriptorId)) return null;
  const slot = descriptorSlot(descriptorId, input.slot ?? null);
  if (slot === undefined) return null;
  if (!isOutcomeFeature(feature) || typeof ok !== "boolean") return null;
  const outcomeCode = ok ? "OK" : code;
  if (typeof outcomeCode !== "string" || !CODE_PATTERN.test(outcomeCode)) return null;
  if (!ok && outcomeCode === "OK") return null;
  const startedAt =
    Number.isFinite(input.startedAt) && input.startedAt <= at + FUTURE_SLACK_MS
      ? input.startedAt
      : at;
  return { descriptorId, slot, feature, ok, code: outcomeCode, startedAt };
}

function storedOutcome(value) {
  if (!value || typeof value !== "object") return null;
  const { feature, ok, code, at } = value;
  if (!isOutcomeFeature(feature) || typeof code !== "string" || !Number.isFinite(at)) return null;
  return { feature, ok: ok === true, code, at };
}

/**
 * @param {object} deps
 * @param {{ load: () => object[], save: (row: object) => void, remove: (ids: string[]) => void, clear: () => void } | null} [deps.store]
 * @param {object} [deps.logger]
 * @param {(payload: { outcomes: object }) => void} [deps.emit]  `connection-outcomes-changed`
 * @param {() => number} [deps.now]
 */
function createConnectionOutcomes({
  store = null,
  logger = null,
  emit = () => {},
  now = Date.now,
}) {
  let entries = null;
  // When each secret last changed (by name), and when Cloud last signed out.
  const changedAt = new Map();
  let cloudSignedOutAt = -Infinity;

  const log = (level, message, meta) => {
    try {
      logger?.[level]?.(message, meta, OUTCOMES_SCOPE);
    } catch {
      // Logging never costs a request.
    }
  };

  function storage(operation, fn) {
    if (!store) return undefined;
    try {
      return fn();
    } catch (error) {
      // History's database may be closed (Reset app data) or without the
      // table: the outcomes stay in memory for the session.
      log("warn", "Connection outcomes not stored", { operation, code: error?.code ?? null });
      return undefined;
    }
  }

  function load() {
    if (entries) return entries;
    entries = new Map();
    const rows = storage("load", () => store.load()) ?? [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const last = storedOutcome(row?.last);
      const slot = descriptorSlot(row?.descriptorId, row?.slot ?? null);
      if (!last || slot === undefined) continue;
      entries.set(row.descriptorId, { slot, last, lastFailure: storedOutcome(row.lastFailure) });
    }
    return entries;
  }

  /** `{ [descriptorId]: { last, lastFailure } }`: codes and times, nothing else. */
  function list() {
    const result = {};
    for (const [id, entry] of load()) {
      result[id] = {
        last: { ...entry.last },
        lastFailure: entry.lastFailure ? { ...entry.lastFailure } : null,
      };
    }
    return result;
  }

  function publish() {
    try {
      emit({ outcomes: list() });
    } catch {
      // A window that's going away must not cost the request.
    }
  }

  function fenced({ descriptorId, slot, startedAt }) {
    if (descriptorId === "cloud") return startedAt <= cloudSignedOutAt;
    if (!slot) return false;
    return sourcesOf(slot).some((name) => (changedAt.get(name) ?? -Infinity) >= startedAt);
  }

  /** The one writer: true when recorded, false when refused or dropped. Never throws. */
  function recordConnectionOutcome(input) {
    try {
      const at = now();
      const outcome = validateOutcome(input, at);
      if (!outcome) return false;
      if (fenced(outcome)) {
        // About a key (or a Cloud session) that's no longer there.
        log("debug", "Connection outcome dropped", {
          feature: outcome.feature,
          code: outcome.code,
        });
        return false;
      }
      const all = load();
      const last = { feature: outcome.feature, ok: outcome.ok, code: outcome.code, at };
      const entry = {
        slot: outcome.slot,
        last,
        lastFailure: outcome.ok ? (all.get(outcome.descriptorId)?.lastFailure ?? null) : last,
      };
      all.set(outcome.descriptorId, entry);
      storage("save", () => store.save({ descriptorId: outcome.descriptorId, ...entry }));
      log("debug", "Connection outcome recorded", {
        feature: outcome.feature,
        ok: outcome.ok,
        code: outcome.code,
      });
      publish();
      return true;
    } catch {
      return false;
    }
  }

  function forget(predicate) {
    const all = load();
    const removed = [...all.entries()].filter(([id, entry]) => predicate(id, entry));
    if (removed.length === 0) return;
    for (const [id] of removed) all.delete(id);
    storage("remove", () => store.remove(removed.map(([id]) => id)));
    publish();
  }

  function clearAll() {
    entries = new Map();
    storage("clear", () => store.clear());
    publish();
  }

  /** environment.js's onSecretChanged: a key written, copied or removed (names only). */
  function noteSecretsChanged(change) {
    try {
      const names = (Array.isArray(change?.names) ? change.names : []).filter(
        (name) => typeof name === "string"
      );
      const at = now();
      for (const name of names) changedAt.set(name, at);
      if (change?.all) {
        // Reset app data: every key, and the Cloud session with them.
        cloudSignedOutAt = at;
        clearAll();
        return;
      }
      const touched = new Set(names);
      forget(
        (_id, entry) => !!entry.slot && sourcesOf(entry.slot).some((name) => touched.has(name))
      );
    } catch {
      // A key save never fails for this.
    }
  }

  /** OpenWhispr Cloud signed out: its outcomes were about that session. */
  function noteCloudSignedOut() {
    try {
      cloudSignedOutAt = now();
      forget((id) => id === "cloud");
    } catch {
      // Signing out never fails for this.
    }
  }

  return { recordConnectionOutcome, list, noteSecretsChanged, noteCloudSignedOut };
}

/** History's database as the outcomes' store (database.js `connection_outcomes`). */
function createDatabaseOutcomeStore(getDatabase) {
  const database = () => {
    const manager = getDatabase();
    if (!manager) throw new Error("Database not initialized");
    return manager;
  };
  return {
    load: () => database().getConnectionOutcomes(),
    save: (row) => database().saveConnectionOutcome(row),
    remove: (ids) => database().deleteConnectionOutcomes(ids),
    clear: () => database().clearConnectionOutcomes(),
  };
}

/**
 * IPC: `connection-outcomes-get` (the outcomes by descriptor id),
 * `connection-outcome-record` (a renderer's request finished; fire and
 * forget) and the `connection-outcomes-changed` broadcast.
 */
function registerConnectionOutcomesIpc({
  ipcMain,
  getDatabase,
  logger = null,
  // Required here, not at load: environment.js reads Electron's app paths.
  onSecretChanged = require("./environment").onSecretChanged,
  emit = (payload) =>
    require("./windowBroadcast").broadcastToWindows("connection-outcomes-changed", payload),
}) {
  const outcomes = createConnectionOutcomes({
    store: createDatabaseOutcomeStore(getDatabase),
    logger,
    emit,
  });
  onSecretChanged?.((change) => outcomes.noteSecretsChanged(change));
  ipcMain.handle("connection-outcomes-get", () => ({ outcomes: outcomes.list() }));
  ipcMain.on("connection-outcome-record", (_event, input) => {
    outcomes.recordConnectionOutcome(input);
  });
  return outcomes;
}

module.exports = {
  createConnectionOutcomes,
  createDatabaseOutcomeStore,
  registerConnectionOutcomesIpc,
  validateOutcome,
};

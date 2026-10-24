// IPC for the custom connection on Settings › AI Connections. Main makes every
// copy of the connection's key (into the feature key slots, or from one for
// "Save as connection") and every comparison, which answers booleans, so no
// slot's key crosses to the renderer for it. Writes are awaited, serialized and
// then announced to every window, the sender included.
const {
  CUSTOM_CONNECTION_SECRET,
  CUSTOM_CONNECTION_SLOTS,
  CUSTOM_CONNECTION_STORE_KEY,
  isCustomConnectionSlot,
  validateEndpoint,
} = require("../config/customConnection.js");
const { BYOK_API_KEYS } = require("../config/secretKeys");
const openWhisprCloudGate = require("./openWhisprCloudGate");

const CHECK_TIMEOUT_MS = 12000;
// The oldest data-plane version that lists a resource's deployments.
const DEPLOYMENTS_API_VERSION = "2022-12-01";
const MAX_DEPLOYMENTS = 200;

// How main reads each slot: the two bespoke accessors, else the manifest's.
const SLOT_GETTERS = Object.freeze({
  CUSTOM_TRANSCRIPTION_API_KEY: "getCustomTranscriptionKey",
  CUSTOM_CLEANUP_API_KEY: "getCleanupCustomKey",
  ...Object.fromEntries(
    BYOK_API_KEYS.filter((entry) => isCustomConnectionSlot(entry.env)).map((entry) => [
      entry.env,
      entry.get,
    ])
  ),
});

// The renderer's value is never echoed: a misplaced key must not end up in an error.
function requireSlots(slots) {
  if (!Array.isArray(slots) || !slots.every(isCustomConnectionSlot)) {
    throw new TypeError("Unknown key slot");
  }
  return [...new Set(slots)];
}

function storeKeyOf(secret) {
  return secret === CUSTOM_CONNECTION_SECRET
    ? CUSTOM_CONNECTION_STORE_KEY
    : CUSTOM_CONNECTION_SLOTS[secret];
}

/**
 * @param {object} deps
 * @param {object} deps.environmentManager  getCustomConnectionKey, the slot getters, persistSecret
 * @param {(storeKeys: string[]) => void} [deps.onKeysChanged]  after a write changed these settings
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {{ assertCloudAllowed: Function, isCloudDisabledError: Function }} [deps.cloudGate]
 * @param {number} [deps.timeoutMs]
 */
function createCustomConnectionHandlers({
  environmentManager,
  onKeysChanged = () => {},
  fetchImpl = (...args) => fetch(...args),
  cloudGate = openWhisprCloudGate,
  timeoutMs = CHECK_TIMEOUT_MS,
}) {
  const read = (secret) =>
    (secret === CUSTOM_CONNECTION_SECRET
      ? environmentManager.getCustomConnectionKey()
      : environmentManager[SLOT_GETTERS[secret]]()) || "";

  // One operation at a time: a save, an apply and a comparison never interleave.
  let queue = Promise.resolve();
  const serialized = (operation) => {
    const run = queue.then(operation);
    queue = run.catch(() => {});
    return run;
  };

  // Writes each value that differs, durably and in order, then announces what changed.
  async function write(entries) {
    const changed = [];
    try {
      for (const [secret, value] of entries) {
        if (read(secret) === value) continue;
        await environmentManager.persistSecret(secret, value);
        changed.push(storeKeyOf(secret));
      }
    } finally {
      if (changed.length > 0) onKeysChanged(changed);
    }
    return { success: true };
  }

  async function request(url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Optional: Azure lists a resource's deployments here. Anything but a list
  // means "unavailable", never a broken connection.
  async function discoverDeployments(origin, key) {
    try {
      const response = await request(
        `${origin}/openai/deployments?api-version=${DEPLOYMENTS_API_VERSION}`,
        key ? { "api-key": key } : {}
      );
      if (!response.ok) return { discovery: "unavailable" };
      const body = await response.json();
      if (!Array.isArray(body?.data)) return { discovery: "unavailable" };
      const deployments = body.data
        .filter((entry) => typeof entry?.id === "string" && entry.id.trim())
        .slice(0, MAX_DEPLOYMENTS)
        .map((entry) => ({
          id: entry.id.trim(),
          model: typeof entry.model === "string" ? entry.model.trim() : "",
        }));
      return { discovery: "listed", deployments };
    } catch {
      return { discovery: "unavailable" };
    }
  }

  // The key a check presents: one typed into the dialog, a feature's (Save as
  // connection, before the copy), or the connection's own.
  async function keyForCheck(args) {
    if (typeof args?.key === "string" && args.key.trim()) return args.key.trim();
    if (args?.fromSlot !== undefined) {
      const [slot] = requireSlots([args.fromSlot]);
      return serialized(() => read(slot));
    }
    return serialized(() => read(CUSTOM_CONNECTION_SECRET));
  }

  async function check(args) {
    const target = validateEndpoint(args?.endpoint);
    if (!target.ok) return { status: "invalid", discovery: "unavailable" };
    try {
      cloudGate.assertCloudAllowed(target.languageBase, "custom connection check");
    } catch (error) {
      if (cloudGate.isCloudDisabledError(error)) {
        return { status: "blocked", discovery: "unavailable" };
      }
      throw error;
    }
    const key = await keyForCheck(args);
    let response;
    try {
      response = await request(
        `${target.languageBase}/models`,
        key ? { Authorization: `Bearer ${key}` } : {}
      );
    } catch {
      return { status: "network", discovery: "unavailable" };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: "auth", httpStatus: response.status, discovery: "unavailable" };
    }
    if (!response.ok) {
      return { status: "network", httpStatus: response.status, discovery: "unavailable" };
    }
    if (target.kind !== "azure") return { status: "ok", discovery: "unavailable" };
    return { status: "ok", ...(await discoverDeployments(target.origin, key)) };
  }

  return {
    getKey: async () => read(CUSTOM_CONNECTION_SECRET),

    /** "Save as connection": the connection takes a feature's saved key. */
    copyKey: async (args) => {
      const [slot] = requireSlots([args?.fromSlot]);
      return serialized(() => write([[CUSTOM_CONNECTION_SECRET, read(slot)]]));
    },

    /** A new key for the connection, also copied into the listed slots. */
    saveKey: async (args) => {
      const key = typeof args?.key === "string" ? args.key.trim() : "";
      if (!key) throw new TypeError("API key must be a non-empty string");
      const slots = requireSlots(args?.applyTo ?? []);
      return serialized(() =>
        write([[CUSTOM_CONNECTION_SECRET, key], ...slots.map((slot) => [slot, key])])
      );
    },

    /** The connection's key, copied into the listed slots. */
    applyKey: async (args) => {
      const slots = requireSlots(args?.slots);
      return serialized(() => {
        const key = read(CUSTOM_CONNECTION_SECRET);
        if (!key) throw new Error("The custom connection has no key");
        return write(slots.map((slot) => [slot, key]));
      });
    },

    /** Whether each slot holds the connection's key. Booleans only. */
    compare: async (args) => {
      const slots = requireSlots(args?.slots);
      return serialized(() => {
        const key = read(CUSTOM_CONNECTION_SECRET);
        return Object.fromEntries(slots.map((slot) => [slot, !!key && read(slot) === key]));
      });
    },

    deleteKey: async () => serialized(() => write([[CUSTOM_CONNECTION_SECRET, ""]])),

    check,
  };
}

function registerCustomConnectionIpc({ ipcMain, ...deps }) {
  const handlers = createCustomConnectionHandlers(deps);
  ipcMain.handle("get-custom-connection-key", () => handlers.getKey());
  ipcMain.handle("custom-connection-copy-key", (_event, args) => handlers.copyKey(args));
  ipcMain.handle("custom-connection-save-key", (_event, args) => handlers.saveKey(args));
  ipcMain.handle("custom-connection-apply-key", (_event, args) => handlers.applyKey(args));
  ipcMain.handle("custom-connection-compare", (_event, args) => handlers.compare(args));
  ipcMain.handle("custom-connection-delete-key", () => handlers.deleteKey());
  ipcMain.handle("custom-connection-check", (_event, args) => handlers.check(args));
  return handlers;
}

module.exports = {
  SLOT_GETTERS,
  createCustomConnectionHandlers,
  registerCustomConnectionIpc,
};

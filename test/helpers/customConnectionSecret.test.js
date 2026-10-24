const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// The custom connection's key is a fixed secret (CUSTOM_CONNECTION_API_KEY):
// it inherits encryption, the plaintext .env fallback and Reset app data, and
// main's copies (persistSecret) are on disk before they resolve.

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-custom-connection-"));
process.resourcesPath = userData;
let encryption = false;
// A stand-in for secretCrypto: reversible, never the OS keychain.
const fakeCrypto = {
  isAvailable: () => encryption,
  encrypt: (value) => Buffer.from(`enc:${value}`),
  decrypt: (buffer) => ({ value: buffer.toString().slice(4), needsReencrypt: false }),
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => userData } };
  if (request === "./secretCrypto") return fakeCrypto;
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(userData, { recursive: true, force: true });
});

const EnvironmentManager = require("../../src/helpers/environment");

const KEY = "CUSTOM_CONNECTION_API_KEY";
const envFile = path.join(userData, ".env");
const secretFile = path.join(userData, "secure-keys", `${KEY}.enc`);

test("the connection's key round-trips through its accessors", () => {
  const env = new EnvironmentManager();
  env.saveCustomConnectionKey("conn-SECRET-1");
  assert.equal(env.getCustomConnectionKey(), "conn-SECRET-1");
  env.saveCustomConnectionKey("");
  assert.equal(env.getCustomConnectionKey(), "");
});

test("without encryption, a copy is in .env before it resolves; Reset app data clears it", async () => {
  encryption = false;
  const env = new EnvironmentManager();
  await env.persistSecret(KEY, "conn-SECRET-2");
  assert.equal(env.getCustomConnectionKey(), "conn-SECRET-2");
  assert.match(fs.readFileSync(envFile, "utf8"), new RegExp(`^${KEY}=conn-SECRET-2$`, "m"));

  await env.persistSecret(KEY, "");
  assert.doesNotMatch(fs.readFileSync(envFile, "utf8"), new RegExp(KEY));

  await env.persistSecret(KEY, "conn-SECRET-3");
  await env.clearAllPersistedData();
  assert.equal(env.getCustomConnectionKey(), "");
  assert.equal(fs.existsSync(envFile), false);
});

test("with encryption, a copy is its own encrypted file; Reset app data deletes it", async () => {
  encryption = true;
  const env = new EnvironmentManager();
  await env.persistSecret(KEY, "conn-SECRET-4");
  assert.equal(fs.readFileSync(secretFile, "utf8"), "enc:conn-SECRET-4");
  assert.equal(env.getCustomConnectionKey(), "conn-SECRET-4");

  // A fresh start reads it back.
  delete process.env[KEY];
  await new EnvironmentManager()._loadAllSecrets();
  assert.equal(process.env[KEY], "conn-SECRET-4");

  await env.clearAllPersistedData();
  assert.equal(fs.existsSync(secretFile), false);
  assert.equal(fs.existsSync(path.join(userData, "secure-keys")), false);
  assert.equal(env.getCustomConnectionKey(), "");
});

test("only secrets are written this way; Cleanup's copy drops the legacy name", async () => {
  encryption = true;
  const env = new EnvironmentManager();
  await assert.rejects(() => env.persistSecret("DICTATION_KEY", "F8"), /Not a secret key/);
  assert.equal(process.env.DICTATION_KEY, undefined);
  process.env.CUSTOM_REASONING_API_KEY = "legacy-SECRET";
  await env.persistSecret("CUSTOM_CLEANUP_API_KEY", "cleanup-SECRET");
  assert.equal(process.env.CUSTOM_REASONING_API_KEY, undefined);
  assert.equal(env.getCleanupCustomKey(), "cleanup-SECRET");
  await env.persistSecret("CUSTOM_CLEANUP_API_KEY", "");
  assert.equal(env.getCleanupCustomKey(), "");
});

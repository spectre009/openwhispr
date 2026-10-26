// The dictation window's transcription bridge as main serves it: the real
// `dictation-transcription-request` / `-cancel` handlers
// (src/helpers/dictationTranscriptionRequest.js) on a fake ipcMain, with a
// connection pool over globalThis.fetch. Suites that mock fetch keep
// exercising the real request path: normalization, deadline, retry, cancel.
const {
  registerDictationTranscriptionIpc,
} = require("../../../src/helpers/dictationTranscriptionRequest.js");

function createDictationTranscriptionBridge({ env = {}, onReset } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, listener) => listeners.set(channel, listener),
  };
  const sender = { id: 1, once() {}, removeListener() {} };
  const pool = {
    fetch: (url, init) => globalThis.fetch(url, init),
    closeAllConnections: async () => onReset?.(),
  };
  registerDictationTranscriptionIpc({ ipcMain, getPool: () => pool, logger: null, env });
  return {
    transcribeDictationRequest: (request) =>
      handlers.get("dictation-transcription-request")({ sender }, request),
    cancelDictationTranscription: (requestId) =>
      listeners.get("dictation-transcription-cancel")({ sender }, requestId),
  };
}

module.exports = { createDictationTranscriptionBridge };

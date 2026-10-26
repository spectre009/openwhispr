// Reads an OpenAI-style streamed transcription (SSE): `transcript.text.delta`
// and `transcript.text.segment` events build the text, `transcript.text.done`
// or `[DONE]` ends it. A terminal event completes the transcript even when the
// server keeps the connection open. Pure: the caller owns the body and the
// clocks. Events hold dictated text, so callers log counts and types only.

const TRANSCRIPT_EVENT_TYPES = new Set([
  "transcript.text.delta",
  "transcript.text.segment",
  "transcript.text.done",
]);

function createTranscriptionEventParser() {
  let buffer = "";
  let pendingData = null;
  let collectedText = "";
  let finalText = null;
  let done = false;
  let transcriptEvents = 0;
  let eventCount = 0;
  const eventTypes = {};

  const handleEvent = (payload) => {
    if (!payload || typeof payload !== "object") return;
    eventCount++;
    const type = typeof payload.type === "string" ? payload.type : "unknown";
    eventTypes[type] = (eventTypes[type] || 0) + 1;
    if (TRANSCRIPT_EVENT_TYPES.has(type)) transcriptEvents++;
    if (type === "transcript.text.delta" && typeof payload.delta === "string") {
      collectedText += payload.delta;
    } else if (type === "transcript.text.segment" && typeof payload.text === "string") {
      collectedText += payload.text;
    } else if (type === "transcript.text.done" && typeof payload.text === "string") {
      finalText = payload.text;
      done = true;
    }
  };

  const handleData = (data) => {
    if (done) return;
    if (pendingData === null && data === "[DONE]") {
      transcriptEvents++;
      finalText = finalText ?? collectedText;
      done = true;
      return;
    }
    // One event's JSON may span several data lines.
    const candidate = pendingData === null ? data : `${pendingData}\n${data}`;
    try {
      handleEvent(JSON.parse(candidate));
      pendingData = null;
    } catch {
      pendingData = candidate;
    }
  };

  const handleLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      // The event ended without valid JSON: drop it.
      pendingData = null;
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("data:")) {
      handleData(line.slice(5).replace(/^ /, "").trim());
    }
  };

  return {
    /** Feeds decoded text; returns true once a terminal event has arrived. */
    push(text) {
      if (done || typeof text !== "string" || text.length === 0) return done;
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && !done) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      return done;
    },
    /** The body ended: reads a last line that had no newline. */
    end() {
      if (!done && buffer) handleLine(buffer);
      buffer = "";
      return done;
    },
    get done() {
      return done;
    },
    /** Whether any transcript event (or `[DONE]`) has arrived. */
    get started() {
      return transcriptEvents > 0;
    },
    text() {
      return finalText ?? collectedText;
    },
    /** Counts only: the events themselves hold dictated text. */
    stats() {
      return {
        eventCount,
        eventTypes: { ...eventTypes },
        usedFinalText: finalText !== null,
        textLength: (finalText ?? collectedText).length,
      };
    },
  };
}

module.exports = { createTranscriptionEventParser };

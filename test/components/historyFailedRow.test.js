const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Untranslated i18n fallback: t() returns the key, so the markup names the string shown.
async function renderFailedRow(t, { errorCode, errorMessage }) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-history-failed-row-test-",
    // The fork's TranscriptionItem loads the settings store, which initializes
    // i18n: t() is mocked to return the key, as the comment above expects.
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t, i18n: { language: "en" } }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
    },
  });
  const [{ default: TranscriptionItem }, { ToastContext }, { default: reasoningService }] =
    await Promise.all([
      vite.ssrLoadModule("/components/ui/TranscriptionItem.tsx"),
      vite.ssrLoadModule("/components/ui/useToast.ts"),
      vite.ssrLoadModule("/services/ReasoningService.ts"),
    ]);
  // The fork's TranscriptionItem (Add to test set) reaches ReasoningService, whose
  // cache timer would keep the file running, and reports through a toast, so the
  // row renders inside a toast context, as it does in the app.
  t.after(() => reasoningService.destroy());
  const toasts = {
    toast: () => "",
    dismiss() {},
    toastCount: 0,
    dictationErrorActionCount: 0,
    dismissByPresentation() {},
  };
  return renderToStaticMarkup(
    createElement(
      ToastContext.Provider,
      { value: toasts },
      createElement(TranscriptionItem, {
        item: {
          id: 1,
          text: "",
          raw_text: null,
          timestamp: "2026-09-25T10:00:00",
          created_at: "2026-09-25T10:00:00",
          has_audio: 1,
          audio_duration_ms: 1200,
          provider: null,
          model: null,
          status: "failed",
          error_message: errorMessage,
          error_code: errorCode,
          client_transcription_id: "row-1",
          cloud_id: null,
          sync_status: "synced",
          deleted_at: null,
        },
        onCopy: () => {},
        onDelete: () => {},
      })
    )
  );
}

// A dictation OpenRouter refused for lack of credit is saved with its raw reply,
// which History printed verbatim under "Transcription failed".
test("a failed row out of OpenRouter credit says so, not the raw reply", async (t) => {
  const html = await renderFailedRow(t, {
    errorCode: "OPENROUTER_OUT_OF_CREDITS",
    errorMessage: `API Error: 402 ${JSON.stringify({
      error: {
        code: 402,
        message: "Insufficient credits. Add more using https://openrouter.ai/credits",
      },
    })}`,
  });

  assert.ok(html.includes("hooks.audioRecording.errorDescriptions.openRouterOutOfCredits"));
  assert.ok(!html.includes("API Error: 402"), "the raw provider reply is not shown");
});

test("other failed rows keep showing the saved error", async (t) => {
  const html = await renderFailedRow(t, {
    errorCode: null,
    errorMessage: "API Error: 500 upstream unavailable",
  });

  assert.ok(html.includes("API Error: 500 upstream unavailable"));
  assert.ok(!html.includes("openRouterOutOfCredits"));
});

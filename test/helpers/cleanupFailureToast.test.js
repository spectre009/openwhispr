const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("cleanup toast localizes AWS recovery guidance and keeps fallback status quieter", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__cleanupFailureToasts;
  });
  globalThis.__cleanupFailureToasts = [];
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cleanup-failure-toast-",
    mockModules: {
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__cleanupFailureToasts.push(props)
        });
      `,
      "/utils/windowContext": `
        export const isDictationPanelWindow = () => false;
      `,
    },
  });
  const { default: CleanupFailureToastListener } = await vite.ssrLoadModule(
    "/components/CleanupFailureToastListener.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("es");
  const { recordCleanupFailure, useCleanupFailureStore } = await vite.ssrLoadModule(
    "/stores/cleanupFailureStore.ts"
  );
  useCleanupFailureStore.setState({ pending: 0, lastMessage: "", lastFailure: null });

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(CleanupFailureToastListener)));

  const failure = {
    message:
      "AWS Bedrock is temporarily unavailable due to high demand. This is an AWS service issue, not an OpenWhispr outage. Please try again in a few minutes.",
    messageKey: "reasoning.enterprise.errors.bedrock.serviceUnavailable",
    action: "Run the command below in your terminal to re-authenticate:",
    actionKey: "reasoning.enterprise.errors.bedrock.actions.reauthenticate",
    copyCommand: "aws sso login --profile company-sso",
    technicalDetails: {
      status: 503,
      exceptionType: "ServiceUnavailableException",
      requestId: "aws-request-503",
      underlyingError: "Bedrock overloaded",
    },
  };
  await React.act(async () => recordCleanupFailure(failure));

  assert.equal(globalThis.__cleanupFailureToasts.length, 1);
  const shown = globalThis.__cleanupFailureToasts[0];
  assert.equal(shown.title, "Limpieza fallida");
  assert.equal(
    shown.description,
    [
      "AWS Bedrock no está disponible temporalmente debido a una alta demanda. Este es un problema del servicio de AWS, no una interrupción de OpenWhispr. Vuelve a intentarlo en unos minutos.",
      "Ejecuta el siguiente comando en tu terminal para volver a autenticarte:",
      "Tu dictado se pegó sin limpieza con IA.",
    ].join("\n")
  );
  assert.equal(shown.variant, "destructive");
  assert.equal(shown.duration, 0, "a failure card stays until dismissed");
  // The recovery command and the technical details are actions now, never dismissing.
  assert.equal(shown.actions.length, 2);
  assert.equal(shown.actions[0].dismissOnClick, false);
  assert.equal(shown.actions[1].iconOnly, true);
  assert.equal(shown.copyCommand, undefined);
  assert.equal(shown.technicalDetails, undefined);
});

test("technical AWS details use the selected UI language", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-technical-error-details-",
  });
  const { TechnicalErrorDetails } = await vite.ssrLoadModule(
    "/components/ui/TechnicalErrorDetails.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("es");

  const markup = renderToStaticMarkup(
    React.createElement(TechnicalErrorDetails, {
      details: {
        status: 503,
        exceptionType: "ServiceUnavailableException",
        requestId: "request-123",
        underlyingError: "Bedrock overloaded",
      },
    })
  );

  assert.match(markup, /Detalles técnicos/);
  assert.match(markup, /Estado HTTP: 503/);
  assert.match(markup, /Excepción de AWS: ServiceUnavailableException/);
  assert.match(markup, /ID de solicitud de AWS: request-123/);
  assert.match(markup, /Error subyacente: Bedrock overloaded/);
  assert.match(markup, /aria-label="Copiar detalles técnicos"/);
});

async function recordClassifiedCleanupFailure(t, { dictationWindow, dictation, openHistoryItem }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__cleanupFailureToasts;
  });
  globalThis.__cleanupFailureToasts = [];
  installBrowserGlobals(t, {
    window: { electronAPI: { ...(openHistoryItem ? { openHistoryItem } : {}) } },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cleanup-failure-toast-llm-",
    mockModules: {
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__cleanupFailureToasts.push(props)
        });
      `,
      "/utils/windowContext": `
        export const isDictationPanelWindow = () => ${dictationWindow};
      `,
    },
  });
  const { default: CleanupFailureToastListener } = await vite.ssrLoadModule(
    "/components/CleanupFailureToastListener.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  const { recordCleanupFailure, useCleanupFailureStore } = await vite.ssrLoadModule(
    "/stores/cleanupFailureStore.ts"
  );
  useCleanupFailureStore.setState({ pending: 0, lastMessage: "", lastFailure: null });

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(CleanupFailureToastListener)));

  await React.act(async () =>
    recordCleanupFailure({
      message: "OpenAI rejected your API key.",
      surface: "llm",
      messageKey: "providerErrors.authFailed",
      messageParams: { provider: "OpenAI" },
      settingsTarget: "llms",
      technicalDetails: { provider: "OpenAI", status: 401 },
      ...(dictation ? { dictation } : {}),
    })
  );
  return globalThis.__cleanupFailureToasts.at(-1);
}

test("a classified cleanup failure says why, then that the dictation went in raw, with Open Settings and Copy details", async (t) => {
  const toastProps = await recordClassifiedCleanupFailure(t, { dictationWindow: false });
  assert.equal(toastProps.title, "Cleanup failed");
  assert.equal(
    toastProps.description,
    "OpenAI rejected your API key.\nOriginal dictation pasted without AI cleanup."
  );
  assert.deepEqual(
    toastProps.actions.map(({ label, iconOnly }) => ({ label, iconOnly })),
    [
      { label: "Open Settings", iconOnly: undefined },
      { label: "Copy details", iconOnly: true },
    ]
  );
  assert.equal(toastProps.technicalDetails, undefined, "details are behind Copy details");
  assert.equal(toastProps.secondaryDescription, undefined);
  assert.equal(toastProps.presentation, undefined);
});

test("in the dictation window a cleanup failure takes the pill's error card and stays", async (t) => {
  const toastProps = await recordClassifiedCleanupFailure(t, { dictationWindow: true });
  assert.equal(toastProps.presentation, "dictation-error");
  assert.equal(
    toastProps.duration,
    0,
    "no timeout: it stays until dismissed or the next dictation"
  );
  assert.equal(toastProps.dismissible, true);
  assert.equal(toastProps.actions.length, 2);
  assert.equal(
    toastProps.actions[0].dismissOnClick,
    false,
    "Open Settings leaves the card up, to come back to"
  );
});

test("Open in History opens the dictation's own saved row, and leaves the card up", async (t) => {
  const opened = [];
  let resolveRow;
  const rowId = new Promise((resolve) => {
    resolveRow = resolve;
  });
  const toastProps = await recordClassifiedCleanupFailure(t, {
    dictationWindow: true,
    dictation: { isCurrent: () => true, rowId },
    openHistoryItem: async (id) => {
      opened.push(id);
      return { opened: true, id };
    },
  });
  const action = toastProps.actions.find((candidate) => candidate.icon === "history");
  assert.ok(action, "the card offers Open in History");
  assert.equal(action.label, "Open in History");
  assert.equal(action.dismissOnClick, false);
  // The save may still be running when the card shows: the click waits for its row.
  const click = action.onClick();
  assert.deepEqual(opened, []);
  resolveRow(41);
  await click;
  assert.deepEqual(opened, [41]);
});

test("a cleanup failure of a dictation a newer one replaced never takes the pill", async (t) => {
  const toastProps = await recordClassifiedCleanupFailure(t, {
    dictationWindow: true,
    dictation: { isCurrent: () => false, rowId: Promise.resolve(7) },
  });
  assert.equal(toastProps, undefined);
});

test("a dictation that wasn't pasted says it's in History, not that it was pasted", async (t) => {
  const toastProps = await recordClassifiedCleanupFailure(t, {
    dictationWindow: true,
    dictation: { isCurrent: () => true, rowId: Promise.resolve(7), pasted: false },
  });
  assert.equal(
    toastProps.description,
    "OpenAI rejected your API key.\nSaved to History without AI cleanup."
  );
});

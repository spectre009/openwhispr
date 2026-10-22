const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// GitHub Copilot's sign-in panel: what each state shows and offers, and that
// nothing but the user's own click opens the browser.

const EXPIRES_IN_MS = 14 * 60 * 1000 + 30 * 1000;

function electronSpies() {
  const calls = { openExternal: [], writeClipboard: [], start: 0, cancel: [], signOut: 0 };
  return {
    calls,
    api: {
      openExternal: async (url) => {
        calls.openExternal.push(url);
        return { success: true };
      },
      writeClipboard: async (text) => {
        calls.writeClipboard.push(text);
        return { success: true };
      },
      startCopilotSignIn: async () => {
        calls.start += 1;
        return { configured: true, state: "signedOut", login: "" };
      },
      cancelCopilotSignIn: async (flowId) => {
        calls.cancel.push(flowId);
        return { configured: true, state: "signedOut", login: "" };
      },
      signOutOfCopilot: async () => {
        calls.signOut += 1;
        return { configured: true, state: "signedOut", login: "" };
      },
    },
  };
}

async function loadPanel(t, electronAPI, cachePrefix) {
  installBrowserGlobals(t, { window: { electronAPI } });
  const vite = await createRendererServer(t, {
    cachePrefix,
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const panel = await vite.ssrLoadModule("/components/settings/CopilotSignIn.tsx");
  const store = await vite.ssrLoadModule("/stores/copilotStore.ts");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  return { ...panel, ...store, i18n, vite };
}

const noop = () => {};
const renderPanel = (CopilotSignInPanel, status, extra = {}) =>
  renderToStaticMarkup(
    React.createElement(CopilotSignInPanel, {
      status,
      onSignIn: noop,
      onCancel: noop,
      onRetry: noop,
      onSignOut: noop,
      ...extra,
    })
  );

// renderToStaticMarkup escapes apostrophes and quotes.
const html = (text) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

test("each sign-in state shows its own words and actions", async (t) => {
  const { calls, api } = electronSpies();
  const { CopilotSignInPanel, i18n } = await loadPanel(t, api, "openwhispr-copilot-panel-test-");
  const tr = (key, params) => html(i18n.t(key, params));

  await t.test("signed out: one line and a sign-in button", () => {
    const markup = renderPanel(CopilotSignInPanel, {
      configured: true,
      state: "signedOut",
      login: "",
    });
    assert.ok(markup.includes(tr("reasoning.copilot.description")));
    assert.ok(markup.includes(tr("reasoning.copilot.signIn")));
    assert.ok(!markup.includes(tr("reasoning.copilot.copyCode")));
  });

  await t.test("waiting: the code, its link and every button, with a countdown", () => {
    const markup = renderPanel(CopilotSignInPanel, {
      configured: true,
      state: "waiting",
      login: "",
      flowId: "flow-1",
      userCode: "B17E-9A24",
      verificationUri: "https://github.com/login/device",
      expiresAt: Date.now() + EXPIRES_IN_MS,
    });
    assert.ok(markup.includes(">B17E-9A24<"), "the code is shown");
    assert.ok(markup.includes(">https://github.com/login/device<"), "the link is shown as text");
    for (const key of [
      "reasoning.copilot.copyCode",
      "reasoning.copilot.copyLink",
      "reasoning.copilot.openInBrowser",
      "reasoning.copilot.waiting",
      "reasoning.copilot.cancel",
    ]) {
      assert.ok(markup.includes(tr(key)), key);
    }
    assert.match(markup, /14:(30|29)/, "the countdown runs to expiresAt");
  });

  await t.test("waiting never shows a link that isn't GitHub's", () => {
    const markup = renderPanel(CopilotSignInPanel, {
      configured: true,
      state: "waiting",
      login: "",
      flowId: "flow-1",
      userCode: "B17E-9A24",
      verificationUri: "https://evil.example/login/device",
      expiresAt: Date.now() + EXPIRES_IN_MS,
    });
    assert.ok(!markup.includes("evil.example"));
    assert.ok(markup.includes(">https://github.com/login/device<"));
  });

  await t.test("checking: the access check, still cancellable", () => {
    const markup = renderPanel(CopilotSignInPanel, {
      configured: true,
      state: "checking",
      login: "octocat",
      flowId: "flow-1",
    });
    assert.ok(markup.includes(tr("reasoning.copilot.checking")));
    assert.ok(markup.includes(tr("reasoning.copilot.cancel")));
  });

  await t.test("signed in: the account, sign-out and the revoke link", () => {
    const markup = renderPanel(CopilotSignInPanel, {
      configured: true,
      state: "signedIn",
      login: "octocat",
    });
    assert.ok(markup.includes(tr("reasoning.copilot.signedInAs", { login: "octocat" })));
    assert.ok(markup.includes(tr("reasoning.copilot.signOut")));
    assert.ok(markup.includes(tr("reasoning.copilot.revoke")));
    assert.ok(!markup.includes(tr("reasoning.copilot.tokenRejected")));
  });

  await t.test("signed in with a rejected token: sign in again", () => {
    const markup = renderPanel(CopilotSignInPanel, {
      configured: true,
      state: "signedIn",
      login: "octocat",
      tokenRejected: true,
    });
    assert.ok(markup.includes(tr("reasoning.copilot.tokenRejected")));
    assert.ok(markup.includes(tr("reasoning.copilot.signIn")));
  });

  await t.test("errors: each code in its own words, never 'no access' for an outage", () => {
    const cases = {
      not_configured: "notConfigured",
      code_expired: "codeExpired",
      oauth_denied: "oauthDenied",
      device_flow_disabled: "deviceFlowDisabled",
      token_exchange_failed: "tokenExchangeFailed",
      rate_limited: "rateLimited",
      network: "network",
      no_access: "noAccess",
      policy_blocked: "policyBlocked",
      check_failed: "checkFailed",
      runtime_failed: "runtimeFailed",
      persist_failed: "persistFailed",
    };
    for (const [error, key] of Object.entries(cases)) {
      const markup = renderPanel(CopilotSignInPanel, {
        configured: error !== "not_configured",
        state: "error",
        login: "",
        error,
      });
      assert.ok(markup.includes(tr(`reasoning.copilot.errors.${key}`)), error);
      if (error !== "no_access") {
        assert.ok(!markup.includes(tr("reasoning.copilot.errors.noAccess")), error);
      }
    }
  });

  await t.test("an expired code offers a fresh start; a kept authorization offers Retry", () => {
    const expired = renderPanel(CopilotSignInPanel, {
      configured: true,
      state: "error",
      login: "",
      error: "code_expired",
    });
    assert.ok(expired.includes(tr("reasoning.copilot.tryAgain")));
    assert.ok(!expired.includes(`>${tr("reasoning.copilot.retry")}<`));

    const outage = renderPanel(CopilotSignInPanel, {
      configured: true,
      state: "error",
      login: "",
      error: "check_failed",
      flowId: "flow-1",
      canRetry: true,
    });
    assert.ok(outage.includes(tr("reasoning.copilot.retry")));
    assert.ok(!outage.includes(tr("reasoning.copilot.tryAgain")));
  });

  assert.deepEqual(calls.openExternal, [], "rendering never opens the browser");
  assert.deepEqual(calls.writeClipboard, []);
  assert.equal(calls.start, 0);
});

test("the mounted panel follows main's status and opens nothing on its own", async (t) => {
  // Registered first so it runs before the browser globals are taken down.
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const { calls, api } = electronSpies();
  let listener = null;
  const waiting = {
    configured: true,
    state: "waiting",
    login: "",
    flowId: "flow-7",
    userCode: "WXYZ-1234",
    verificationUri: "https://github.com/login/device",
    expiresAt: Date.now() + EXPIRES_IN_MS,
  };
  api.getCopilotAuthStatus = async () => waiting;
  api.onCopilotAuthChanged = (callback) => {
    listener = callback;
    return () => {};
  };
  const loaded = await loadPanel(t, api, "openwhispr-copilot-panel-mount-test-");
  const container = installHostDom(t);
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);

  await React.act(async () => root.render(React.createElement(loaded.default)));
  await React.act(async () => {});
  assert.match(container.textContent, /WXYZ-1234/);

  await React.act(async () =>
    listener({ configured: true, state: "checking", login: "", flowId: "flow-7" })
  );
  assert.ok(container.textContent.includes(loaded.i18n.t("reasoning.copilot.checking")));

  await React.act(async () => loaded.cancelCopilotSignIn());
  assert.deepEqual(calls.cancel, ["flow-7"], "Cancel names the attempt it cancels");

  assert.deepEqual(calls.openExternal, [], "the browser opens only on the user's click");
  assert.deepEqual(calls.writeClipboard, []);
  assert.equal(calls.start, 0, "sign-in starts only on the user's click");
});

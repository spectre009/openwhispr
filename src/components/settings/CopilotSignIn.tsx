import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  Loader2,
} from "../icons";
import { Button } from "../ui/button";
import type { CopilotAuthError, CopilotAuthStatus } from "../../types/electron";
import {
  cancelCopilotSignIn,
  retryCopilotSignIn,
  signOutOfCopilot,
  startCopilotSignIn,
  syncCopilotAuthStatus,
  useCopilotStore,
} from "../../stores/copilotStore";

/** GitHub's page for entering a device code. */
const GITHUB_DEVICE_URL = "https://github.com/login/device";
/** Where a GitHub user revokes an OAuth App; signing out here can't, without the app's secret. */
export const GITHUB_OAUTH_APPS_URL = "https://github.com/settings/applications";

const ERROR_KEYS: Record<CopilotAuthError, string> = {
  not_configured: "reasoning.copilot.errors.notConfigured",
  code_expired: "reasoning.copilot.errors.codeExpired",
  oauth_denied: "reasoning.copilot.errors.oauthDenied",
  device_flow_disabled: "reasoning.copilot.errors.deviceFlowDisabled",
  token_exchange_failed: "reasoning.copilot.errors.tokenExchangeFailed",
  rate_limited: "reasoning.copilot.errors.rateLimited",
  network: "reasoning.copilot.errors.network",
  no_access: "reasoning.copilot.errors.noAccess",
  policy_blocked: "reasoning.copilot.errors.policyBlocked",
  check_failed: "reasoning.copilot.errors.checkFailed",
  runtime_failed: "reasoning.copilot.errors.runtimeFailed",
  persist_failed: "reasoning.copilot.errors.persistFailed",
};

// The code is only ever entered on github.com, whatever the payload says.
function deviceUrl(verificationUri: string | undefined): string {
  return verificationUri?.startsWith("https://github.com/") ? verificationUri : GITHUB_DEVICE_URL;
}

function formatRemaining(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useRemaining(expiresAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, expiresAt - now) : null;
}

type CopiedItem = "code" | "link" | null;

function useCopy(): [CopiedItem, (item: Exclude<CopiedItem, null>, text: string) => void] {
  const [copied, setCopied] = useState<CopiedItem>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  const copy = (item: Exclude<CopiedItem, null>, text: string) => {
    void (async () => {
      try {
        const result = await window.electronAPI?.writeClipboard?.(text);
        if (!result?.success) return;
      } catch {
        return; // The text stays on screen to copy by hand.
      }
      setCopied(item);
      clearTimeout(timer.current ?? undefined);
      timer.current = setTimeout(() => setCopied(null), 2000);
    })();
  };
  return [copied, copy];
}

const openExternal = (url: string) => void window.electronAPI?.openExternal?.(url);

export interface CopilotSignInPanelProps {
  status: CopilotAuthStatus;
  /** A sign-in action is waiting on main. */
  pending?: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onSignOut: () => void;
}

/**
 * GitHub Copilot's sign-in, in the language-model picker's Copilot tab. The
 * device code and GitHub's link come with Copy and Open buttons; nothing opens
 * the browser but the user's own click.
 */
export function CopilotSignInPanel({
  status,
  pending = false,
  onSignIn,
  onCancel,
  onRetry,
  onSignOut,
}: CopilotSignInPanelProps): ReactElement {
  const { t } = useTranslation();
  const [copied, copy] = useCopy();
  const remaining = useRemaining(status.state === "waiting" ? status.expiresAt : undefined);
  const spinner = <Loader2 className="h-3.5 w-3.5 animate-spin" />;

  const signInButton = (label: string) => (
    <Button
      type="button"
      size="sm"
      onClick={onSignIn}
      disabled={pending || !status.configured}
      className="h-7 px-3 text-xs"
    >
      {pending && spinner}
      {label}
    </Button>
  );

  const account = (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <CircleCheck className="h-4 w-4 shrink-0 text-success" />
          <span className="truncate text-xs font-medium text-foreground">
            {status.login
              ? t("reasoning.copilot.signedInAs", { login: status.login })
              : t("reasoning.copilot.signedIn")}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onSignOut}
          disabled={pending}
          className="h-7 px-3 text-xs"
        >
          {t("reasoning.copilot.signOut")}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground/70">
        {t("reasoning.copilot.signOutHint")}{" "}
        <Button
          type="button"
          size="sm"
          variant="link"
          className="h-auto p-0 text-xs"
          onClick={() => openExternal(GITHUB_OAUTH_APPS_URL)}
        >
          {t("reasoning.copilot.revoke")}
        </Button>
      </p>
    </div>
  );

  if (status.state === "waiting") {
    const url = deviceUrl(status.verificationUri);
    const code = status.userCode ?? "";
    return (
      <div className="space-y-2.5 rounded-lg border border-border/70 bg-muted/30 p-3 dark:border-white/10">
        <p className="text-xs text-muted-foreground">{t("reasoning.copilot.codeInstructions")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="font-mono text-2xl font-semibold tracking-[0.2em] text-foreground select-all"
            dir="ltr"
          >
            {code}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => copy("code", code)}
            className="h-7 px-3 text-xs"
          >
            {copied === "code" ? <Check /> : <Copy />}
            {copied === "code" ? t("reasoning.copilot.copied") : t("reasoning.copilot.copyCode")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs break-all text-foreground select-all" dir="ltr">
            {url}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => copy("link", url)}
            className="h-7 px-2.5 text-xs"
          >
            {copied === "link" ? <Check /> : <Copy />}
            {copied === "link" ? t("reasoning.copilot.copied") : t("reasoning.copilot.copyLink")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => openExternal(url)}
            className="h-7 px-3 text-xs"
          >
            <ExternalLink />
            {t("reasoning.copilot.openInBrowser")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {spinner}
            <span>{t("reasoning.copilot.waiting")}</span>
            {remaining !== null && (
              <span className="tabular-nums text-muted-foreground/70">
                {t("reasoning.copilot.expiresIn", { time: formatRemaining(remaining) })}
              </span>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onCancel}
            className="h-7 px-3 text-xs"
          >
            {t("reasoning.copilot.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (status.state === "checking") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/30 p-3 dark:border-white/10">
        <div role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {spinner}
          <span>{t("reasoning.copilot.checking")}</span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          className="h-7 px-3 text-xs"
        >
          {t("reasoning.copilot.cancel")}
        </Button>
      </div>
    );
  }

  if (status.state === "signedIn") {
    return (
      <div className="space-y-2">
        {account}
        {status.tokenRejected && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/5 p-2.5"
          >
            <div className="flex min-w-0 items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-xs text-foreground">{t("reasoning.copilot.tokenRejected")}</p>
            </div>
            {signInButton(t("reasoning.copilot.signIn"))}
          </div>
        )}
      </div>
    );
  }

  if (status.state === "error") {
    const error = status.error;
    const canRetry = !!status.canRetry && !!status.flowId;
    return (
      <div className="space-y-2">
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
        >
          <div className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="text-xs text-foreground">
              {t(error ? ERROR_KEYS[error] : "reasoning.copilot.errors.unknown", {
                defaultValue: t("reasoning.copilot.errors.unknown"),
              })}
            </p>
          </div>
          {error !== "not_configured" && (
            <div className="flex flex-wrap items-center gap-2">
              {canRetry ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    onClick={onRetry}
                    disabled={pending}
                    className="h-7 px-3 text-xs"
                  >
                    {pending && spinner}
                    {t("reasoning.copilot.retry")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={onCancel}
                    className="h-7 px-3 text-xs"
                  >
                    {t("reasoning.copilot.cancel")}
                  </Button>
                </>
              ) : (
                signInButton(t("reasoning.copilot.tryAgain"))
              )}
            </div>
          )}
        </div>
        {/* A failed new sign-in leaves an earlier one in place. */}
        {status.login && account}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t("reasoning.copilot.description")}</p>
      {!status.configured && (
        <p className="text-xs text-destructive">{t("reasoning.copilot.errors.notConfigured")}</p>
      )}
      {signInButton(t("reasoning.copilot.signIn"))}
    </div>
  );
}

/** The sign-in panel wired to main through the Copilot store. */
export default function CopilotSignIn(): ReactElement {
  const { t } = useTranslation();
  const status = useCopilotStore((state) => state.status);
  const loaded = useCopilotStore((state) => state.loaded);
  const pending = useCopilotStore((state) => state.pending);

  useEffect(() => {
    void syncCopilotAuthStatus();
  }, []);

  if (!loaded) {
    return (
      <div role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{t("reasoning.copilot.loading")}</span>
      </div>
    );
  }

  return (
    <CopilotSignInPanel
      status={status}
      pending={pending}
      onSignIn={() => void startCopilotSignIn()}
      onCancel={() => void cancelCopilotSignIn()}
      onRetry={() => void retryCopilotSignIn()}
      onSignOut={() => void signOutOfCopilot()}
    />
  );
}

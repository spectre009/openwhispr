import { useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, CheckCircle, Lock, X, XCircle, Zap } from "../icons";
import { Button } from "../ui/button";
import { GetApiKeyLink } from "../ui/GetApiKeyLink";
import { cn } from "../lib/utils";
import { useOpenSettingsLink } from "./settingsLink";
import {
  ConnectionHealthContext,
  checkAge,
  hasState,
  stateLabel,
  type OwnerHealthView,
} from "./connectionCheckContext";
import {
  STATE_TONE,
  affectedUses,
  summarizeHealth,
  type HealthState,
  type HealthSummary,
  type HealthTone,
  type OwnerHealth,
} from "./connectionHealth";
import { USAGE_FEATURE_TITLE_KEYS } from "./connectionUsage";
import type { ConnectionCheckResult } from "../../types/electron";

/**
 * Connection checks' parts on Settings › AI Connections (connectionHealth.ts
 * is the model, connectionCheckContext.ts the page's context): the summary
 * above Connections with Check all, each card's and row's pill with its age
 * and Check button (the previous result stays, with a spinner, while a check
 * runs), a problem box saying what failed, step by step, what it affects and
 * what to do, and the ✓/✕ a model chip gets when its model was compared.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * A card's or row's pill and Check (`useOwnerHealth`), for its header or line;
 * nothing when it doesn't show one.
 */
export function OwnerHealthPill({
  view,
  name,
  checkButton = true,
}: {
  view: OwnerHealthView | null;
  name: string;
  checkButton?: boolean;
}) {
  if (!view?.showPill) return null;
  return (
    <>
      {hasState(view.health) && <HealthPill health={view.health} now={view.now} />}
      {view.probed && checkButton && (
        <CheckButton onCheck={view.check} checking={view.health.checking} name={name} />
      )}
    </>
  );
}

/** What a card's or row's check found: the note on a working one, the problem box on a failing one. */
export function OwnerHealthDetails({
  view,
  name,
  actions = {},
  note = true,
}: {
  view: OwnerHealthView | null;
  name: string;
  actions?: Omit<ProblemActions, "onCheck">;
  note?: boolean;
}) {
  if (!view?.probed) return null;
  return (
    <>
      {note && <HealthNote health={view.health} />}
      <HealthProblem
        health={view.health}
        name={name}
        actions={{ ...actions, onCheck: view.check }}
      />
    </>
  );
}

function ToneIcon({ tone, className }: { tone: HealthTone; className?: string }) {
  const classes = cn("h-3 w-3 shrink-0", className);
  if (tone === "ok") return <Check aria-hidden="true" className={classes} />;
  if (tone === "danger") return <X aria-hidden="true" className={classes} />;
  if (tone === "warning") return <AlertTriangle aria-hidden="true" className={classes} />;
  return null;
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary"
    />
  );
}

const PILL_TONE: Record<HealthTone, string> = {
  ok: "border-success/30 bg-success/10 text-success",
  danger: "border-destructive/35 bg-destructive/10 text-destructive",
  warning: "border-warning/35 bg-warning/10 text-warning",
  muted: "border-border/70 bg-muted/40 text-muted-foreground dark:border-white/10",
};

/**
 * A card's or row's check: "✓ Key works · 1 min ago". While a check runs the
 * previous result stays, with a small spinner; with none yet it says
 * "Checking…".
 */
export function HealthPill({ health, now }: { health: OwnerHealth; now: number }) {
  const { t, i18n } = useTranslation();
  const managed = health.notChecked === "managed";
  const shownState: HealthState = health.state;
  const unchecked = shownState === "unchecked";
  let label: string;
  if (unchecked) {
    label = t(
      health.checking ? "connections.health.states.checking" : "connections.health.states.unchecked"
    );
  } else {
    label = stateLabel(t, health);
    if (health.checkedAt && shownState !== "notChecked") {
      label = t("connections.health.withAge", {
        state: label,
        ago: checkAge(health.checkedAt, now, i18n.language),
      });
    }
  }
  return (
    <span
      data-connection-health={shownState}
      data-connection-health-tone={health.tone}
      data-checking={health.checking ? "" : undefined}
      role="status"
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4",
        managed
          ? "border-primary/25 bg-primary/8 text-primary dark:bg-primary/12"
          : PILL_TONE[health.tone]
      )}
    >
      {health.checking && <Spinner />}
      {managed ? (
        <Lock aria-hidden="true" className="h-3 w-3 shrink-0" />
      ) : (
        !health.checking && <ToneIcon tone={health.tone} />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** "⚡ Check": an explicit, fresh check of this card or row. */
export function CheckButton({
  onCheck,
  checking,
  name,
  disabled = false,
  "data-custom-connection-check": customAttr,
}: {
  onCheck: () => void;
  checking: boolean;
  name: string;
  disabled?: boolean;
  "data-custom-connection-check"?: string;
}) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 shrink-0 px-2.5 text-xs"
      disabled={checking || disabled}
      onClick={onCheck}
      aria-label={t("connections.health.checkAria", { name })}
      data-connection-check=""
      data-custom-connection-check={customAttr}
    >
      <Zap className="h-3 w-3" />
      {t(checking ? "connections.health.checking" : "connections.health.check")}
    </Button>
  );
}

/** ✓ or ✕ on a model chip, when the check compared that model. */
export function ModelMark({ mark }: { mark: "offered" | "missing" | null }) {
  const { t } = useTranslation();
  if (!mark) return null;
  return mark === "offered" ? (
    <span
      data-model-mark="offered"
      className="text-success"
      title={t("connections.health.marks.offered")}
    >
      <Check aria-hidden="true" className="h-3 w-3" />
      <span className="sr-only">{t("connections.health.marks.offered")}</span>
    </span>
  ) : (
    <span
      data-model-mark="missing"
      className="text-destructive"
      title={t("connections.health.marks.missing")}
    >
      <X aria-hidden="true" className="h-3 w-3" />
      <span className="sr-only">{t("connections.health.marks.missing")}</span>
    </span>
  );
}

interface Step {
  ok: boolean;
  text: string;
}

function partSteps(
  t: Translate,
  result: ConnectionCheckResult,
  host: string,
  kind: string
): Step[] {
  const steps: Step[] = [];
  const where = host || t("connections.health.steps.theServer");
  if (result.code === "PROVIDER_TIMEOUT") {
    steps.push({ ok: false, text: t("connections.health.steps.noAnswer", { host: where }) });
  } else if (!result.reachable && result.httpStatus) {
    steps.push({
      ok: false,
      text: t("connections.health.steps.status", { host: where, status: result.httpStatus }),
    });
  } else if (!result.reachable) {
    steps.push({ ok: false, text: t("connections.health.steps.unreachable", { host: where }) });
  } else {
    steps.push({ ok: true, text: t("connections.health.steps.reachable", { host: where }) });
  }
  if (result.code === "CHECK_REDIRECTED") {
    steps.push({ ok: false, text: t("connections.health.steps.redirected", { host: where }) });
  }
  if (result.code === "CHECK_ENDPOINT_NOT_FOUND") {
    steps.push({
      ok: false,
      text: t("connections.health.steps.status", { host: where, status: result.httpStatus ?? 404 }),
    });
  }
  if (result.credentials === "accepted") {
    steps.push({
      ok: true,
      text: t(
        kind === "copilot"
          ? "connections.health.steps.signInAccepted"
          : "connections.health.steps.keyAccepted"
      ),
    });
    if (result.proof === "service") {
      steps.push({ ok: true, text: t("connections.health.steps.copilotListed") });
    }
  } else if (result.credentials === "rejected") {
    steps.push({
      ok: false,
      text:
        result.code === "CHECK_MANAGEMENT_KEY"
          ? t("connections.health.steps.managementKey")
          : result.code === "CHECK_KEY_BLOCKED"
            ? t("connections.health.steps.keyBlocked")
            : t("connections.health.steps.keyRejected", { status: result.httpStatus ?? 401 }),
    });
  } else if (
    result.reachable &&
    result.httpStatus &&
    result.code !== "OK" &&
    result.code !== "CHECK_NOT_VERIFIABLE" &&
    result.code !== "CHECK_ENDPOINT_NOT_FOUND"
  ) {
    steps.push({
      ok: false,
      text: t("connections.health.steps.status", { host: where, status: result.httpStatus }),
    });
  }
  for (const [model, evidence] of Object.entries(result.models)) {
    if (evidence === "offered") {
      steps.push({ ok: true, text: t("connections.health.steps.modelOffered", { model }) });
    } else if (evidence === "missing") {
      steps.push({ ok: false, text: t("connections.health.steps.modelMissing", { model }) });
    }
  }
  if (result.limit) {
    steps.push({
      ok: !result.limit.reached,
      text: t("connections.health.steps.limit", {
        remaining: formatUsd(result.limit.remaining ?? 0),
        amount: formatUsd(result.limit.amount),
      }),
    });
  }
  return steps;
}

function formatUsd(value: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

export interface ProblemActions {
  /** Opens the key's replace field (or dialog). */
  onReplaceKey?: () => void;
  keyUrl?: string;
  onRemove?: () => void;
  /** Where the endpoint is edited: a callback, or a Settings destination. */
  onEditEndpoint?: () => void;
  editEndpointDestination?: string;
  onSignIn?: () => void;
  onCheck: () => void;
}

const PROBLEM_TITLE_KEYS: Partial<Record<HealthState, string>> = {
  rejected: "connections.health.problems.rejected",
  managementKey: "connections.health.problems.managementKey",
  unreachable: "connections.health.problems.unreachable",
  endpointNotFound: "connections.health.problems.endpointNotFound",
  modelMissing: "connections.health.problems.modelMissing",
  rateLimited: "connections.health.problems.rateLimited",
  limitReached: "connections.health.problems.limitReached",
  outOfCredit: "connections.health.problems.outOfCredit",
  accessDenied: "connections.health.problems.accessDenied",
  unexpected: "connections.health.problems.unexpected",
};

/**
 * What failed, step by step (✓/✕ and the HTTP status), whether a feature is
 * affected, and what to do. Shown under a card or row whose check found a
 * problem; nothing for a working or unchecked one.
 */
export function HealthProblem({
  health,
  name,
  actions,
}: {
  health: OwnerHealth;
  name: string;
  actions: ProblemActions;
}) {
  const { t } = useTranslation();
  const openSettings = useOpenSettingsLink();
  const tone = STATE_TONE[health.state];
  const titleKey = PROBLEM_TITLE_KEYS[health.state];
  if ((tone !== "danger" && tone !== "warning") || !titleKey) return null;
  const worst = health.parts.find((part) => part.state === health.state);
  const host = worst?.target.host || name;
  const affected = affectedUses(health);
  const featureName = (feature: keyof typeof USAGE_FEATURE_TITLE_KEYS) =>
    t(USAGE_FEATURE_TITLE_KEYS[feature]);
  const missing = health.state === "modelMissing" ? affected : [];
  const firstMissing = missing[0];
  const title =
    health.state === "modelMissing" && firstMissing
      ? t(titleKey, { feature: featureName(firstMissing.feature), model: firstMissing.model, name })
      : t(titleKey, { name, host, status: worst?.result?.httpStatus ?? "" });
  const hint = t(`${titleKey}Hint`, {
    name,
    host,
    feature: firstMissing ? featureName(firstMissing.feature) : "",
  });
  const multi = health.parts.length > 1;
  const steps = health.parts.flatMap((part) => {
    if (!part.result) return [];
    const list = partSteps(t, part.result, part.target.host, part.target.descriptor.kind);
    if (!multi || !part.target.part) return list;
    const prefix = t(
      part.target.part === "llm"
        ? "connections.health.steps.languageModels"
        : "connections.health.steps.speechToText"
    );
    return list.map((step) => ({ ...step, text: `${prefix}: ${step.text}` }));
  });
  const failing = health.state !== "modelMissing";
  const keyProblem = health.state === "rejected" || health.state === "managementKey";
  const endpointProblem = health.state === "unreachable" || health.state === "endpointNotFound";

  return (
    <div
      data-connection-problem={health.state}
      role="group"
      aria-label={title}
      className={cn(
        "rounded-md border px-3 py-2 text-xs leading-relaxed text-foreground/90",
        tone === "danger"
          ? "border-destructive/30 bg-destructive/10"
          : "border-warning/30 bg-warning/10"
      )}
    >
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-muted-foreground">
        {hint}{" "}
        {failing &&
          (affected.length > 0
            ? t("connections.health.problems.affected", {
                features: affected.map((use) => featureName(use.feature)).join(", "),
              })
            : t("connections.health.problems.notAffected"))}
      </p>
      {steps.length > 0 && (
        <ul className="mt-1.5 space-y-0.5" data-connection-steps="">
          {steps.map((step, index) => (
            <li key={index} className="flex items-start gap-1.5">
              {step.ok ? (
                <CheckCircle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0 text-success" />
              ) : (
                <XCircle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
              )}
              <span dir="auto">{step.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2" data-connection-problem-actions="">
        {keyProblem && actions.onReplaceKey && (
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={actions.onReplaceKey}
            data-problem-action="replaceKey"
          >
            {t("connections.health.actions.replaceKey")}
          </Button>
        )}
        {keyProblem && actions.onSignIn && (
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={actions.onSignIn}
            data-problem-action="signIn"
          >
            {t("connections.health.actions.signIn")}
          </Button>
        )}
        {keyProblem && actions.keyUrl && (
          <GetApiKeyLink
            url={actions.keyUrl}
            labelKey="connections.health.actions.getKey"
            className="text-xs text-link underline decoration-link/30 hover:decoration-link/60"
          />
        )}
        {keyProblem && actions.onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={actions.onRemove}
            data-problem-action="remove"
          >
            {t("connections.health.actions.remove")}
          </Button>
        )}
        {missing.map((use) =>
          openSettings ? (
            <Button
              key={use.feature}
              type="button"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => openSettings(use.edit)}
              data-problem-action="chooseModel"
            >
              {t("connections.health.actions.chooseModel", { feature: featureName(use.feature) })}
            </Button>
          ) : null
        )}
        {endpointProblem && (actions.onEditEndpoint || actions.editEndpointDestination) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              if (actions.onEditEndpoint) actions.onEditEndpoint();
              else if (actions.editEndpointDestination) {
                openSettings?.(actions.editEndpointDestination);
              }
            }}
            data-problem-action="editEndpoint"
          >
            {t("connections.health.actions.editEndpoint")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={health.checking}
          onClick={actions.onCheck}
          data-problem-action="checkAgain"
        >
          {t("connections.health.actions.checkAgain")}
        </Button>
      </div>
    </div>
  );
}

/**
 * A short line about what a working check proved and didn't: Copilot's
 * automatic check is a sign-in, Tinfoil's key isn't verifiable, Azure Speech's
 * model is checked when you dictate, an OpenRouter key's own spending limit.
 */
export function HealthNote({ health }: { health: OwnerHealth }) {
  const { t } = useTranslation();
  const lines: string[] = [];
  for (const part of health.parts) {
    const { result, target } = part;
    if (!result || STATE_TONE[part.state] !== "ok") continue;
    const kind = target.descriptor.kind;
    if (kind === "copilot" && result.proof === "identity") {
      lines.push(t("connections.health.notes.copilotIdentity"));
    }
    if (kind === "tinfoil") lines.push(t("connections.health.notes.tinfoil"));
    if (kind === "azure-speech" && target.descriptor.models.length > 0) {
      lines.push(
        t("connections.health.notes.azureSpeech", { model: target.descriptor.models.join(", ") })
      );
    }
    if (result.limit && !result.limit.reached) {
      lines.push(
        t("connections.health.steps.limit", {
          remaining: formatUsd(result.limit.remaining ?? 0),
          amount: formatUsd(result.limit.amount),
        })
      );
    }
  }
  if (lines.length === 0) return null;
  return (
    <p data-connection-health-note="" className="text-[11px] text-muted-foreground">
      {lines.join(" ")}
    </p>
  );
}

/**
 * The line above Connections: "Checking N connections…" with a spinner, then
 * "All N keys work" or "N connections have a problem" with counts, when it
 * was checked, and Check all. Red when a connection a feature uses fails,
 * amber for anything else wrong.
 */
export function ConnectionsHealthSummary() {
  const context = useContext(ConnectionHealthContext);
  if (!context) return null;
  return (
    <HealthSummaryLine
      summary={summarizeHealth(context.plan, context.results, context.pending)}
      now={context.now}
      onCheckAll={context.checkAll}
    />
  );
}

export function HealthSummaryLine({
  summary,
  now,
  onCheckAll,
}: {
  summary: HealthSummary;
  now: number;
  onCheckAll: () => void;
}) {
  const { t, i18n } = useTranslation();
  const checking = summary.checking > 0;
  const bad = summary.problems + summary.warnings;
  let headline: ReactNode;
  if (summary.total === 0) headline = t("connections.health.summary.none");
  else if (checking)
    headline = t("connections.health.summary.checking", { count: summary.checking });
  else if (!summary.checkedAt) headline = t("connections.health.summary.notChecked");
  else if (summary.problems > 0) {
    headline = t("connections.health.summary.problems", { count: summary.problems });
  } else if (summary.warnings > 0) {
    headline = t("connections.health.summary.warnings", { count: summary.warnings });
  } else headline = t("connections.health.summary.allWork", { count: summary.working });

  const tone = checking ? "muted" : summary.tone;
  return (
    <div
      data-setting-id="connections.status"
      data-connection-health-summary={tone}
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3.5 py-2.5",
        tone === "danger"
          ? "border-destructive/35 bg-destructive/[0.06]"
          : tone === "warning"
            ? "border-warning/35 bg-warning/[0.06]"
            : "border-border/70 bg-card/50 dark:border-border-subtle/70 dark:bg-surface-2/50"
      )}
    >
      {checking ? (
        <Spinner />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "inline-block h-2 w-2 shrink-0 rounded-full",
            tone === "danger"
              ? "bg-destructive"
              : tone === "warning"
                ? "bg-warning"
                : tone === "ok"
                  ? "bg-success"
                  : "bg-muted-foreground/50"
          )}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{headline}</p>
        <p className="text-[11px] text-muted-foreground">
          {summary.checkedAt && !checking
            ? `${t("connections.health.summary.checkedAgo", {
                ago: checkAge(summary.checkedAt, now, i18n.language),
              })} `
            : ""}
          {t("connections.health.summary.free")}
        </p>
      </div>
      {summary.total > 0 && !checking && summary.checkedAt && (
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          {summary.working > 0 && (
            <span data-summary-count="working">
              {t("connections.health.summary.working", { count: summary.working })}
            </span>
          )}
          {summary.problems > 0 && (
            <span data-summary-count="problems" className="text-destructive">
              {t("connections.health.summary.problemCount", { count: summary.problems })}
            </span>
          )}
          {summary.warnings > 0 && (
            <span data-summary-count="warnings" className="text-warning">
              {t("connections.health.summary.warningCount", { count: summary.warnings })}
            </span>
          )}
          {bad === 0 && summary.notChecked > 0 && (
            <span data-summary-count="notChecked">
              {t("connections.health.summary.notCheckedCount", { count: summary.notChecked })}
            </span>
          )}
        </div>
      )}
      {summary.total > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={checking}
          onClick={onCheckAll}
          data-connection-check-all=""
        >
          <Zap className="h-3 w-3" />
          {t("connections.health.summary.checkAll")}
        </Button>
      )}
    </div>
  );
}

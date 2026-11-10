import type {
  ProcessInventoryHistory,
  ProcessInventoryProcess,
  ProcessInventoryRecording,
  ProcessInventorySnapshot,
  ProcessInventoryUnavailable,
  ProcessRole,
} from "../../types/electron";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { formatCount } from "./storageFormat";
import { formatProcessTime } from "./processInventoryFormat";

// Processes & resources' texts that depend on the data: a role's name, the
// parameters its "why" and "goes away" texts take, and why a number shows
// "—". React-free (takes `t`).

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** What every part of the page reads from the latest sample. */
export interface ProcessPageContext {
  snapshot: ProcessInventorySnapshot;
  history: ProcessInventoryHistory | null;
  lastRecording: ProcessInventoryRecording | null;
  unavailable: readonly ProcessInventoryUnavailable[];
  /** False off Windows: committed memory, graphics and Windows objects aren't shown (one note says so). */
  windowsNumbers: boolean;
  locale: string;
}

export const P = "settingsPage.processes";

export const roleName = (t: Translate, role: ProcessRole) => t(`${P}.roles.${role}.name`);

/**
 * The raw parameters main filled in, ready for the texts: times in the UI
 * language, the hotkey as the app shows it, numbers localized.
 */
export function aboutParams(
  params: Record<string, string | number | boolean | null>,
  locale: string,
  now: number
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined) continue;
    if ((key === "since" || key === "stopsAt") && typeof value === "number") {
      out[key] = formatProcessTime(value, locale, now);
    } else if (key === "hotkey" && typeof value === "string") {
      out[key] = formatHotkeyLabel(value);
    } else if (typeof value === "number") {
      out[key] = formatCount(value, locale);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

export type ProcessField =
  | "ws"
  | "priv"
  | "peak"
  | "cpuPct"
  | "cpuAvg"
  | "cpuSec"
  | "gpuDedicated"
  | "gpuUse"
  | "handles"
  | "gdi"
  | "user"
  | "threads";

/** Why a process's number shows "—". */
export function missingReason(
  field: ProcessField,
  row: ProcessInventoryProcess,
  ctx: ProcessPageContext,
  t: Translate
): string {
  const helper = ctx.snapshot.helper;
  const helperDown = helper.status !== "ok";
  switch (field) {
    case "ws":
    case "priv":
    case "peak":
      if (ctx.unavailable.includes("memory")) return t(`${P}.unavailable.memory`);
      if (field === "priv" && !ctx.windowsNumbers) return t(`${P}.details.notAvailable`);
      return t(`${P}.unavailable.notRead`);
    case "cpuPct":
      return row.cpuSec === null
        ? t(`${P}.unavailable.notRead`)
        : t(`${P}.unavailable.firstSample`);
    case "cpuAvg":
    case "cpuSec":
      return t(`${P}.unavailable.notRead`);
    case "gpuDedicated":
    case "gpuUse":
      if (!ctx.windowsNumbers) return t(`${P}.details.notAvailable`);
      if (helperDown) return t(`${P}.unavailable.helper`);
      if (helper.gpu === "failed") return t(`${P}.unavailable.gpuCounters`);
      return field === "gpuUse" ? t(`${P}.unavailable.gpuUse`) : t(`${P}.unavailable.gpuNotRead`);
    default:
      if (!ctx.windowsNumbers) return t(`${P}.details.notAvailable`);
      return helperDown ? t(`${P}.unavailable.helper`) : t(`${P}.unavailable.notRead`);
  }
}

/**
 * The row's second line: its program (or Electron's process type), PID, for a
 * key listener its hotkey, and "+ console host" when one is folded in.
 */
export function processSubline(row: ProcessInventoryProcess, t: Translate): string {
  const parts: string[] = [];
  const program = row.exe ?? row.type;
  if (program) parts.push(program);
  parts.push(t(`${P}.table.pid`, { pid: row.pid }));
  const hotkey = row.about?.whyParams?.hotkey;
  if (row.role === "keyListener" && typeof hotkey === "string" && hotkey) {
    parts.push(formatHotkeyLabel(hotkey));
  }
  if (row.includes?.some((part) => part.role === "consoleHost")) {
    parts.push(t(`${P}.table.plusConsoleHost`));
  }
  return parts.join(" · ");
}

/** The row's state pill: a hidden window, a busy Copilot runtime, or when an idle one stops. */
export function processState(row: ProcessInventoryProcess, t: Translate): string | null {
  if (row.state === "hidden") return t(`${P}.table.states.hidden`);
  if (row.state === "busy") return t(`${P}.table.states.busy`);
  const minutes = row.about?.goesAwayParams?.minutes;
  if (row.role === "copilotRuntime" && typeof minutes === "number") {
    return t(`${P}.table.states.stopsIn`, { minutes });
  }
  return null;
}

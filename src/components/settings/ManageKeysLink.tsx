import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "../icons";
import { cn } from "../lib/utils";
import { useOpenSettingsLink } from "./settingsLink";
import { connectionDestination, findConnectionProvider } from "./connectionProviders";

/** A small in-Settings link: opens a destination and lands on its setting. Hidden outside Settings. */
export function SettingsLink({
  destination,
  children,
  className,
}: {
  destination: string;
  children: ReactNode;
  className?: string;
}) {
  const openSettings = useOpenSettingsLink();
  if (!openSettings) return null;
  return (
    <button
      type="button"
      onClick={() => openSettings(destination)}
      className={cn(
        "inline-flex items-center gap-0.5 text-xs text-link underline decoration-link/30 hover:decoration-link/60 transition-colors",
        className
      )}
    >
      {children}
      <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 rtl:rotate-180" />
    </button>
  );
}

/**
 * "Manage keys in AI Connections ›" under a feature's model picker, or beside
 * a speech-to-text key field: opens that provider's card.
 */
export default function ManageKeysLink({
  provider,
  className,
}: {
  provider: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const card = findConnectionProvider(provider);
  if (!card) return null;
  return (
    <SettingsLink destination={connectionDestination(card.id)} className={className}>
      {t("connections.manageKeys")}
    </SettingsLink>
  );
}

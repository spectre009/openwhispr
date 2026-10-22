import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { useToast } from "../ui/useToast";
import {
  setOpenWhisprCloudDisabled,
  useOpenWhisprCloudDisabled,
} from "../../stores/openWhisprCloudStore";

/**
 * Privacy & Data → "OpenWhispr account & Cloud". On (the default) is upstream
 * behavior; off hides every account and Cloud surface and blocks all traffic
 * to OpenWhispr's servers (enforced in main by openWhisprCloudGate.js).
 */
export function OpenWhisprCloudSwitch({ isSignedIn }: { isSignedIn: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const cloudDisabled = useOpenWhisprCloudDisabled();
  const [saving, setSaving] = useState(false);

  const handleChange = async (allowed: boolean) => {
    setSaving(true);
    try {
      const result = await setOpenWhisprCloudDisabled(!allowed);
      if (result.success) return;
      if (result.code === "SIGNED_IN") {
        toast({
          title: t("settingsPage.openWhisprCloud.signedInTitle"),
          description: t("settingsPage.openWhisprCloud.signedInBody"),
          variant: "destructive",
        });
      } else {
        toast({
          title: t("settingsPage.openWhisprCloud.persistFailedTitle"),
          description: t("settingsPage.openWhisprCloud.persistFailedBody"),
          variant: "destructive",
        });
      }
    } finally {
      setSaving(false);
    }
  };

  // Main refuses while a sign-in is stored; signed in, the toggle says so up front.
  const blockedBySignIn = isSignedIn && !cloudDisabled;

  return (
    <SettingsPanel className="mb-4">
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.openWhisprCloud.label")}
          description={
            blockedBySignIn
              ? `${t("settingsPage.openWhisprCloud.description")} ${t("settingsPage.openWhisprCloud.signedInHint")}`
              : t("settingsPage.openWhisprCloud.description")
          }
        >
          <Toggle
            checked={!cloudDisabled}
            disabled={saving || blockedBySignIn}
            onChange={(allowed) => void handleChange(allowed)}
          />
        </SettingsRow>
      </SettingsPanelRow>
    </SettingsPanel>
  );
}

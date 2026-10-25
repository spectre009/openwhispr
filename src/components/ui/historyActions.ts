import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./useToast";
import { pinHistoryTestCase, storageNoticeKey } from "../../stores/promptTestSetStore";
import { getCachedPlatform } from "../../utils/platform";

// Row actions Home (TranscriptionItem) and the History view share.

/** "Show in Explorer", "Reveal in Finder" or "Show in File Manager". */
export function showInFolderLabelKey(platform: string = getCachedPlatform()): string {
  if (platform === "win32") return "controlPanel.history.showInFolderWindows";
  if (platform === "linux") return "controlPanel.history.showInFolderLinux";
  return "controlPanel.history.showInFolder";
}

/**
 * Add to test set: main copies the row's raw transcript into a test case. The
 * cleaned text is never used as the input, so a row without a raw transcript
 * can't be pinned.
 */
export function useAddToTestSet(): (id: number) => Promise<void> {
  const { t } = useTranslation();
  const { toast } = useToast();
  return useCallback(
    async (id: number) => {
      const result = await pinHistoryTestCase(id);
      if (!result.success) {
        toast({
          title: t("controlPanel.history.testSet.failed"),
          description:
            result.code === "NO_RAW_TEXT" ? t("controlPanel.history.testSet.noRawText") : undefined,
          variant: "destructive",
        });
      } else if (result.duplicate) {
        toast({ title: t("controlPanel.history.testSet.already") });
      } else if (result.durable) {
        toast({
          title: t("controlPanel.history.testSet.added"),
          description: t("controlPanel.history.testSet.addedDescription"),
          variant: "success",
        });
      } else {
        toast({
          title: t("controlPanel.history.testSet.addedSession"),
          description: t(storageNoticeKey(result.reason)),
        });
      }
    },
    [t, toast]
  );
}

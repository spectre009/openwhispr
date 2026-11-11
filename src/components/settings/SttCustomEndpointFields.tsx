import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { filterByokProviderOptionsByPolicy } from "../../stores/policyRules";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { API_ENDPOINTS, normalizeBaseUrl } from "../../config/constants";
import { isAzureOpenAIEndpoint } from "../../utils/urlUtils";
import { useConnectionAutoCheck } from "../../hooks/useConnectionAutoCheck";
import { useFocusHold } from "../../hooks/useFocusHold";
import { useTypingPause } from "../../hooks/useTypingPause";
import { Button } from "../ui/button";
import ApiKeyInput from "../ui/ApiKeyInput";
import { ConnectionCheckAnnouncer } from "../ui/ConnectionCheckAnnouncer";
import { ProviderCheckField } from "../ui/ProviderCheckField";
import { usePanelVisible } from "../ui/usePanelVisible";
import {
  STT_SURFACE_CONTEXT,
  sttSurfaceProviders,
  type SttSurface,
} from "./modelPicker/sttOptions";
import { rawSttCloudProvider } from "./modelPicker/selectStt";

export interface SttCustomEndpointFieldsProps {
  surface: SttSurface;
  /** The URL the surface runs on its custom endpoint (File Transcription may borrow Recognition's). */
  inheritedUrl: string;
  /** The model it runs there, likewise. */
  inheritedModel: string;
  /** A model typed into the field: it commits through the selection adapter. */
  onModel: (model: string) => void;
}

/**
 * The custom endpoint's fields, as the old Custom tab had them: the URL (written
 * as typed; normalized on blur once the endpoint is picked, and switched to the
 * matching provider when it is one of theirs), the one key every speech-to-text
 * custom endpoint shares (replace-only, never shown), and the model, which
 * commits through the adapter.
 *
 * Once the endpoint runs with a model, it checks itself (#2652): 0.5 s after the
 * last change, never while the address is being edited, and only while its page
 * shows. The model field holds the status (a model the server doesn't list is
 * the field's fault); a server that refuses a check sent without a key says it
 * wants one. Azure endpoints aren't checked: the check speaks only OpenAI's API.
 */
export default function SttCustomEndpointFields({
  surface,
  inheritedUrl,
  inheritedModel,
  onModel,
}: SttCustomEndpointFieldsProps) {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const upload = surface === "fileTranscription";
  const rawUrl = useSettingsStore((s) =>
    upload ? s.uploadCloudTranscriptionBaseUrl : s.cloudTranscriptionBaseUrl
  );
  const rawProvider = useSettingsStore((s) => rawSttCloudProvider(surface, s));
  const rawModel = useSettingsStore((s) =>
    upload ? s.uploadCloudTranscriptionModel : s.cloudTranscriptionModel
  );
  const setUrl = useSettingsStore((s) =>
    upload ? s.setUploadCloudTranscriptionBaseUrl : s.setCloudTranscriptionBaseUrl
  );
  const switchProvider = useSettingsStore((s) => s.switchCloudTranscriptionProvider);
  const apiKey = useSettingsStore((s) => s.customTranscriptionApiKey);
  const setApiKey = useSettingsStore((s) => s.setCustomTranscriptionApiKey);
  const url = rawUrl ?? "";
  const model = rawProvider === "custom" ? rawModel : "";
  const urlId = useId();
  const modelId = useId();

  // What a request would use: the surface's own URL and model, else those it borrows.
  const checkedUrl = (url || inheritedUrl).trim();
  const checkedModel = (model || inheritedModel).trim();
  const visible = usePanelVisible();
  const endpointHold = useFocusHold();
  const editing = useFocusHold();
  const delayMs = useTypingPause({
    typed: `${checkedUrl}\n${checkedModel}`,
    context: JSON.stringify([visible, apiKey]),
    held: editing.held,
  });
  const check = useConnectionAutoCheck({
    config: {
      scope: "transcription",
      provider: "custom",
      baseUrl: checkedUrl,
      apiKey,
      model: checkedModel,
    },
    ready: Boolean(checkedUrl && checkedModel) && !isAzureOpenAIEndpoint(checkedUrl) && visible,
    // A half-typed address may belong to someone else: nothing is sent while it is edited.
    hold: endpointHold.held,
    delayMs,
  });
  const refused = check.failure?.errorCode === "credentialsRejected";
  const failureReason =
    !apiKey.trim() && refused ? t("reasoning.custom.endpointUnauthorized") : undefined;

  const handleBlur = () => {
    if (rawProvider !== "custom") return;
    const trimmed = url.trim();
    if (!trimmed) return;
    const normalized = normalizeBaseUrl(trimmed);
    if (normalized && normalized !== url) setUrl(normalized);
    if (normalized) {
      const allowed = filterByokProviderOptionsByPolicy(
        sttSurfaceProviders(surface),
        "transcription",
        policy
      );
      for (const provider of allowed) {
        if (normalized === normalizeBaseUrl(provider.baseUrl)) {
          switchProvider(STT_SURFACE_CONTEXT[surface], provider.id);
          break;
        }
      }
    }
  };

  return (
    <div className="space-y-2" onFocus={editing.onFocus} onBlur={editing.onBlur}>
      <ConnectionCheckAnnouncer announcement={check.announcement} />
      <div className="space-y-1.5">
        <label htmlFor={urlId} className="block text-xs font-medium text-foreground">
          {t("transcription.endpointUrl")}
        </label>
        <ProviderCheckField
          id={urlId}
          aria-label={t("transcription.endpointUrl")}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onFocus={endpointHold.onFocus}
          onBlur={(event) => {
            endpointHold.onBlur(event);
            handleBlur();
          }}
          placeholder={
            // Uploads with no URL of their own use Recognition's.
            !url && inheritedUrl && inheritedUrl !== API_ENDPOINTS.TRANSCRIPTION_BASE
              ? inheritedUrl
              : "https://your-api.example.com/v1"
          }
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">{t("transcription.apiKeyOptional")}</p>
        {/* Replace mode never shows the saved key, so clearing it is its own action. */}
        <div className="flex items-start gap-1.5">
          <ApiKeyInput
            className="min-w-0 flex-1"
            apiKey={apiKey}
            setApiKey={setApiKey}
            label=""
            ariaLabel={t("transcription.apiKeyOptional")}
            helpText={t("modelPicker.stt.custom.keyShared")}
            replace
          />
          {apiKey && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => setApiKey("")}
            >
              {t("connections.actions.remove")}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={modelId} className="block text-xs font-medium text-foreground">
          {t("common.model")}
        </label>
        <ProviderCheckField
          id={modelId}
          aria-label={t("common.model")}
          check={check}
          invalidOn="modelNotFound"
          failureReason={failureReason}
          value={model}
          onChange={(event) => onModel(event.target.value)}
          placeholder={!model && inheritedModel ? inheritedModel : "whisper-1"}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {/azure\.com/i.test(url || inheritedUrl) && (
        <p className="text-xs text-muted-foreground">{t("transcription.azureHint")}</p>
      )}
    </div>
  );
}

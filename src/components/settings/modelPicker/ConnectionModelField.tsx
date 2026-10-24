import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import type { PickerConnection } from "./connectionOptions";

/**
 * "Enter a deployment name…" on the custom connection: a field under the
 * picker for a deployment (Azure) or model name it doesn't list yet. Enter
 * picks it, through the same adapter as a listed one; Esc or Cancel closes it.
 */
export default function ConnectionModelField({
  connection,
  feature,
  busy,
  onSubmit,
  onCancel,
}: {
  connection: Pick<PickerConnection, "name" | "kind">;
  /** The feature being switched, as its page names it. */
  feature: string;
  busy: boolean;
  onSubmit: (model: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const id = useId();
  const azure = connection.kind === "azure";
  const name = value.trim();
  const submit = () => {
    if (name && !busy) onSubmit(name);
  };

  return (
    <div data-connection-model-field="" className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-foreground">
        {t(azure ? "modelPicker.connection.deploymentLabel" : "modelPicker.connection.modelLabel", {
          name: connection.name,
        })}
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          dir="ltr"
          autoFocus
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={azure ? "gpt-4.1-mini" : "model-id"}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              // Handled here, so Settings neither blurs the field nor closes.
              event.preventDefault();
              onCancel();
            }
          }}
          className="h-8 min-w-0 flex-1 font-mono text-sm"
        />
        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0 px-3 text-xs"
          disabled={!name || busy}
          onClick={submit}
        >
          {t("modelPicker.connection.use")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 px-2 text-xs"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("modelPicker.connection.enterHint", { name: connection.name, feature })}
      </p>
    </div>
  );
}

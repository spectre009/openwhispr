import { useTranslation } from "react-i18next";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import type { GlossaryOffer } from "../../utils/dictionaryGlossaryOffer";

// What the glossary rule editor says first when it opens from what speech
// wrote (the word panel's "Speech writes it as", History's dictionary card):
// a rule that already has the spelling was opened instead; the spelling was
// added to the rule that writes the word; and why the spelling's scope is
// what it is (it also stayed as written, it's everyday words, or that isn't
// known, so the rule starts limited to the start of a dictation in apps you
// pick; or it's safe anywhere).

export default function GlossaryOfferNotice({
  offer,
  spelling,
  keptInFinal,
}: {
  offer: GlossaryOffer;
  spelling: string;
  keptInFinal: number | null;
}) {
  const { t } = useTranslation();
  if (offer.opened === "existingSpelling") {
    return (
      <BidiInterpolatedText
        text={t("historyView.fixes.glossaryExisting", { spelling: BIDI_VALUE_TOKEN })}
        value={spelling}
        dir="auto"
      />
    );
  }
  const lines: string[] = [];
  if (offer.opened === "addedToRule")
    lines.push(t("dictionary.variants.notice.added", { spelling }));
  switch (offer.caution) {
    case "kept":
      lines.push(t("dictionary.variants.notice.kept", { spelling, count: keptInFinal ?? 0 }));
      break;
    case "common":
      lines.push(t("dictionary.variants.notice.common", { spelling }));
      break;
    case "unknown":
      lines.push(t("dictionary.variants.notice.unknown", { spelling }));
      break;
    default:
      lines.push(t("dictionary.variants.notice.anywhere", { spelling }));
  }
  return (
    <span dir="auto" data-glossary-offer-notice={offer.caution ?? "anywhere"}>
      {lines.join(" ")}
    </span>
  );
}

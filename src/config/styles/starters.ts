// The starter styles: off until switched on, and editable like any other.
// Their wording is model-facing and stays English (as the restyle prompt
// does); only the names shown in the app are translated, when the record is
// first written.
//
// Explicit wording matters as much as the run mode (style lab, rounds 1–4):
// "bullet points when there are several items" bulleted a Teams update in 1
// of 2 two-step runs, "when the message has two or more separate points, put
// each point on its own bullet" in 4 of 4. The Requirements wording is round
// 4's: with the fidelity rules, no status update became "Must" items in
// either mode. The Email wording follows the same pattern but was not
// measured; its starter test cases check it.

import type { StyleRunMode } from "./library";

export interface StyleStarter {
  id: string;
  /** i18n key of the name written into the record when it is seeded. */
  nameKey: string;
  defaultName: string;
  emoji: string;
  instruction: string;
  runMode: StyleRunMode;
}

export const TEAMS_CHAT_INSTRUCTION =
  "Write it as a Microsoft Teams chat message: friendly and concise. When the message has two or more separate points, put each point on its own bullet. Add one or two fitting emoji. Keep every fact and commitment exactly as spoken. Add no greeting or sign-off that wasn't spoken.";

export const REQUIREMENTS_INSTRUCTION =
  'Format it as a requirements list. Start with a one-line summary. Then number only what the speaker said is needed ("we need", "it must", "it has to", "it should support") as testable statements starting with "Must", or "Should" when the speaker called it optional, nice to have, or "probably". Put everything else (status, facts, things already done or in progress) under "Context:" as plain sentences, and leave "Context:" out when there is nothing for it. Put what the speaker said is not needed under "Out of scope:".';

export const EMAIL_INSTRUCTION =
  "Write it as the body of an email: clear and polite, in short paragraphs with one topic per paragraph. Start with a greeting on its own line only when the speaker said one, and end with a sign-off on its own line only when the speaker said one. When the speaker lists two or more items, put each item on its own bullet. Add no subject line, signature, name or placeholder that wasn't spoken.";

export const STARTER_TEAMS_ID = "starter-teams";
export const STARTER_REQUIREMENTS_ID = "starter-requirements";
export const STARTER_EMAIL_ID = "starter-email";

export const STYLE_STARTERS: readonly StyleStarter[] = Object.freeze([
  {
    id: STARTER_TEAMS_ID,
    nameKey: "styles.starters.teams",
    defaultName: "Teams chat",
    emoji: "💬",
    instruction: TEAMS_CHAT_INSTRUCTION,
    runMode: "two-step",
  },
  {
    id: STARTER_REQUIREMENTS_ID,
    nameKey: "styles.starters.requirements",
    defaultName: "Requirements",
    emoji: "📋",
    instruction: REQUIREMENTS_INSTRUCTION,
    runMode: "two-step",
  },
  {
    id: STARTER_EMAIL_ID,
    nameKey: "styles.starters.email",
    defaultName: "Email",
    emoji: "✉️",
    instruction: EMAIL_INSTRUCTION,
    runMode: "two-step",
  },
]);

// Cards the project chat (spec 39) shows instead of plain questions. The
// assistant ends a reply with a fenced block and the chat renders a form:
//
//   ```project-source
//   {"question": "Where does the code come from?"}
//   ```
//
// → "Choose a folder" (a folder picker on this machine), a field for Git URLs,
// and "Start from an idea". What the user picks goes back as their message.
// Pure and client-safe.

export const SOURCE_FENCE = "project-source";

const BLOCK = new RegExp("```" + SOURCE_FENCE + "[ \\t]*(?:\\n([\\s\\S]*?))?\\n?```", "g");

export type SourceCard = { body: string; question: string };

export function parseSourceCard(text: string | null | undefined): SourceCard | null {
  if (!text) return null;
  const last = [...text.matchAll(BLOCK)].at(-1);
  if (!last) return null;
  let question = "Where does the code come from?";
  try {
    const q = (JSON.parse((last[1] ?? "").trim() || "{}") as { question?: unknown }).question;
    if (typeof q === "string" && q.trim()) question = q.trim();
  } catch {
    // a malformed block still shows the card, with the default question
  }
  const body = (text.slice(0, last.index) + text.slice(last.index! + last[0].length))
    .replace(/^NEEDS_INPUT:.*$/gm, "")
    .trim();
  return { body, question };
}

/** The messages the card sends back, so the assistant reads them the same way every time. */
export const sourceAnswer = {
  folder: (path: string) => `Use the folder ${path}`,
  git: (urls: string[]) => `Git repositories:\n${urls.map((u) => `- ${u}`).join("\n")}`,
  idea: "Start from an idea",
};

/** Git URLs pasted into the card: one per line or separated by spaces/commas. */
export function parseGitUrls(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/i.test(u));
}

// ---- Confirm cards -----------------------------------------------------------
//
//   ```confirm
//   {"actionId": "act_…", "title": "Launch a Civo sandbox", "detail": "…costs money until destroyed"}
//   ```
//
// Shown when a tool refused to spend money without the user's tap. Confirm
// calls the API (not a chat message the model could fake).

export const CONFIRM_FENCE = "confirm";
const CONFIRM_BLOCK = new RegExp("```" + CONFIRM_FENCE + "[ \\t]*\\n?([\\s\\S]*?)\\n?```", "g");

export type ConfirmCard = { body: string; actionId: string; title: string; detail: string };

export function parseConfirmCard(text: string | null | undefined): ConfirmCard | null {
  if (!text) return null;
  const last = [...text.matchAll(CONFIRM_BLOCK)].at(-1);
  if (!last) return null;
  let data: { actionId?: unknown; title?: unknown; detail?: unknown };
  try {
    data = JSON.parse((last[1] ?? "").trim());
  } catch {
    return null;
  }
  if (typeof data.actionId !== "string" || !/^act_[0-9a-f]+$/.test(data.actionId)) return null;
  const body = (text.slice(0, last.index) + text.slice(last.index! + last[0].length)).trim();
  return {
    body,
    actionId: data.actionId,
    title: typeof data.title === "string" && data.title.trim() ? data.title.trim() : "Confirm",
    detail: typeof data.detail === "string" ? data.detail.trim() : "",
  };
}

// ---- Add-credential cards -------------------------------------------------------
//
//   ```add-credential
//   {"provider": "aws"}
//   ```
//
// When the user picks a cloud with no saved key. The card's form posts the key
// straight to Nexus (Vault → Cloud) — it never passes through the chat or the
// model — then tells the chat it was saved, so it carries on.

export const CREDENTIAL_FENCE = "add-credential";
const CREDENTIAL_BLOCK = new RegExp("```" + CREDENTIAL_FENCE + "[ \\t]*\\n?([\\s\\S]*?)\\n?```", "g");
export const CARD_PROVIDERS = ["aws", "civo"] as const;
export type CardProvider = (typeof CARD_PROVIDERS)[number];

export type CredentialCard = { body: string; provider: CardProvider };

export function parseCredentialCard(text: string | null | undefined): CredentialCard | null {
  if (!text) return null;
  const last = [...text.matchAll(CREDENTIAL_BLOCK)].at(-1);
  if (!last) return null;
  let provider: unknown;
  try {
    provider = (JSON.parse((last[1] ?? "").trim()) as { provider?: unknown }).provider;
  } catch {
    return null;
  }
  if (typeof provider !== "string" || !(CARD_PROVIDERS as readonly string[]).includes(provider)) return null;
  const body = (text.slice(0, last.index) + text.slice(last.index! + last[0].length)).replace(/^NEEDS_INPUT:.*$/gm, "").trim();
  return { body, provider: provider as CardProvider };
}

// ---- Notices ----------------------------------------------------------------------

/** Prompts Nexus writes itself (sandbox progress); the chat hides them and shows only the reply. */
export const NOTICE_TAG = "[nexux:notice]";
export const SANDBOX_DONE_TAG = "[nexux:sandbox]";
export const isNexusNotice = (prompt: string) => prompt.startsWith(NOTICE_TAG) || prompt.startsWith(SANDBOX_DONE_TAG);

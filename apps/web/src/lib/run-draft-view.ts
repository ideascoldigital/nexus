// What of a streaming reply the chat shows while it is written (spec 39):
// the prose. A card block (choices, mail, a handoff…) only means something
// whole, so the draft stops where one begins — the card appears with the
// finished reply — and the needs-input marker line is not shown. Pure.

// agent-core's marker; that module is server-only (it pulls in the sandbox
// package), so the page keeps its own copy, as bot-chat does.
const NEEDS_INPUT_MARKER = "NEEDS_INPUT:";

const CARD_FENCES = ["run", "choices", "mail", "handoff", "routine", "restart", "project-source", "confirm", "add-credential"];
const CARD_START = new RegExp("^\\s*```(" + CARD_FENCES.map((f) => f.replace(/-/g, "\\-")).join("|") + ")\\b", "m");

export function draftBody(draft: string | null | undefined): string {
  if (!draft) return "";
  let text = draft;
  const card = CARD_START.exec(text);
  if (card) text = text.slice(0, card.index);
  const marker = text.indexOf(NEEDS_INPUT_MARKER);
  if (marker !== -1) text = text.slice(0, marker) + text.slice(marker + NEEDS_INPUT_MARKER.length);
  return text.trimEnd();
}

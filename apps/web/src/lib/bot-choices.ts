// Multiple-choice questions from a bot (spec 31). The bot ends a reply with a
// fenced block the chat renders as buttons (A, B, C… plus "Something else"):
//
//   ```choices
//   {"question": "What should I test first?", "options": ["Signup", "Billing"]}
//   ```
//
// Pure and client-safe: the chat renders it, the inbox previews it, the
// manager flags it as "needs your input".

export const CHOICES_FENCE = "choices";

export type BotChoices = {
  /** The reply without the block — may be empty when the question is all there is. */
  body: string;
  question: string;
  options: string[];
};

const BLOCK = new RegExp("```" + CHOICES_FENCE + "[ \\t]*\\n([\\s\\S]*?)\\n?```", "g");

export function parseChoices(text: string | null | undefined): BotChoices | null {
  if (!text) return null;
  const matches = [...text.matchAll(BLOCK)];
  const last = matches.at(-1);
  if (!last) return null;
  let data: unknown;
  try {
    data = JSON.parse(last[1]!.trim());
  } catch {
    return null;
  }
  const { question, options } = (data ?? {}) as { question?: unknown; options?: unknown };
  if (typeof question !== "string" || !question.trim() || !Array.isArray(options)) return null;
  const clean = options
    .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
    .map((o) => o.trim())
    .slice(0, 6);
  if (clean.length < 2) return null;
  const body = (text.slice(0, last.index) + text.slice(last.index! + last[0].length)).trim();
  return { body, question: question.trim(), options: clean };
}

export const CHOICE_LETTERS = "ABCDEFG";

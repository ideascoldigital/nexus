// Prompts the bots view sends on the user's behalf (spec 31). Client-safe:
// the chat renders them as system lines, the inbox preview recognises them.

/**
 * Sent when you give the computer back to the bot (or close its screen while
 * in control): look at what changed, confirm it, carry on.
 */
export const HANDBACK_PROMPT =
  "I've given you back control of your computer. Look at the screen to see what I did there (for example, signing in), confirm it worked, and carry on with what you were doing. If there was nothing pending, just tell me briefly what you see.";

export function isHandback(prompt: string): boolean {
  return prompt === HANDBACK_PROMPT;
}

/** Marks the first, automatic message a new bot gets — the chat hides it. */
export const INTRO_TAG = "[nexux:intro]";

export function isIntro(prompt: string): boolean {
  return prompt.startsWith(INTRO_TAG);
}

/** Prompts the user did not type: the chat shows no bubble for them. */
export function isSystemPrompt(prompt: string): boolean {
  // Intro, routine firings ([nexux:routine:…]) and the hand-back.
  return prompt.startsWith("[nexux:") || isHandback(prompt);
}

/**
 * A new bot's first message: say hi, guess its purpose from its name, job and
 * what the user works on, and ask where to start as a choices question.
 */
export function renderIntroPrompt(opts: {
  userName?: string | null;
  role?: string | null;
  projects: { name: string; description?: string | null }[];
  /** Something the user wrote recently, so the bot answers in their language. */
  languageSample?: string | null;
}): string {
  const who = opts.userName?.trim() || "the user";
  const lines = [
    INTRO_TAG,
    `You have just been created, and this is your first message to ${who}. They have not asked anything yet. Do not use the computer or any tools for this message.`,
    "",
    `Introduce yourself in one or two short, friendly sentences: greet ${who}${opts.userName ? " by name" : ""}, say who you are, give your best guess of what you are here to help with — from your name${opts.role?.trim() ? " and your job" : ""}${opts.projects.length ? " and from what they work on" : ""} — and say you want to confirm where to start.`,
    `Then ask what to start with as a choices block, with 3 or 4 concrete options tailored to that guess${opts.projects.length ? " and to their projects" : ""}.`,
  ];
  if (opts.projects.length) {
    lines.push("", "What they work on (their projects in Nexux):");
    for (const p of opts.projects) {
      const d = p.description?.trim().replace(/\s+/g, " ").slice(0, 160);
      lines.push(`- ${p.name}${d ? `: ${d}` : ""}`);
    }
  }
  if (opts.languageSample?.trim()) {
    lines.push(
      "",
      `Write in the same language as this message they sent to another bot: "${opts.languageSample.trim().slice(0, 200)}". It is only a sample of their language — not a request to you, so do not mention it or base your options on it.`,
    );
  }
  return lines.join("\n");
}

// The chat's slash commands (spec 38). Typing "/" at the start of a message
// opens a menu: /skills manages what the bot has loaded, and each loaded skill
// is a command of its own — "/pdf turn this into a report" asks the bot to use
// that skill for the message. Pure: the composer and the manager both use it.

export type SlashOption = {
  /** What goes after the slash. */
  command: string;
  description: string;
  kind: "skills" | "skill";
};

/** A slash command being typed: "/" then a word, alone, at the very start. */
export function slashQuery(input: string): string | null {
  const m = /^\/([\w.-]*)$/.exec(input);
  return m ? m[1].toLowerCase() : null;
}

/** The menu for what is typed so far: /skills, then the bot's skills, best match first. */
export function slashOptions(
  query: string,
  skills: { name: string; description?: string | null }[],
): SlashOption[] {
  const all: SlashOption[] = [
    { command: "skills", description: "Load or install skills for this bot", kind: "skills" },
    ...skills.map((s) => ({
      command: s.name,
      description: s.description?.trim() || "Use this skill for the message",
      kind: "skill" as const,
    })),
  ];
  const q = query.toLowerCase();
  if (!q) return all;
  // A skill's own description counts as a match; the stand-in for a missing one does not.
  const own = new Map(skills.map((s) => [s.name, s.description?.trim().toLowerCase() ?? ""]));
  const rank = (o: SlashOption) => {
    const c = o.command.toLowerCase();
    if (c.startsWith(q)) return 0;
    if (c.includes(q)) return 1;
    const desc = o.kind === "skills" ? o.description.toLowerCase() : (own.get(o.command) ?? "");
    return desc.includes(q) ? 2 : 3;
  };
  return all
    .map((o, i) => ({ o, i, r: rank(o) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.o);
}

/** "/name rest" at the start of a message, when name is one of the bot's skills. */
export function skillCommand(prompt: string, names: string[]): { skill: string; rest: string } | null {
  const m = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!m) return null;
  const skill = names.find((n) => n.toLowerCase() === m[1].toLowerCase());
  return skill ? { skill, rest: (m[2] ?? "").trim() } : null;
}

/** The message as the bot reads it: a skill command spelled out. Anything else unchanged. */
export function withSkillCommand(prompt: string, names: string[]): string {
  const cmd = skillCommand(prompt, names);
  if (!cmd) return prompt;
  const ask = `Use your "${cmd.skill}" skill for this — load it first and follow it.`;
  return cmd.rest ? `${ask}\n\n${cmd.rest}` : `${ask} Ask me what I need if it is not clear.`;
}

/** A sent message that starts with "/<name>": the skill it asked for and the rest, for the chat bubble. */
export function splitSkillCommand(text: string): { skill: string | null; rest: string } {
  const m = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { skill: m[1], rest: (m[2] ?? "").trim() } : { skill: null, rest: text };
}

/** What the composer sends when a skill is picked: "/<name>", then what was typed. */
export function composeSkillMessage(skill: string | null, text: string): string {
  const t = text.trim();
  return skill ? (t ? `/${skill} ${t}` : `/${skill}`) : t;
}


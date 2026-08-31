// Convenience barrel — re-exports prisma model types + shared enums.
// Prefer importing directly from @nexux/db or @nexux/core in new code.
export type {
  Project,
  Repository,
  Feature,
  Conversation,
  Message,
  Agent,
  Plan,
  Skill,
  ProjectSkill,
  ProjectAgent,
} from "@nexux/db";

export * from "@nexux/core/enums";

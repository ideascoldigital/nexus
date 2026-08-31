// The outside world the LLM assistant services touch: the agent runtime, the
// semantic index, and the workspace lookup. Collected behind one type so tests
// can supply fakes — a real turn needs an OpenAI key and a live agent backend,
// neither of which CI has.
//
// Production callers pass nothing and get defaultAgentDeps().

import type { InlineMessage } from "@ideascol/agents-generator-sdk";
import { searchProject } from "@nexux/embeddings";

import { createAgentClient } from "./agents-generator";
import { workspaceIdOfProject } from "@/lib/workspace";

/** A handoff the SDK reports after routing a turn to a sub-agent. */
export type TransferEvent = {
  from_agent?: string;
  to_agent?: string;
  reason?: string;
};

/** What a defined agent can do; InlineAgentHandle satisfies it structurally. */
export type RunnableAgent = {
  run(
    input: string,
    opts?: { history?: InlineMessage[] }
  ): Promise<{ message?: string; transfers?: TransferEvent[] }>;
};

/** A distilled index hit, as the assistants consume it. */
export type ContextHit = {
  filePath: string;
  snippet: string;
  startLine?: number;
  endLine?: number;
  heading?: string;
  sourceType: string;
};

export type AgentDeps = {
  /**
   * Define the agent for a turn. `spec` mirrors the SDK's defineAgent options
   * that these services actually set.
   */
  defineAgent(spec: {
    name: string;
    instructions: string;
    workspaceId?: string;
  }): Promise<RunnableAgent>;
  /** Semantic-index hits used to ground a turn; empty when nothing is indexed. */
  search(
    projectId: string,
    query: string,
    k: number
  ): Promise<{ repos: ContextHit[]; projectData: ContextHit[] }>;
  workspaceIdOfProject(projectId: string): Promise<string | undefined>;
};

const MODEL_NAME = "gpt-5.4";

/** Real implementations — the agents SDK, the embeddings index, prisma. */
export function defaultAgentDeps(): AgentDeps {
  return {
    defineAgent: async ({ name, instructions, workspaceId }) => {
      const { client, apiKey } = await createAgentClient(workspaceId);
      return client.defineAgent({
        name,
        instructions,
        modelProvider: "openai",
        modelName: MODEL_NAME,
        apiKey,
        maxToolIterations: 1,
      });
    },
    search: async (projectId, query, k) => {
      const results = await searchProject(projectId, query, { k });
      return { repos: results.repos, projectData: results.projectData };
    },
    workspaceIdOfProject,
  };
}

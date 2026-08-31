/**
 * Agents Generator Service
 * 
 * Uses @ideascol/agents-generator-sdk to create AI assistants
 * that help configure custom agents and skills
 */

import { AgentClient, type InlineMessage } from '@ideascol/agents-generator-sdk';
import { prisma } from "@nexux/db";
import { getConfig } from "@nexux/config";

/**
 * Get OpenAI API key from settings
 */
async function getOpenAIKey(workspaceId?: string): Promise<string | null> {
  if (workspaceId) {
    const { getWorkspaceSetting } = await import("@/lib/workspace");
    const row = await getWorkspaceSetting(workspaceId, "openai_api_key");
    return row?.value ?? null;
  }
  const setting = await prisma.settings.findUnique({
    where: { key: 'openai_api_key' },
  });

  if (!setting || !setting.isActive) {
    return null;
  }

  // TODO: Decrypt the key if encryption is implemented
  return setting.value;
}

/**
 * Create an inline agent client
 */
export async function createAgentClient(workspaceId?: string) {
  const apiKey = await getOpenAIKey(workspaceId);
  
  if (!apiKey) {
    throw new Error('OpenAI API key not configured. Please add it in Settings.');
  }

  const client = new AgentClient({
    apiUrl: getConfig().integrations.agentsGeneratorApiUrl,
    // No apiToken → anonymous mode with inline agents
  });

  return { client, apiKey };
}

/**
 * Agent Configuration Assistant
 * Helps users create and configure custom agents
 */
export async function createAgentAssistant() {
  const { client, apiKey } = await createAgentClient();

  const agent = client.defineAgent({
    name: 'agent-config-assistant',
    instructions: `You are an expert assistant helping users configure custom AI agents for their projects.

Your role is to:
1. Ask questions to understand what kind of agent the user needs
2. Suggest appropriate configurations (model, temperature, system prompts)
3. Help write effective system prompts and instructions
4. Generate agent configurations in the correct format

Agent configuration format:
- name: Short identifier (lowercase, hyphens)
- description: What the agent does
- systemPrompt: Detailed instructions for the agent
- model: Model to use (claude-opus-4, gpt-4, etc.)
- color: Hex color for UI (e.g., #3b82f6)

When the user is satisfied with the configuration, generate a complete agent config in JSON format.

Be conversational, ask clarifying questions, and provide helpful suggestions.`,
    modelProvider: 'openai',
    modelName: 'gpt-5.4',
    apiKey,
    maxToolIterations: 5,
  });

  return agent;
}

/**
 * Skill Configuration Assistant
 * Helps users create and configure custom skills
 */
export async function createSkillAssistant() {
  const { client, apiKey } = await createAgentClient();

  const agent = client.defineAgent({
    name: 'skill-config-assistant',
    instructions: `You are an expert assistant helping users author custom Claude Code skills (SKILL.md files).

Skill format on disk:
- Lives at ~/.claude/skills/<name>/SKILL.md (user scope) or ./.claude/skills/<name>/SKILL.md (project scope)
- YAML frontmatter with: name (lowercase-hyphens), description (one sentence describing when to use the skill)
- Markdown body with detailed instructions, patterns, examples, contracts

Your role:
1. Clarify what trigger conditions activate the skill
2. Define clear, actionable instructions in the body
3. Include concrete examples and code snippets where useful
4. Generate a complete skill config in JSON

Final config JSON shape (emit when ready):
\`\`\`json
{
  "name": "my-skill",
  "description": "When to use this skill, e.g. 'Use when authoring X or debugging Y'",
  "scope": "user",
  "body": "# My Skill\n\nFull markdown body here..."
}
\`\`\`

Always include the full markdown body inside the JSON \`body\` field. Be conversational and ask clarifying questions before emitting JSON.`,
    modelProvider: 'openai',
    modelName: 'gpt-5.4',
    apiKey,
    maxToolIterations: 5,
  });

  return agent;
}

/**
 * Code Generation Assistant
 * Helps generate code snippets for agents and skills
 */
export async function createCodeGeneratorAssistant() {
  const { client, apiKey } = await createAgentClient();

  const agent = client.defineAgent({
    name: 'code-generator',
    instructions: `You are an expert code generator specializing in creating agent system prompts and skill implementations.

Your role is to:
1. Generate effective system prompts for agents
2. Create code snippets for custom skills
3. Provide implementation examples
4. Suggest best practices and patterns

When generating system prompts:
- Be specific and clear
- Include examples when helpful
- Define the agent's role and capabilities
- Set appropriate boundaries and guidelines

When generating skill code:
- Use TypeScript
- Include type definitions
- Add error handling
- Provide usage examples

Always format code with proper syntax highlighting and structure.`,
    modelProvider: 'openai',
    modelName: 'gpt-4o',
    apiKey,
    maxToolIterations: 5,
  });

  return agent;
}

/**
 * Run an agent with streaming support
 */
export async function runAgentWithStreaming(
  agentType: 'agent' | 'skill' | 'code',
  userMessage: string,
  history: InlineMessage[] = [],
  onMessage?: (content: string) => void,
  onDone?: (messageId: string) => void,
  onError?: (error: Error) => void
) {
  let agent;
  
  switch (agentType) {
    case 'agent':
      agent = await createAgentAssistant();
      break;
    case 'skill':
      agent = await createSkillAssistant();
      break;
    case 'code':
      agent = await createCodeGeneratorAssistant();
      break;
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }

  return await agent.run(userMessage, {
    history,
    callbacks: {
      onMessage: (content) => {
        if (onMessage) onMessage(content);
      },
      onDone: () => {
        if (onDone) onDone('completed');
      },
      onError: (err) => {
        if (onError) onError(err);
      },
    },
  });
}

/**
 * Run an agent and return the complete response (non-streaming)
 */
export async function runAgent(
  agentType: 'agent' | 'skill' | 'code',
  userMessage: string,
  history: InlineMessage[] = []
) {
  let agent;
  
  switch (agentType) {
    case 'agent':
      agent = await createAgentAssistant();
      break;
    case 'skill':
      agent = await createSkillAssistant();
      break;
    case 'code':
      agent = await createCodeGeneratorAssistant();
      break;
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }

  const result = await agent.run(userMessage, { history });
  return result;
}

/**
 * Parse agent configuration from assistant response
 */
export function parseAgentConfig(response: string): unknown {
  try {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }

    // Try to extract JSON directly
    const directJsonMatch = response.match(/\{[\s\S]*\}/);
    if (directJsonMatch) {
      return JSON.parse(directJsonMatch[0]);
    }

    return null;
  } catch (error) {
    console.error('Failed to parse agent config:', error);
    return null;
  }
}

/**
 * Parse skill configuration from assistant response
 */
export function parseSkillConfig(response: string): unknown {
  try {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }

    // Try to extract JSON directly
    const directJsonMatch = response.match(/\{[\s\S]*\}/);
    if (directJsonMatch) {
      return JSON.parse(directJsonMatch[0]);
    }

    return null;
  } catch (error) {
    console.error('Failed to parse skill config:', error);
    return null;
  }
}

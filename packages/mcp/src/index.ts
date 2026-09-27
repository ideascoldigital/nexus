/**
 * `@nexux/mcp` — the tool layer of the MCP control surface (spec 21).
 *
 * The package holds what the tools are and who may call them; a host supplies
 * a `NexuxContext` with the implementations. Nothing here imports Prisma or
 * Next, so the same tools serve the in-process `/api/mcp` route today and a
 * published stdio binary later.
 */
export {
  SCOPES,
  ScopeError,
  ToolInputError,
  type ActivitySummary,
  type CreateTaskInput,
  type DockerEndpointSummary,
  type JsonSchema,
  type LaunchSandboxInput,
  type NexuxContext,
  type PowerAction,
  type ProjectSummary,
  type SandboxSummary,
  type SeedResetSummary,
  type Scope,
  type StackFinding,
  type StackStep,
  type StackValidationSummary,
  type TaskSummary,
  type ToolDefinition,
} from "./types";

export { TOOLS, callTool, toolByName, toolsFor, type CallResult } from "./registry";

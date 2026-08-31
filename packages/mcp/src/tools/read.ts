import { asObject, optionalInt, requiredString } from "../args";
import type { ToolDefinition } from "../types";

/**
 * Tools that only observe. These are the ones that answer the question the
 * control surface exists for — "nothing has reported back, what is happening"
 * — and they are safe to hand to anything.
 */

export const listProjects: ToolDefinition<Record<string, never>> = {
  name: "nexux_list_projects",
  description:
    "List the projects in this Nexus, with their ids. Start here when you " +
    "need a projectId for another tool.",
  scope: "projects:read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parse: () => ({}) as Record<string, never>,
  run: (ctx) => ctx.listProjects(),
};

export const activity: ToolDefinition<Record<string, never>> = {
  name: "nexux_activity",
  description:
    "What is happening across every project right now: runs blocked waiting " +
    "for a human answer, runs in flight, runs queued for a slot, runs that " +
    "finished recently, and sandboxes sitting idle. Blocked runs are the ones " +
    "that need a person — nothing moves on them until they are answered.",
  scope: "tasks:read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parse: () => ({}) as Record<string, never>,
  run: (ctx) => ctx.getActivity(),
};

export const listSandboxes: ToolDefinition<{ projectId: string }> = {
  name: "nexux_list_sandboxes",
  description:
    "List a project's sandboxes — the machines that runs execute on — with " +
    "their status and preview URL.",
  scope: "sandboxes:read",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "From nexux_list_projects." },
    },
    required: ["projectId"],
    additionalProperties: false,
  },
  parse: (raw) => ({ projectId: requiredString(asObject(raw), "projectId") }),
  run: (ctx, args) => ctx.listSandboxes(args.projectId),
};

export const taskStatus: ToolDefinition<{ taskId: string }> = {
  name: "nexux_task_status",
  description:
    "The current state of one run: status, whether it is blocked waiting for " +
    "an answer, its branch and pull request if it opened one.",
  scope: "tasks:read",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "From nexux_activity." },
    },
    required: ["taskId"],
    additionalProperties: false,
  },
  parse: (raw) => ({ taskId: requiredString(asObject(raw), "taskId") }),
  run: async (ctx, args) => {
    const task = await ctx.getTask(args.taskId);
    // A missing task is an answer, not a failure — the id may simply be stale.
    return task ?? { found: false, taskId: args.taskId };
  },
};

export const taskLogs: ToolDefinition<{ taskId: string; tailLines?: number }> = {
  name: "nexux_task_logs",
  description:
    "The tail of a run's log. Use this to find out why a run failed, or what " +
    "it is currently doing.",
  scope: "tasks:read",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "From nexux_activity." },
      tailLines: {
        type: "number",
        description: "How many trailing lines to return (1–2000, default 200).",
      },
    },
    required: ["taskId"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const obj = asObject(raw);
    return {
      taskId: requiredString(obj, "taskId"),
      tailLines: optionalInt(obj, "tailLines", { min: 1, max: 2000 }),
    };
  },
  run: async (ctx, args) => {
    const log = await ctx.getTaskLogs(args.taskId, args.tailLines ?? 200);
    return log ?? { found: false, taskId: args.taskId };
  },
};

export const READ_TOOLS = [
  listProjects,
  activity,
  listSandboxes,
  taskStatus,
  taskLogs,
] as const;

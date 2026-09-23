import {
  asObject,
  optionalInt,
  optionalString,
  requiredEnum,
  requiredString,
} from "../args";
import type { PowerAction, ToolDefinition } from "../types";

/**
 * Tools that change something. The host's implementations do the enforcing —
 * `createTask` already refuses an unreachable or busy sandbox, and is the one
 * point every other dispatch path converges on — so these stay thin on
 * purpose. A tool that re-checked those rules would be a fifth place for them
 * to drift.
 */

export const createTask: ToolDefinition<{
  projectId: string;
  sandboxId: string;
  prompt: string;
  featureId?: string;
  followUpOf?: string;
}> = {
  name: "nexux_create_task",
  description:
    "Queue a task onto a sandbox that is already running. The agent works on " +
    "its own branch and may open a pull request, depending on the project's " +
    "and the feature's settings. Fails if the sandbox is not running or is " +
    "already busy with another run.",
  scope: "tasks:write",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "From nexux_list_projects." },
      sandboxId: {
        type: "string",
        description: "From nexux_list_sandboxes — must be running and idle.",
      },
      prompt: {
        type: "string",
        description: "What the agent should do, in plain language.",
      },
      featureId: {
        type: "string",
        description:
          "Optional. Attaches the run to a roadmap feature, which also decides " +
          "whether it opens a pull request.",
      },
      followUpOf: {
        type: "string",
        description:
          "Optional. Continue an earlier run: same branch, same pull request, " +
          "resumed session. Must be on the same sandbox.",
      },
    },
    required: ["projectId", "sandboxId", "prompt"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const obj = asObject(raw);
    return {
      projectId: requiredString(obj, "projectId"),
      sandboxId: requiredString(obj, "sandboxId"),
      prompt: requiredString(obj, "prompt"),
      featureId: optionalString(obj, "featureId"),
      followUpOf: optionalString(obj, "followUpOf"),
    };
  },
  run: (ctx, args) =>
    ctx.createTask({
      projectId: args.projectId,
      sandboxId: args.sandboxId,
      prompt: args.prompt,
      featureId: args.featureId ?? null,
      followUpOf: args.followUpOf ?? null,
    }),
};

export const launchSandbox: ToolDefinition<{
  projectId: string;
  provider?: string;
  name?: string;
}> = {
  name: "nexux_launch_sandbox",
  description:
    "Provision a new sandbox for a project. This creates a real machine on " +
    "Civo or AWS (or a local container) and costs money until it is destroyed. " +
    "Prefer reusing an idle sandbox from nexux_list_sandboxes.",
  scope: "sandboxes:write",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "From nexux_list_projects." },
      provider: {
        type: "string",
        description:
          "Optional. civo, aws or local. Omit to use the project's configured " +
          "default.",
      },
      name: {
        type: "string",
        description: "Optional. Omit to let Nexus generate one.",
      },
    },
    required: ["projectId"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const obj = asObject(raw);
    return {
      projectId: requiredString(obj, "projectId"),
      // Not an enum here: which providers a given install accepts depends on
      // its configured credentials, and the host is what knows that.
      provider: optionalString(obj, "provider"),
      name: optionalString(obj, "name"),
    };
  },
  run: (ctx, args) =>
    ctx.launchSandbox({
      projectId: args.projectId,
      provider: args.provider,
      name: args.name,
    }),
};

const POWER_ACTIONS = ["pause", "resume"] as const;

export const powerSandbox: ToolDefinition<{
  sandboxId: string;
  action: PowerAction;
}> = {
  name: "nexux_sandbox_power",
  description:
    "Pause or resume a sandbox. Pausing stops the machine without destroying " +
    "it, so its work survives.",
  scope: "sandboxes:write",
  inputSchema: {
    type: "object",
    properties: {
      sandboxId: { type: "string", description: "From nexux_list_sandboxes." },
      action: { type: "string", enum: ["pause", "resume"] },
    },
    required: ["sandboxId", "action"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const obj = asObject(raw);
    return {
      sandboxId: requiredString(obj, "sandboxId"),
      action: requiredEnum(obj, "action", POWER_ACTIONS),
    };
  },
  run: (ctx, args) => ctx.powerSandbox(args.sandboxId, args.action),
};



/**
 * Spec 25 piece 2. A write, and an expensive one: each round runs a validation
 * that may provision a container, and it edits the stack definition in place.
 *
 * `sandboxes:write` rather than a new scope: what this ultimately spends is
 * sandbox time, and a token trusted to launch one is trusted to run a few.
 */
export const repairStack: ToolDefinition<{
  projectId: string;
  maxRounds?: number;
}> = {
  name: "nexux_repair_stack",
  description:
    "Try to make a project's stack definition boot: validate it, read what " +
    "failed, patch the definition, and validate again — up to three rounds. " +
    "Returns the diff of what changed and why, plus anything it refused to " +
    "do. It never deletes a node, never touches one the user wrote by hand, " +
    "and never removes a run command or a port, because making the check not " +
    "run is not making it pass. Call nexux_validate_stack first if you only " +
    "want to know what is wrong.",
  scope: "sandboxes:write",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "From nexux_list_projects." },
      maxRounds: {
        type: "number",
        description:
          "Optional, 1-3. Fewer rounds cost less; each one runs a validation.",
      },
    },
    required: ["projectId"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const obj = asObject(raw);
    // Bounded here rather than only described: a client asking for 50 rounds
    // would otherwise spend 50 containers before anything refused it.
    const rounds = optionalInt(obj, "maxRounds", { min: 1, max: 3 });
    return {
      projectId: requiredString(obj, "projectId"),
      ...(rounds === undefined ? {} : { maxRounds: rounds }),
    };
  },
  run: (ctx, args) => ctx.repairStack(args.projectId, args.maxRounds),
};


export const WRITE_TOOLS = [
  createTask,
  launchSandbox,
  powerSandbox,
  repairStack,
] as const;

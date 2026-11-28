import { READ_TOOLS } from "./tools/read";
import { WRITE_TOOLS } from "./tools/write";
import { PROJECT_TOOLS } from "./tools/projects";
import {
  ScopeError,
  type NexuxContext,
  type Scope,
  type ToolDefinition,
} from "./types";

/**
 * The tool registry and the single place a scope is checked.
 *
 * Every tool carries its own scope in its definition rather than being looked
 * up in a side table: a table is something a new tool can be forgotten from,
 * and a tool missing from a scope map would have to either fail closed
 * (silently unusable) or fail open (silently unguarded). Carrying it makes the
 * type system refuse a tool that declares nothing.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: readonly ToolDefinition<any>[] = [
  ...READ_TOOLS,
  ...WRITE_TOOLS,
  ...PROJECT_TOOLS,
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * The tools a set of scopes may see. Listing is filtered, not just calling:
 * advertising a tool that will always be refused invites a client to keep
 * trying it, and tells the holder of a narrow token what a broader one could
 * do.
 */
export function toolsFor(scopes: readonly Scope[]) {
  return TOOLS.filter((tool) => scopes.includes(tool.scope)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export type CallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/**
 * Runs a tool for a caller holding `scopes`.
 *
 * An unknown tool and an out-of-scope tool are answered identically, for the
 * same reason the token lookup answers unknown and revoked identically: a
 * distinct "you lack the scope" tells a caller the tool exists and is worth
 * attacking, while "no such tool" tells them nothing.
 *
 * Argument errors are returned rather than thrown — a client sending the wrong
 * shape is an ordinary event. Failures from the host (a busy sandbox, a
 * missing project) are returned too: they are answers about the system, not
 * crashes in it.
 */
export async function callTool(
  ctx: NexuxContext,
  scopes: readonly Scope[],
  name: string,
  rawArgs: unknown,
): Promise<CallResult> {
  const tool = toolByName(name);
  if (!tool || !scopes.includes(tool.scope)) {
    return { ok: false, error: `Unknown tool: ${name}` };
  }

  try {
    const args = tool.parse(rawArgs);
    return { ok: true, result: await tool.run(ctx, args) };
  } catch (err) {
    // ScopeError cannot arise here (the check above already passed) but a host
    // implementation may throw one for a nested capability; treat it the same
    // way, without naming the scope.
    if (err instanceof ScopeError) return { ok: false, error: `Unknown tool: ${name}` };
    const message = err instanceof Error ? err.message : "Tool call failed";
    return { ok: false, error: message };
  }
}

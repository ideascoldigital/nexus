/**
 * Server-chosen defaults for the project wizard.
 *
 * The bootstrap location cannot be a client-side constant: on a Nexus host
 * the container runs as an unprivileged uid whose home does not exist, and
 * the only writable directory is the workspace volume (NEXUX_WORKSPACE_ROOT).
 * A local install keeps the friendlier home-relative suggestion.
 */

import { NextResponse } from "next/server";
import { getConfig } from "@nexux/config";

export type ProjectDefaults = {
  /** Suggested parent directory for bootstrap projects on this install. */
  bootstrapParentPath: string;
};

export async function GET() {
  const body: ProjectDefaults = {
    bootstrapParentPath:
      process.env.NEXUX_ROLE === "host"
        ? getConfig().workspaceRoot
        : "~/Projects",
  };
  return NextResponse.json(body);
}

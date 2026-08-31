// How a local stack node actually runs: which directory, which command, which
// port. Shared by the runner (start/stop/status on the host) and by sandbox
// provisioning, so both read the same answer instead of each guessing.

import { readFile } from "fs/promises";
import path from "path";

import { expandHome } from "@nexux/storage";

import type { PortMapping } from "./types";

/** `--port 3003`, `-p 8080`, `--port=3000`, `PORT=4000 next dev`. */
const COMMAND_PORT_RES = [
  /--port[=\s]+(\d{2,5})/,
  /(?:^|\s)-p[=\s]+(\d{2,5})/,
  /(?:^|\s)PORT=(\d{2,5})/,
];

/** Where a local node's command runs — the rule startLocalNode uses. */
export function resolveNodeDir(
  localPath: string | null | undefined,
  workdir: string | null | undefined
): string | null {
  if (!localPath) return null;
  const base = expandHome(localPath);
  return path.resolve(workdir ? path.join(base, workdir) : base);
}

export function portInCommand(command: string): number | null {
  for (const re of COMMAND_PORT_RES) {
    const hit = re.exec(command);
    if (hit) {
      const port = Number(hit[1]);
      if (port > 0) return port;
    }
  }
  return null;
}

/**
 * Ports worth associating with a local node: whatever it declares, plus a port
 * named in its command — the common case is a dev script whose port never gets
 * declared on the node itself.
 */
export function nodePorts(
  declared: unknown,
  localCommand: string | null,
  scriptCommand?: string | null
): number[] {
  const ports = ((declared as PortMapping[] | null) ?? [])
    .map((p) => p?.host)
    .filter((p): p is number => typeof p === "number" && p > 0);
  // `pnpm dev` hides the port inside the repo's own script, so fall back to
  // whatever that script expands to.
  for (const source of [localCommand, scriptCommand]) {
    if (!source) continue;
    const port = portInCommand(source);
    if (port && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

/**
 * The script `pnpm dev` / `npm run dev` would actually run, if resolvable.
 * Reads the repo's package.json, so it only works for host-local paths.
 */
export async function resolveScriptCommand(
  command: string | null,
  cwd: string | null
): Promise<string | null> {
  if (!command || !cwd) return null;
  const match = /^\s*(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:-]+)/.exec(command);
  const script = match?.[1];
  if (!script || script === "run") return null;
  try {
    const raw = await readFile(path.join(cwd, "package.json"), "utf8");
    const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> })
      .scripts;
    return scripts?.[script] ?? null;
  } catch {
    // no package.json / unreadable — nothing to infer from
    return null;
  }
}

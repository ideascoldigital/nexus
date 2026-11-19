import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@nexux/config";
import { execRemote, sandboxPrivateKeyPath } from "@nexux/sandbox";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

const TAIL_LINES = 400;

/**
 * The logs a sandbox can be asked for.
 *
 * A closed set, keyed by an opaque id: the command below is a shell string, so
 * a client-supplied path would be a command injection. The client picks a
 * source, never a path.
 */
const LOG_SOURCES = {
  app: {
    label: "App",
    // The live-preview process (`pnpm dev` & co), started by nexux-preview.sh.
    command: `tail -n ${TAIL_LINES} /tmp/nexux-app.log 2>/dev/null || echo "(no app log — the live preview has not been started)"`,
  },
  tunnel: {
    label: "Tunnel",
    command: `tail -n ${TAIL_LINES} /tmp/nexux-tunnel.log 2>/dev/null || echo "(no tunnel log — the live preview has not been started)"`,
  },
  bootstrap: {
    label: "Bootstrap",
    command: `tail -n ${TAIL_LINES} /var/log/nexus-bootstrap.log 2>/dev/null || echo "(bootstrap log not created yet)"`,
  },
  stack: {
    // Stack services run under the sandbox's *inner* dockerd, so `docker logs`
    // from the host cannot see them — compose has to be driven inside.
    label: "Stack services",
    command: `if [ -f /opt/nexus/stack/docker-compose.yml ]; then cd /opt/nexus/stack && docker compose logs --tail ${TAIL_LINES} 2>&1 || echo "(docker compose failed — is the inner dockerd up? see the dockerd log)"; else echo "(no stack services configured for this project)"; fi`,
  },
  dockerd: {
    label: "dockerd",
    command: `tail -n ${TAIL_LINES} /var/log/dockerd.log 2>/dev/null || echo "(no dockerd log — Docker was not installed in this sandbox)"`,
  },
} as const;

export type SandboxLogSource = keyof typeof LOG_SOURCES;

export async function GET(req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const requested = req.nextUrl.searchParams.get("source") ?? "app";
  if (!Object.hasOwn(LOG_SOURCES, requested)) {
    return NextResponse.json({ error: "Unknown log source" }, { status: 400 });
  }
  const source = LOG_SOURCES[requested as SandboxLogSource];

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }

  const isLocal = sandbox.provider === "local";
  // A local container can be tailed while it's still provisioning; SSH needs
  // the cloud instance fully up.
  const reachable = isLocal
    ? Boolean(sandbox.instanceId)
    : sandbox.status === "running" && Boolean(sandbox.publicIp);
  if (!reachable) {
    return NextResponse.json(
      { error: "Sandbox is not running" },
      { status: 409 },
    );
  }

  try {
    const res = await execRemote(
      source.command,
      isLocal
        ? {
            container: sandbox.instanceId!,
            dockerHost: sandbox.dockerHost,
            timeoutMs: 20_000,
          }
        : {
            host: sandbox.publicIp!,
            privateKeyPath: sandboxPrivateKeyPath(getConfig().dataDir),
            timeoutMs: 20_000,
          },
    );
    return NextResponse.json({
      source: requested,
      log: res.stdout || "(empty)",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read log";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@nexux/config";
import {
  AGENT_USER,
  SANDBOX_WORKSPACE_PATH,
  ensureSandboxKeypair,
  ensureUserSshInclude,
  execRemote,
  resolveVsCodeFolder,
  sandboxPrivateKeyPath,
  upsertSandboxSshHost,
  vsCodeRemoteUri,
  writeCodeWorkspaceCommand,
} from "@nexux/sandbox";

import { launchVsCode } from "@/lib/vscode-launch";

export const dynamic = "force-dynamic";

/**
 * Write the multi-root `.code-workspace` file on the sandbox so every repo
 * shows up as a first-level folder instead of nested under /opt/nexus.
 * Best-effort: on failure the caller falls back to opening /opt/nexus as a
 * plain folder — an editor that opens is better than an error.
 */
async function ensureRemoteWorkspaceFile(
  projectId: string,
  target: { container?: string; host?: string; dataDir: string },
): Promise<boolean> {
  const repositories = await prisma.repository.findMany({
    where: { projectId },
    orderBy: [{ isMain: "desc" }, { name: "asc" }],
    select: { name: true },
  });

  // With no repos in the DB there is nothing to regenerate — but the bootstrap
  // writes this same file at provision time, so an existing one is still the
  // better thing to open than the bare /opt/nexus folder.
  const command =
    repositories.length === 0
      ? `test -f ${SANDBOX_WORKSPACE_PATH}`
      : writeCodeWorkspaceCommand(repositories);

  try {
    const res = await execRemote(command, {
      user: AGENT_USER,
      container: target.container,
      host: target.host,
      privateKeyPath: target.container
        ? undefined
        : sandboxPrivateKeyPath(target.dataDir),
      timeoutMs: 20_000,
    });
    return res.code === 0;
  } catch {
    return false;
  }
}

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

// Registers the sandbox in Nexus's managed SSH config (plus a one-time
// Include line in ~/.ssh/config) and returns a vscode:// deep link that opens
// VS Code connected over Remote-SSH as the agent user — no password prompt,
// no manual host setup. The connection user is the agent user because it owns
// the checkouts under /opt/nexus.
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }
  if (
    sandbox.status !== "running" ||
    (sandbox.provider !== "local" && !sandbox.publicIp)
  ) {
    return NextResponse.json(
      { error: "Sandbox is not running yet" },
      { status: 409 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { path?: unknown };
  // An explicit path (e.g. the terminal's cwd) wins — the caller asked for one
  // specific folder. Otherwise open the generated multi-root workspace.
  const explicitPath =
    typeof body.path === "string" && body.path.startsWith("/opt/nexus")
      ? body.path
      : null;

  // Local Docker sandboxes have no sshd — attach with the Dev Containers
  // extension instead: the authority is "attached-container+<hex(name)>".
  if (sandbox.provider === "local") {
    // Dev Containers attaches through this machine's daemon; one on another
    // machine needs a docker context there first (spec 26, not yet).
    if (sandbox.dockerHost) {
      return NextResponse.json(
        { error: "VS Code can't attach to a sandbox on another machine's Docker yet." },
        { status: 409 },
      );
    }
    if (!sandbox.instanceId) {
      return NextResponse.json(
        { error: "Local sandbox has no container yet" },
        { status: 409 },
      );
    }
    const workspaceReady =
      !explicitPath &&
      (await ensureRemoteWorkspaceFile(projectId, {
        container: sandbox.instanceId,
        dataDir: getConfig().dataDir,
      }));
    const folder = resolveVsCodeFolder({ explicitPath, workspaceReady });
    const hexName = Buffer.from(sandbox.instanceId, "utf8").toString("hex");
    const uri = `vscode://vscode-remote/attached-container+${hexName}${folder}`;
    const launched = await launchVsCode(uri, true);
    return NextResponse.json({ uri, host: sandbox.instanceId, launched });
  }

  try {
    const dataDir = getConfig().dataDir;
    // The keypair normally exists from launch; guarantee it anyway so the
    // IdentityFile the host entry points at is never dangling.
    ensureSandboxKeypair(dataDir);
    const alias = upsertSandboxSshHost({
      dataDir,
      name: sandbox.name,
      host: sandbox.publicIp!,
      user: AGENT_USER,
    });
    ensureUserSshInclude(dataDir);
    const workspaceReady =
      !explicitPath &&
      (await ensureRemoteWorkspaceFile(projectId, {
        host: sandbox.publicIp!,
        dataDir,
      }));
    const folder = resolveVsCodeFolder({ explicitPath, workspaceReady });
    const uri = vsCodeRemoteUri(alias, folder);
    // Local-first: this server runs on the user's machine, so launch VS Code
    // directly — vscode:// via the browser depends on a protocol-handler
    // prompt that's easy to miss or block. The uri stays in the response as
    // the client-side fallback.
    const launched = await launchVsCode(uri);
    return NextResponse.json({ uri, host: alias, launched });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Ship the stack as `log`: these failures are ssh-config/keypair plumbing,
    // and the message alone ("EACCES") never says which file.
    const log = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: message, log }, { status: 500 });
  }
}

import { prisma } from "@nexux/db";
import { getConfig } from "@nexux/config";
import {
  AGENT_USER,
  sandboxPrivateKeyPath,
  sandboxShellCommand,
} from "@nexux/sandbox";
import { NextRequest, NextResponse } from "next/server";
import {
  launchSandbox,
  projectTailnet,
  reconcileLocalSandboxStatuses,
} from "@/lib/sandbox-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  // A container can die without us writing the status column (OOM kill, Docker
  // restart). Reconcile first so the list reflects reality — otherwise the row
  // stays "running" and the Resume button never appears.
  await reconcileLocalSandboxStatuses(projectId).catch(() => undefined);

  const sandboxes = await prisma.sandbox.findMany({
    where: { projectId, archived: false },
    orderBy: { createdAt: "desc" },
    // Omit the (potentially large) terraform log; the detail route has it.
    select: {
      id: true,
      name: true,
      status: true,
      provider: true,
      region: true,
      size: true,
      instanceId: true,
      publicIp: true,
      tailscaleIp: true,
      previewUrl: true,
      stackServices: true,
      dedicated: true,
      muteTelegram: true,
      muteSlack: true,
      ephemeral: true,
      error: true,
      createdAt: true,
      updatedAt: true,
      destroyedAt: true,
    },
  });

  // Composed here rather than in the browser: the key path is a property of
  // this install, not of the row, and the client has no business guessing it.
  // Not a secret — it names a file, and the file never leaves this machine.
  const privateKeyPath = sandboxPrivateKeyPath(getConfig().dataDir);
  // One lookup for the whole list: the tailnet is a property of the project's
  // sandbox config, not of an individual machine. Null when this project's
  // sandboxes do not join one, which is what hides the action.
  const tailnet = await projectTailnet(projectId).catch(() => null);
  return NextResponse.json(
    sandboxes.map((s) => ({
      ...s,
      sshCommand: sandboxShellCommand(s, {
        privateKeyPath,
        user: AGENT_USER,
      }),
      tailnet,
    })),
  );
}

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const body = await req
    .json()
    .catch(() => ({}) as { provider?: string; name?: string });
  const provider =
    body?.provider === "local" || body?.provider === "aws"
      ? body.provider
      : "civo";
  // Absent or blank both mean "generate one" — a cleared input posts "".
  const name = typeof body?.name === "string" ? body.name : undefined;

  try {
    const sandbox = await launchSandbox(projectId, provider, name);
    return NextResponse.json(sandbox, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Launch failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

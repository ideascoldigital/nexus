import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { defaultShellId, listShells } from "@nexux/terminal";
import { getActiveWorkspaceId, scopedSettingKey } from "@/lib/workspace";

// Which shells exist is a property of the machine running the server, not of
// the build — a distro installed after startup should show up on reload — so
// this is answered per request. It is also the machine the pty server runs on,
// which is the whole point: a browser pointed at a remote Nexus host must be
// offered that host's shells, not its own.
export const dynamic = "force-dynamic";

export const DEFAULT_SHELL_SETTING = "terminal_default_shell";

const putSchema = z.object({ shellId: z.string().min(1) });

async function readStoredDefault(): Promise<string | null> {
  const workspaceId = await getActiveWorkspaceId();
  const row = await prisma.settings.findUnique({
    where: { key: scopedSettingKey(workspaceId, DEFAULT_SHELL_SETTING) },
  });
  return row?.value ?? null;
}

export async function GET() {
  const shells = listShells();
  const fallback = defaultShellId();
  const stored = await readStoredDefault();
  // A stored id can outlive what it names — a WSL distro gets unregistered, or
  // the database moves to another machine. Offering it anyway would leave the
  // user with a default that cannot open, so it only counts while it resolves.
  const selected = stored && shells.some((s) => s.id === stored) ? stored : fallback;

  return NextResponse.json({
    shells,
    defaultShellId: selected,
    // Distinguishes "the user has not chosen" from "the choice no longer
    // exists", so Settings can say which one it is.
    storedShellId: stored,
    platform: process.platform,
  });
}

export async function PUT(req: NextRequest) {
  const parsed = putSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { shellId } = parsed.data;
  const shells = listShells();
  if (!shells.some((s) => s.id === shellId)) {
    return NextResponse.json(
      {
        error: `Unknown shell "${shellId}" on this machine`,
        available: shells.map((s) => s.id),
      },
      { status: 400 },
    );
  }

  const workspaceId = await getActiveWorkspaceId();
  const key = scopedSettingKey(workspaceId, DEFAULT_SHELL_SETTING);
  await prisma.settings.upsert({
    where: { key },
    update: { value: shellId, isActive: true },
    create: { key, value: shellId, provider: "terminal", isActive: true },
  });

  return NextResponse.json({ defaultShellId: shellId });
}

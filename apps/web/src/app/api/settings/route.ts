import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  DEFAULT_WORKSPACE_ID,
  getActiveWorkspaceId,
  scopedSettingKey,
} from "@/lib/workspace";

const settingSchema = z.object({
  key: z.string().min(1, "Key is required"),
  value: z.string().min(1, "Value is required"),
  provider: z.string().optional(),
  isActive: z.boolean().default(true),
});

/**
 * Settings are workspace-scoped: non-default workspaces store their rows
 * under a "ws:<id>:" key prefix. GET returns the active workspace's own rows
 * (bare keys for the default workspace), plus the default workspace's rows a
 * non-default workspace inherits (marked `inherited`).
 */
export async function GET() {
  const workspaceId = await getActiveWorkspaceId();
  const settings = await prisma.settings.findMany({
    orderBy: { provider: "asc" },
  });

  const prefix = `ws:${workspaceId}:`;
  const own = settings
    .filter((s) =>
      workspaceId === DEFAULT_WORKSPACE_ID
        ? !s.key.startsWith("ws:")
        : s.key.startsWith(prefix),
    )
    .map((s) => ({ ...s, key: s.key.replace(prefix, ""), inherited: false }));
  const ownKeys = new Set(own.map((s) => s.key));
  const inherited =
    workspaceId === DEFAULT_WORKSPACE_ID
      ? []
      : settings
          .filter((s) => !s.key.startsWith("ws:") && !ownKeys.has(s.key))
          .map((s) => ({ ...s, inherited: true }));

  const masked = [...own, ...inherited].map((setting) => ({
    ...setting,
    value:
      setting.value.length > 4 ? "••••" + setting.value.slice(-4) : "••••",
  }));

  return NextResponse.json(masked);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = settingSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const workspaceId = await getActiveWorkspaceId();
  const { value, provider, isActive } = parsed.data;
  const key = scopedSettingKey(workspaceId, parsed.data.key);

  const existing = await prisma.settings.findUnique({ where: { key } });

  const setting = existing
    ? await prisma.settings.update({
        where: { key },
        data: { value, provider, isActive },
      })
    : await prisma.settings.create({
        data: { key, value, provider, isActive },
      });

  return NextResponse.json(setting);
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  if (!key) {
    return NextResponse.json({ error: "Key is required" }, { status: 400 });
  }

  const workspaceId = await getActiveWorkspaceId();
  await prisma.settings.delete({
    where: { key: scopedSettingKey(workspaceId, key) },
  });

  return NextResponse.json({ success: true });
}

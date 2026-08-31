import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { readInitialPassword } from "@nexux/sandbox";
import { getCivoToken } from "@/lib/sandbox-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

// Fallback for sandboxes created before write_password=true landed in the
// terraform template: ask the Civo API for the instance's initial password.
async function fetchPasswordFromCivo(
  instanceId: string,
  region: string,
): Promise<string | null> {
  const token = await getCivoToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `https://api.civo.com/v2/instances/${instanceId}?region=${encodeURIComponent(region)}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { initial_password?: string };
    return body.initial_password || null;
  } catch {
    return null;
  }
}

// Returns the Civo-generated root password, from the sandbox's local
// terraform state when available, else from the Civo API. Only served on
// demand — never persisted in the DB or included in regular payloads.
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }
  if (sandbox.status === "destroyed") {
    return NextResponse.json(
      { error: "Sandbox already destroyed" },
      { status: 410 },
    );
  }
  // Only Civo generates an initial root password; AWS is SSH-key only.
  if (sandbox.provider !== "civo") {
    return NextResponse.json(
      { error: "This provider has no initial password — use SSH keys" },
      { status: 404 },
    );
  }

  let password = readInitialPassword(sandbox.workDir);
  if (!password && sandbox.instanceId) {
    password = await fetchPasswordFromCivo(sandbox.instanceId, sandbox.region);
  }
  if (!password) {
    return NextResponse.json(
      { error: "Password not available (state or Civo API)" },
      { status: 404 },
    );
  }

  return NextResponse.json({ password });
}

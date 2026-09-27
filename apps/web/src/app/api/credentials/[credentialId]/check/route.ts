/**
 * Test a saved credential and store the result (spec 28).
 *
 * `?projectId=` adds whether a git token can push to that project's repos,
 * `?image=` whether it can pull that image — checks about *where* it is used
 * (phase 4). Those lines are returned, not stored: the stored result is what
 * the credential is, the same wherever it is shown.
 *
 * The checks talk only to the credential's own provider, and nothing that
 * comes back contains the secret.
 */

import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { checkCredential, type CheckLine, type CredentialCheck } from "@/lib/credential-checks";
import { checkRepoAccess } from "@/lib/credential-checks/context";
import { assertImagePullable } from "@/lib/host-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ credentialId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { credentialId } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId");
  const image = req.nextUrl.searchParams.get("image")?.trim() || null;
  const cred = await prisma.cloudCredential.findUnique({ where: { id: credentialId } });
  if (!cred) return NextResponse.json({ error: "Credential not found" }, { status: 404 });

  // An AWS check asks about EC2 in the region sandboxes launch in: the one a
  // project using this credential is configured for, when there is one.
  const awsRegion =
    cred.provider === "aws"
      ? ((
          await prisma.sandboxConfig.findFirst({
            where: { credentialId, provider: "aws" },
            select: { region: true },
          })
        )?.region ?? null)
      : null;
  const result = await checkCredential(cred, {}, { awsRegion });
  if (!result) {
    return NextResponse.json(
      { error: `Testing ${cred.provider} credentials isn't available yet.` },
      { status: 422 },
    );
  }
  await prisma.cloudCredential.update({
    where: { id: credentialId },
    data: { lastCheck: result, lastCheckedAt: new Date(result.checkedAt) },
  });

  const data = (cred.data ?? {}) as { token?: string; registryHost?: string | null };
  const context: CheckLine[] = [];
  // A rejected token cannot reach anything; its own lines already say why,
  // and a second wave of failures would only bury that.
  const usable = result.status !== "fail";

  if (projectId && data.token) {
    const repos = await prisma.repository.findMany({
      where: { projectId },
      select: { name: true, repoUrl: true },
      orderBy: { name: "asc" },
    });
    if (usable) {
      context.push(...(await checkRepoAccess({ provider: cred.provider, token: data.token, registryHost: data.registryHost }, repos)));
    } else {
      context.push({ label: "this project's repos", ok: false, detail: "the token itself is rejected — see above" });
    }
  }

  if (image && data.token) {
    const label = `pull ${image}`;
    if (!usable) {
      context.push({ label, ok: false, detail: "the token itself is rejected — see above" });
    } else {
      try {
        await assertImagePullable(
          image,
          { username: result.identity ?? "x-access-token", password: data.token, name: cred.name },
          true,
        );
        context.push({ label, ok: true });
      } catch (err) {
        context.push({ label, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const combined: CredentialCheck = {
    ...result,
    checks: [...result.checks, ...context],
    status:
      result.status === "fail" ? "fail" : context.some((c) => c.ok === false) ? "warn" : result.status,
  };
  return NextResponse.json(combined);
}

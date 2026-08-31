import { NextRequest, NextResponse } from "next/server";
import { deleteGitHubAccount, getPATForAccount } from "@/services/github";
import { prisma } from "@nexux/db";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    await deleteGitHubAccount(accountId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH - re-validate / refresh account status
export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    const pat = await getPATForAccount(accountId);

    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) {
      await prisma.connectedAccount.update({
        where: { id: accountId },
        data: { status: "error", lastCheckedAt: new Date() },
      });
      return NextResponse.json({ error: "Token is invalid or expired" }, { status: 401 });
    }

    const user = await res.json();

    const account = await prisma.connectedAccount.update({
      where: { id: accountId },
      data: {
        status: "connected",
        lastCheckedAt: new Date(),
        metadata: {
          login: user.login,
          name: user.name,
          avatar_url: user.avatar_url,
          email: user.email,
        },
      },
    });

    return NextResponse.json(account);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

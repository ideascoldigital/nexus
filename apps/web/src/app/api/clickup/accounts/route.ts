import { NextResponse } from "next/server";
import { listClickUpAccounts } from "@/services/clickup";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const accounts = await listClickUpAccounts();
    // Never expose tokens — just return account metadata
    return NextResponse.json(accounts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

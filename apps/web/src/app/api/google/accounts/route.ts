import { NextResponse } from "next/server";
import { listGoogleAccounts } from "@/services/google";

export const dynamic = "force-dynamic";

/** Connected Google accounts (spec 34): addresses and who may use them, never tokens. */
export async function GET() {
  return NextResponse.json(await listGoogleAccounts());
}

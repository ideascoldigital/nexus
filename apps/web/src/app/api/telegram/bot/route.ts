import { NextResponse } from "next/server";
import { getBotUsername } from "@/lib/telegram";

export const dynamic = "force-dynamic";

/** Bot identity for t.me deep links (never the token). */
export async function GET() {
  const username = await getBotUsername();
  return NextResponse.json({ configured: username !== null, username });
}

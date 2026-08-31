import { NextResponse } from "next/server";
import { getAppToken, getBotToken, getSlackIdentity } from "@/lib/slack";

export const dynamic = "force-dynamic";

/**
 * The Slack card's header line: whether a bot token exists, which workspace
 * it belongs to (auth.test, cached), and whether Socket Mode can run (app
 * token present). No token material ever leaves the server.
 */
export async function GET() {
  const [botToken, appToken] = await Promise.all([
    getBotToken(),
    getAppToken(),
  ]);
  if (!botToken) {
    return NextResponse.json({
      configured: false,
      team: null,
      botUser: null,
      socket: false,
    });
  }
  const identity = await getSlackIdentity();
  return NextResponse.json({
    configured: true,
    team: identity?.team ?? null,
    botUser: identity?.botUser ?? null,
    socket: Boolean(appToken),
  });
}

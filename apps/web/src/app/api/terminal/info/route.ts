import { NextResponse } from "next/server";

// Runtime terminal-server discovery. The pty WebSocket server (node-pty) is
// co-started in instrumentation.ts on NEXUX_TERMINAL_PORT. That port differs per
// app instance (web dev 3002, desktop dev 3102, …) so the browser client cannot
// hardcode it — it fetches the live value here. Read at request time, NOT build
// time, so the same bundle works in every target (web, desktop dev, sidecar).
export const dynamic = "force-dynamic";

export function GET() {
  const port = Number(process.env.NEXUX_TERMINAL_PORT ?? 3002);
  return NextResponse.json({ port });
}

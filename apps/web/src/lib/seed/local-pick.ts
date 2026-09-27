import type { NextRequest } from "next/server";

import { isHostInstall } from "@/lib/host-update";

/**
 * Whether "pick a file on this machine" makes sense for this request: the
 * server reads the path, so it must be the machine the person is sitting at.
 * True for the dashboard opened on localhost (browser or the desktop app);
 * false on a Nexus host, and for anything reaching this install over the
 * network, where a path typed in the browser names a file on someone else's
 * disk.
 */
export function canPickLocalFile(req: NextRequest): boolean {
  if (isHostInstall()) return false;
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

import path from "path";
import { getConfig } from "@nexux/config";

/**
 * Absolute path of the SQLite file DATABASE_URL names.
 *
 * Its own module, away from client.ts, so the instance lock can find the file
 * without constructing the client — which migrates on construction, and must
 * not before the lock says this is the only server (see instance-lock.ts).
 */
export function databasePath(): string {
  const url = getConfig().databaseUrl;
  if (!url.startsWith("file:")) {
    throw new Error(`Unsupported DATABASE_URL scheme: ${url}`);
  }
  const filePath = url.slice("file:".length);
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

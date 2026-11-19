/**
 * The desktop app's data location — client service. See lib/desktop-config.ts.
 */

export type DesktopConfigView = {
  configPath: string;
  file: { databasePath?: string; dataDir?: string } | null;
  fileError: string | null;
  effective: { databasePath: string; dataDir: string; databaseExists: boolean } | null;
  thisServer: { databasePath: string; dataDir: string; isDesktopApp: boolean };
};

async function errorFrom(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
    if (body.error) return JSON.stringify(body.error);
  } catch {
    // fall through
  }
  return `Request failed (${res.status})`;
}

export async function getDesktopConfig(): Promise<DesktopConfigView> {
  const res = await fetch("/api/desktop-config");
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

export async function saveDesktopConfig(input: {
  databasePath: string;
  dataDir: string;
}): Promise<DesktopConfigView> {
  const res = await fetch("/api/desktop-config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

export async function resetDesktopConfig(): Promise<DesktopConfigView> {
  const res = await fetch("/api/desktop-config", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

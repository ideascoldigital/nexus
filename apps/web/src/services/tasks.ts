import type { SandboxTask } from "@nexux/db";

export type TaskSummary = Omit<SandboxTask, "log"> & {
  sandbox: { name: string; publicIp: string | null };
  feature: { title: string } | null;
};

export type TaskDetail = SandboxTask & {
  sandbox: { name: string; publicIp: string | null };
  feature: { title: string } | null;
};

export type SandboxHealth = {
  reachable: boolean;
  bootstrapComplete: boolean;
  repoPresent: boolean;
  claudeReady: boolean;
  gitReady: boolean;
  gitCli: "gh" | "glab";
  gitStatus: string;
  /** Tailnet address, when the sandbox joined one. */
  tailscaleIp?: string | null;
  error?: string;
};

async function parseError(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => ({}) as { error?: unknown });
  const err = (body as { error?: unknown }).error;
  throw new Error(typeof err === "string" ? err : fallback);
}

export async function getTasks(
  projectId: string,
  featureId?: string,
): Promise<TaskSummary[]> {
  const qs = featureId ? `?featureId=${encodeURIComponent(featureId)}` : "";
  const res = await fetch(`/api/projects/${projectId}/tasks${qs}`);
  if (!res.ok) return parseError(res, "Failed to load tasks");
  return res.json();
}

export async function getTask(
  projectId: string,
  taskId: string,
): Promise<TaskDetail> {
  const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}`);
  if (!res.ok) return parseError(res, "Failed to load task");
  return res.json();
}

export async function runTask(
  projectId: string,
  data: {
    sandboxId?: string;
    /** No sandbox running? Launch one and dispatch when it's ready (M1). */
    launch?: boolean;
    featureId?: string;
    prompt?: string;
    followUpOf?: string;
  },
): Promise<SandboxTask | { launched: true; sandboxId: string }> {
  const res = await fetch(`/api/projects/${projectId}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) return parseError(res, "Failed to start task");
  return res.json();
}

export async function deleteTask(
  projectId: string,
  taskId: string,
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/tasks/${taskId}`, {
    method: "DELETE",
  });
  if (!res.ok) return parseError(res, "Failed to delete task");
}

export async function getSandboxHealth(
  projectId: string,
  sandboxId: string,
): Promise<SandboxHealth> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/health`,
  );
  if (!res.ok) return parseError(res, "Health check failed");
  return res.json();
}

export async function getTaskScreenshots(
  projectId: string,
  taskId: string,
): Promise<string[]> {
  const res = await fetch(
    `/api/projects/${projectId}/tasks/${taskId}/screenshots`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { files: string[] };
  return body.files;
}

export function taskScreenshotUrl(
  projectId: string,
  taskId: string,
  name: string,
): string {
  return `/api/projects/${projectId}/tasks/${taskId}/screenshots/${encodeURIComponent(name)}`;
}

export type BootstrapLog = {
  log: string;
  complete: boolean;
  /**
   * Every `[nexux] WARN:` line the run produced, from the whole file rather
   * than the tail in `log` — a finished bootstrap has long since scrolled its
   * own failures out of that window.
   */
  warnings?: string[];
  /**
   * Registration URL a keyless Tailscale join is waiting on, when the log has
   * one. Null on every other sandbox.
   */
  tailscaleAuthUrl?: string | null;
};

export async function getBootstrapLog(
  projectId: string,
  sandboxId: string,
): Promise<BootstrapLog> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/bootstrap-log`,
  );
  if (!res.ok) return parseError(res, "Could not read the bootstrap log");
  return res.json();
}

/**
 * Logs a running sandbox can be tailed for. The server owns the paths — these
 * ids only select one, so nothing client-supplied reaches a shell command.
 */
export const SANDBOX_LOG_SOURCES = [
  { id: "app", label: "App" },
  { id: "tunnel", label: "Tunnel" },
  { id: "bootstrap", label: "Bootstrap" },
  { id: "stack", label: "Stack services" },
  { id: "dockerd", label: "dockerd" },
] as const;

export type SandboxLogSource = (typeof SANDBOX_LOG_SOURCES)[number]["id"];

export type SandboxLog = { source: SandboxLogSource; log: string };

export async function getSandboxLog(
  projectId: string,
  sandboxId: string,
  source: SandboxLogSource,
): Promise<SandboxLog> {
  const res = await fetch(
    `/api/projects/${projectId}/sandboxes/${sandboxId}/logs?source=${source}`,
  );
  if (!res.ok) return parseError(res, "Could not read the log");
  return res.json();
}

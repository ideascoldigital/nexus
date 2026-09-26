/**
 * Remote Docker endpoints — client service. Spec: `specs/26-remote-docker-endpoints.md`.
 */

export type DockerEndpoint = {
  id: string;
  name: string;
  /** ssh://[user@]host[:port] */
  host: string;
  serverVersion: string | null;
  arch: string | null;
  memTotalMb: number | null;
  lastCheckedAt: string | null;
  /** Set when the last check failed; the facts above are from the last success. */
  lastError: string | null;
  /** Sandboxes still living on this daemon — removal is refused while > 0. */
  sandboxCount: number;
  /** Nexus hosts running on it (spec 27) — same rule. */
  hostCount: number;
  createdAt: string;
  updatedAt: string;
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

export async function getDockerEndpoints(): Promise<DockerEndpoint[]> {
  const res = await fetch("/api/docker-endpoints");
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

/** Probes the endpoint first; nothing is saved when the probe fails. */
export async function addDockerEndpoint(input: {
  name: string;
  host: string;
}): Promise<DockerEndpoint> {
  const res = await fetch("/api/docker-endpoints", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

export async function checkDockerEndpoint(id: string): Promise<DockerEndpoint> {
  const res = await fetch(`/api/docker-endpoints/${id}/check`, { method: "POST" });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

export async function deleteDockerEndpoint(id: string): Promise<void> {
  const res = await fetch(`/api/docker-endpoints/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorFrom(res));
}

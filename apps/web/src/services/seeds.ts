/** Seed data — client service for spec 29's `/api/projects/[id]/seeds`. */

import type { SeedSummary } from "@/lib/seed/store";

export type { SeedSummary };

export type SeedList = {
  seeds: SeedSummary[];
  /** Whether "pick a file on this machine" is offered (server = this machine). */
  canPickLocalFile: boolean;
  maxUploadBytes: number;
};

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: unknown }).error;
    throw new Error(typeof err === "string" ? err : `Request failed (${res.status})`);
  }
  return body as T;
}

export async function getSeeds(projectId: string): Promise<SeedList> {
  return json(await fetch(`/api/projects/${projectId}/seeds`));
}

/**
 * Upload a file as the raw request body. XHR rather than fetch: a dump can be
 * gigabytes, and fetch reports no upload progress.
 */
export function uploadSeed(
  projectId: string,
  opts: { nodeId: string; file: File; sensitive: boolean; onProgress?: (fraction: number) => void },
): Promise<SeedSummary> {
  const q = new URLSearchParams({
    nodeId: opts.nodeId,
    fileName: opts.file.name,
    sensitive: String(opts.sensitive),
  });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${projectId}/seeds?${q}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { error?: unknown } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // fall through with an empty body
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as SeedSummary);
      else reject(new Error(typeof body.error === "string" ? body.error : `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — the connection dropped."));
    xhr.send(opts.file);
  });
}

export async function seedFromPath(
  projectId: string,
  opts: { nodeId: string; path: string; sensitive: boolean },
): Promise<SeedSummary> {
  return json(
    await fetch(`/api/projects/${projectId}/seeds/from-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),
  );
}

export async function updateSeed(
  projectId: string,
  seedId: string,
  patch: { sensitive?: boolean; enabled?: boolean },
): Promise<SeedSummary> {
  return json(
    await fetch(`/api/projects/${projectId}/seeds/${seedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteSeed(projectId: string, seedId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/seeds/${seedId}`, { method: "DELETE" });
  if (!res.ok) await json(res);
}

export type SeedResetResult = {
  ok: boolean;
  services: Array<{ service: string; ok: boolean; message: string }>;
  setup: { ok: boolean; failed: string[] } | null;
  log: string;
};

export async function getSandboxSeeds(
  projectId: string,
  sandboxId: string,
): Promise<Array<{ service: string; fileName: string; sizeBytes: number }>> {
  const body = await json<{ seeds: Array<{ service: string; fileName: string; sizeBytes: number }> }>(
    await fetch(`/api/projects/${projectId}/sandboxes/${sandboxId}/seed/reset`),
  );
  return body.seeds;
}

export async function resetSandboxData(
  projectId: string,
  sandboxId: string,
  opts: { service?: string; runSetup?: boolean } = {},
): Promise<SeedResetResult> {
  return json(
    await fetch(`/api/projects/${projectId}/sandboxes/${sandboxId}/seed/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),
  );
}

/**
 * Nexus hosts — client service. Spec: `specs/19-nexus-host-provisioning.md`.
 */

export type HostStatus =
  | "pending"
  | "provisioning"
  | "bootstrapping"
  | "running"
  | "error"
  | "destroying"
  | "destroyed";

export type NexusHostSummary = {
  id: string;
  name: string;
  status: HostStatus;
  provider: "civo" | "aws";
  region: string;
  size: string;
  instanceId: string | null;
  publicIp: string | null;
  /** The address the dashboard is actually served on. */
  tailscaleIp: string | null;
  tailscaleName: string | null;
  imageRef: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The detail route adds the bootstrap log. */
export type NexusHostDetail = NexusHostSummary & { log: string };

export type HostReadiness = {
  terraformInstalled: boolean;
  hasCloudCredential: boolean;
  hasTailscaleCredential: boolean;
  /** True when this install is itself a host — the panel hides itself. */
  isHost: boolean;
  defaultImage: string;
};

export type CreateHostInput = {
  name: string;
  provider: "civo" | "aws";
  credentialId?: string | null;
  tailscaleCredentialId?: string | null;
  /** GitHub credential the host pulls a private GHCR image with. */
  registryCredentialId?: string | null;
  region: string;
  size: string;
  diskImage?: string;
  imageRef?: string;
  pullEmbeddingModel: boolean;
};

/** Statuses where the row is still moving and the UI should keep polling. */
export const HOST_IN_FLIGHT: HostStatus[] = [
  "pending",
  "provisioning",
  "bootstrapping",
  "destroying",
];

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

export async function getHosts(): Promise<NexusHostSummary[]> {
  const res = await fetch("/api/hosts");
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

export async function getHost(hostId: string): Promise<NexusHostDetail> {
  const res = await fetch(`/api/hosts/${hostId}`);
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

export async function getHostReadiness(): Promise<HostReadiness> {
  const res = await fetch("/api/hosts/readiness");
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

export async function createHost(
  input: CreateHostInput,
): Promise<NexusHostSummary> {
  const res = await fetch("/api/hosts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

/** How to reach a host over SSH — see `lib/host-ssh.ts`. */
export type HostSshTarget = {
  alias: string;
  host: string;
  user: string;
  privateKeyPath: string;
  /** Ready-to-paste `ssh -i … user@host`. */
  command: string;
  /** `ssh://user@host/` — the in-app terminal's cwd. */
  terminalTarget: string;
  overTailnet: boolean;
};

/**
 * Register the host in the managed SSH config and get its connection details.
 * POST because it writes ~/.ssh/config.
 */
export async function getHostSsh(hostId: string): Promise<HostSshTarget> {
  const res = await fetch(`/api/hosts/${hostId}/ssh`, { method: "POST" });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

/** Opens VS Code on the host over Remote-SSH. */
export async function openHostInVsCode(
  hostId: string,
): Promise<{ uri: string; host: string; launched: boolean }> {
  const res = await fetch(`/api/hosts/${hostId}/vscode`, { method: "POST" });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

/** What an update attempt did. */
export type HostUpdateResult = {
  ok: boolean;
  message: string;
  /** What the pull printed on the host, when there was a shell to capture it. */
  log?: string;
  /** Whether the running image changed; undefined when it cannot be known. */
  updated?: boolean;
};

/** Build identity of a running install — see `/api/version`. */
export type AppVersion = {
  version: string;
  gitSha: string | null;
  builtAt: string | null;
  /** Absent on hosts running an image from before these fields existed. */
  commitUrl?: string | null;
  releaseUrl?: string;
  /** True inside the native app. */
  native?: boolean;
};

/**
 * Which build this install is running. Null on 404: a host on an image from
 * before the route existed answers with Next's HTML 404, and "unknown" is the
 * truthful display for it.
 */
export async function getVersion(): Promise<AppVersion | null> {
  const res = await fetch("/api/version");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

/** Pull the newer image on a host and restart its stack, over SSH. */
export async function updateHost(hostId: string): Promise<HostUpdateResult> {
  const res = await fetch(`/api/hosts/${hostId}/update`, { method: "POST" });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

/**
 * Ask this machine — which must itself be a host — to update itself.
 *
 * The app restarts as part of it, so the request being accepted is all the
 * caller ever learns; the result arrives as the page coming back.
 */
export async function selfUpdate(): Promise<HostUpdateResult> {
  const res = await fetch("/api/hosts/self-update", { method: "POST" });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

/** The on-host updater's log — the only record of what a self-update did. */
export async function getSelfUpdateLog(): Promise<{
  log: string | null;
  isHost: boolean;
}> {
  const res = await fetch("/api/hosts/self-update");
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

export async function destroyHost(hostId: string): Promise<NexusHostSummary> {
  const res = await fetch(`/api/hosts/${hostId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

/** Region/size options per provider — the values the Terraform module accepts. */
export const HOST_REGIONS: Record<"civo" | "aws", string[]> = {
  civo: ["NYC1", "LON1", "FRA1", "PHX1"],
  aws: ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1"],
};

/**
 * Sizes worth offering. A host pulls a prebuilt image rather than building, so
 * 2 GB is enough to run it; the larger options exist for embeddings, which want
 * headroom for the model.
 */
export const HOST_SIZES: Record<
  "civo" | "aws",
  Array<{ value: string; label: string }>
> = {
  civo: [
    { value: "g3.small", label: "g3.small — 1 vCPU / 2 GB (no embeddings)" },
    { value: "g3.medium", label: "g3.medium — 2 vCPU / 4 GB" },
    { value: "g3.large", label: "g3.large — 4 vCPU / 8 GB (recommended)" },
  ],
  aws: [
    { value: "t3.small", label: "t3.small — 2 vCPU / 2 GB (no embeddings)" },
    { value: "t3.medium", label: "t3.medium — 2 vCPU / 4 GB" },
    { value: "t3.large", label: "t3.large — 2 vCPU / 8 GB (recommended)" },
  ],
};

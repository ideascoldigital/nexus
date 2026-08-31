import type { Project, Repository } from "@nexux/db";

export type ProjectWithCounts = Project & {
  repositories: Repository[];
  _count: {
    features: number;
    conversations: number;
    repositories: number;
  };
};

export type RepoInput = {
  name: string;
  repoUrl?: string;
  localPath?: string;
  isMain?: boolean;
  /** Git credential to clone with; omitted falls back to the provider's first. */
  gitCredentialId?: string;
};

export type CreateProjectInput = {
  name: string;
  description?: string;
  workspacePath?: string;
  repositories?: RepoInput[];
  /** Bootstrap a blank idea: scaffold `<parentPath>/<slug>` on disk. */
  bootstrap?: {
    type: string;
    parentPath: string;
  };
};

export type UpdateProjectInput = {
  name?: string;
  description?: string | null;
};

export type ProjectDefaults = {
  /** Suggested parent directory for bootstrap projects on this install. */
  bootstrapParentPath: string;
};

export async function getProjectDefaults(): Promise<ProjectDefaults> {
  const res = await fetch("/api/projects/defaults");
  if (!res.ok) throw new Error("Failed to fetch project defaults");
  return res.json();
}

export async function getProjects(): Promise<ProjectWithCounts[]> {
  const res = await fetch("/api/projects");
  if (!res.ok) throw new Error("Failed to fetch projects");
  return res.json();
}

export async function getProject(id: string): Promise<ProjectWithCounts> {
  const res = await fetch(`/api/projects/${id}`);
  if (!res.ok) throw new Error("Failed to fetch project");
  return res.json();
}

export async function createProject(
  data: CreateProjectInput
): Promise<Project & { repositories: Repository[] }> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json();
    // Bootstrap failures return a plain string; validation returns zod's
    // flattened shape.
    throw new Error(
      (typeof error.error === "string" && error.error) ||
        error.error?.fieldErrors?.name?.[0] ||
        "Failed to create project"
    );
  }
  return res.json();
}

export async function updateProject(
  id: string,
  data: UpdateProjectInput
): Promise<Project> {
  const res = await fetch(`/api/projects/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update project");
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete project");
}

// Repository CRUD
export async function getRepositories(
  projectId: string
): Promise<Repository[]> {
  const res = await fetch(`/api/projects/${projectId}/repositories`);
  if (!res.ok) throw new Error("Failed to fetch repositories");
  return res.json();
}

export async function addRepository(
  projectId: string,
  data: RepoInput
): Promise<Repository> {
  const res = await fetch(`/api/projects/${projectId}/repositories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to add repository");
  return res.json();
}

export async function updateRepository(
  projectId: string,
  repoId: string,
  data: Partial<
    Omit<RepoInput, "gitCredentialId"> & {
      cloneStatus?: string;
      detectRepoUrl?: boolean;
      /**
       * null returns the repo to the provider-wide fallback. Widened from
       * `RepoInput`'s create-only shape, where "no credential" is simply
       * omitting the field — an update has to be able to *clear* one.
       */
      gitCredentialId?: string | null;
    }
  >
): Promise<Repository> {
  const res = await fetch(
    `/api/projects/${projectId}/repositories/${repoId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      typeof body?.error === "string" ? body.error : "Failed to update repository",
    );
  }
  return res.json();
}

/** What a clone attempt did, per repository. */
export type CloneOutcome = {
  repoId: string;
  name: string;
  status: "ready" | "error";
  message: string;
};

async function cloneError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error || fallback);
}

/**
 * Check one repository out on the machine running Nexus.
 *
 * With `sync`, a checkout that is already there is pulled instead of merely
 * confirmed — the difference between "get me this code" and "get me the
 * latest".
 */
export async function cloneRepository(
  projectId: string,
  repoId: string,
  opts: { sync?: boolean } = {},
): Promise<CloneOutcome> {
  const res = await fetch(
    `/api/projects/${projectId}/repositories/${repoId}/clone${opts.sync ? "?sync=1" : ""}`,
    { method: "POST" },
  );
  if (!res.ok) return cloneError(res, "Failed to clone repository");
  return res.json();
}

/**
 * Check out every repository of a project that is not already there, and with
 * `sync`, pull the ones that are.
 */
export async function cloneProjectRepositories(
  projectId: string,
  opts: { sync?: boolean } = {},
): Promise<CloneOutcome[]> {
  const res = await fetch(
    `/api/projects/${projectId}/repositories/clone${opts.sync ? "?sync=1" : ""}`,
    { method: "POST" },
  );
  if (!res.ok) return cloneError(res, "Failed to clone repositories");
  const body = (await res.json()) as { results: CloneOutcome[] };
  return body.results;
}

export async function deleteRepository(
  projectId: string,
  repoId: string
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/repositories/${repoId}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error("Failed to delete repository");
}

// Embeddings index + search
export type IndexMode = "full" | "incremental";

export type IndexReport = {
  projectId: string;
  provider: string;
  dimensions: number;
  scanned: number;
  embedded: number;
  skipped: number;
  removed: number;
  durationMs: number;
};

export type IndexStatus = {
  total: number;
  lastIndexedAt: string | null;
  counts: Array<{
    sourceType: string;
    provider: string;
    _count: number;
    _sum: { chunkCount: number | null };
  }>;
};

export type SearchHit = {
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
  repoId?: string;
  filePath: string;
  snippet: string;
  startLine?: number;
  endLine?: number;
  heading?: string;
  score: number;
  bucket: "repo" | "conversations" | "project-data";
};

export type GroupedSearchResults = {
  repos: SearchHit[];
  conversations: SearchHit[];
  projectData: SearchHit[];
};

export async function getIndexStatus(projectId: string): Promise<IndexStatus> {
  const res = await fetch(`/api/projects/${projectId}/index`);
  if (!res.ok) throw new Error("Failed to load index status");
  return res.json();
}

export async function runIndex(
  projectId: string,
  mode: IndexMode = "incremental"
): Promise<IndexReport> {
  const res = await fetch(`/api/projects/${projectId}/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Indexing failed");
  }
  return res.json();
}

export async function dropIndex(projectId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/index`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to drop index");
}

export type EmbedderHealth = {
  provider: string;
  ollamaReachable: boolean;
  modelPresent: boolean;
  modelName: string;
  host: string;
  error?: string;
};

export async function getEmbedderHealth(): Promise<EmbedderHealth> {
  const res = await fetch("/api/embeddings/health");
  if (!res.ok) throw new Error("Failed to check embedder health");
  return res.json();
}

export type InstallProgress = {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  done?: boolean;
  error?: string;
};

export async function installEmbeddingModel(
  onProgress: (p: InstallProgress) => void
): Promise<void> {
  const res = await fetch("/api/embeddings/install-model", { method: "POST" });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Cannot start install");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line) as InstallProgress;
        onProgress(json);
        if (json.error) throw new Error(json.error);
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
}

// Orchestration: AgentSkill graph per project
export type OrchestrationEdge = {
  id: string;
  agentId: string;
  skillId: string;
  scope: "project" | "global";
};

export type OrchestrationData = {
  agents: Array<{
    id: string;
    name: string;
    description: string | null;
    color: string;
    model: string;
  }>;
  skills: Array<{
    id: string;
    name: string;
    description: string | null;
    source: string;
  }>;
  edges: OrchestrationEdge[];
};

export async function getProjectOrchestration(
  projectId: string
): Promise<OrchestrationData> {
  const res = await fetch(`/api/projects/${projectId}/orchestration`);
  if (!res.ok) throw new Error("Failed to load orchestration");
  return res.json();
}

export async function updateProjectOrchestration(
  projectId: string,
  edges: { agentId: string; skillId: string }[]
): Promise<{ ok: true; count: number }> {
  const res = await fetch(`/api/projects/${projectId}/orchestration`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edges }),
  });
  if (!res.ok) throw new Error("Failed to update orchestration");
  return res.json();
}

export async function searchProject(
  projectId: string,
  query: string,
  opts: { k?: number; sourceTypes?: string[]; repoIds?: string[] } = {}
): Promise<GroupedSearchResults> {
  const res = await fetch(`/api/projects/${projectId}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, ...opts }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Search failed");
  }
  return res.json();
}

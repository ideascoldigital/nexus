import type { Skill, Agent } from "@nexux/db";

export type SkillWithCount = Skill & {
  _count: {
    projectSkills: number;
  };
};

export async function getSkills(): Promise<SkillWithCount[]> {
  const res = await fetch("/api/skills");
  if (!res.ok) throw new Error("Failed to fetch skills");
  return res.json();
}

export async function createSkill(data: {
  name: string;
  description?: string;
  source?: string;
  scope?: "user" | "project";
  body?: string;
}): Promise<Skill> {
  const res = await fetch("/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.message || "Failed to create skill");
  }
  return res.json();
}

export async function syncSkills(): Promise<{ synced: number; total: number }> {
  const res = await fetch("/api/skills/sync", { method: "POST" });
  if (!res.ok) throw new Error("Failed to sync skills");
  return res.json();
}

export async function getProjectSkills(projectId: string): Promise<Skill[]> {
  const res = await fetch(`/api/projects/${projectId}/skills`);
  if (!res.ok) throw new Error("Failed to fetch project skills");
  return res.json();
}

export async function updateProjectSkills(
  projectId: string,
  skillIds: string[]
): Promise<Skill[]> {
  const res = await fetch(`/api/projects/${projectId}/skills`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillIds }),
  });
  if (!res.ok) throw new Error("Failed to update project skills");
  return res.json();
}

export async function getProjectAgents(projectId: string): Promise<Agent[]> {
  const res = await fetch(`/api/projects/${projectId}/agents`);
  if (!res.ok) throw new Error("Failed to fetch project agents");
  return res.json();
}

export async function updateProjectAgents(
  projectId: string,
  agentIds: string[]
): Promise<Agent[]> {
  const res = await fetch(`/api/projects/${projectId}/agents`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentIds }),
  });
  if (!res.ok) throw new Error("Failed to update project agents");
  return res.json();
}

export async function getSkill(id: string): Promise<Skill> {
  const res = await fetch(`/api/skills/${id}`);
  if (!res.ok) throw new Error("Failed to fetch skill");
  return res.json();
}

export async function updateSkill(
  id: string,
  data: { description?: string | null; body?: string }
): Promise<Skill> {
  const res = await fetch(`/api/skills/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? err.message ?? "Failed to update skill");
  }
  return res.json();
}

export async function deleteSkill(id: string): Promise<void> {
  const res = await fetch(`/api/skills/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to delete skill");
  }
}

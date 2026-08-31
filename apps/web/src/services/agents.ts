import type { Agent } from "@nexux/db";

export type AgentWithCount = Agent & {
  _count: { conversations: number };
};

interface CreateAgentInput {
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string;
  color?: string;
}

export async function getAgents(): Promise<AgentWithCount[]> {
  const res = await fetch("/api/agents");
  if (!res.ok) throw new Error("Failed to fetch agents");
  return res.json();
}

export async function createAgent(data: CreateAgentInput): Promise<Agent> {
  const res = await fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to create agent");
  }
  return res.json();
}

export async function syncAgents(): Promise<{ synced: number; total: number }> {
  const res = await fetch("/api/agents/sync", { method: "POST" });
  if (!res.ok) throw new Error("Failed to sync agents");
  return res.json();
}

export async function getAgent(id: string): Promise<Agent> {
  const res = await fetch(`/api/agents/${id}`);
  if (!res.ok) throw new Error("Failed to fetch agent");
  return res.json();
}

export async function updateAgent(
  id: string,
  data: Partial<CreateAgentInput>
): Promise<Agent> {
  const res = await fetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to update agent");
  }
  return res.json();
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to delete agent");
  }
}

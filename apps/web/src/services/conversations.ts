import type { Conversation, Message, Agent, Feature, Project, Repository } from "@nexux/db";

export type ConversationWithRelations = Conversation & {
  agent: Pick<Agent, "id" | "name" | "color"> | null;
  feature: Pick<Feature, "id" | "title"> | null;
  _count: { messages: number };
};

export type ConversationDetail = Conversation & {
  agent: Pick<Agent, "id" | "name" | "color"> | null;
  feature: Pick<Feature, "id" | "title"> | null;
  messages: Message[];
  project: Pick<Project, "id" | "name"> & { repositories: Repository[] };
};

interface CreateConversationInput {
  name?: string;
  featureId?: string;
  agentId?: string;
  model?: string;
  permissionMode?: string;
  systemPrompt?: string;
  prompt: string;
}

export async function getConversations(
  projectId: string
): Promise<ConversationWithRelations[]> {
  const res = await fetch(`/api/projects/${projectId}/conversations`);
  if (!res.ok) throw new Error("Failed to fetch conversations");
  return res.json();
}

export async function getConversation(
  projectId: string,
  conversationId: string
): Promise<ConversationDetail> {
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}`
  );
  if (!res.ok) throw new Error("Failed to fetch conversation");
  return res.json();
}

export async function createConversation(
  projectId: string,
  data: CreateConversationInput
): Promise<Conversation & { prompt: string }> {
  const res = await fetch(`/api/projects/${projectId}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

export async function updateConversation(
  projectId: string,
  conversationId: string,
  data: Partial<Conversation>
): Promise<Conversation> {
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }
  );
  if (!res.ok) throw new Error("Failed to update conversation");
  return res.json();
}

export async function deleteConversation(
  projectId: string,
  conversationId: string
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error("Failed to delete conversation");
}

import type { Feature } from "@nexux/db";

export type FeatureWithCounts = Feature & {
  devPhase: { id: string; name: string; status: string } | null;
  _count: {
    conversations: number;
    plans: number;
    featureIssues: number;
  };
  /** Distinct PR/MR links from this feature's runs, newest first. */
  prUrls: string[];
  /** Status of the feature's latest plan, null when it was never planned. */
  planStatus: string | null;
};

export type FeaturePlan = {
  id: string;
  title: string;
  content: string;
  status: string; // draft | pending_review | approved | rejected
  createdAt: string;
  updatedAt: string;
};

/** Latest plan for a feature, plus whether one is being generated now. */
export async function getFeaturePlan(
  projectId: string,
  featureId: string,
): Promise<{
  plan: FeaturePlan | null;
  running: boolean;
  /** Dev sandbox the latest plan run went to (null if never planned). */
  sandboxName: string | null;
}> {
  const res = await fetch(
    `/api/projects/${projectId}/features/${featureId}/plan`,
  );
  if (!res.ok) return { plan: null, running: false, sandboxName: null };
  return res.json();
}

/**
 * Kick off a read-only plan-mode run on the dev sandbox. With `followUp`,
 * the run revises the existing plan instead of starting over.
 */
export async function generateFeaturePlan(
  projectId: string,
  featureId: string,
  followUp?: string,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/features/${featureId}/plan`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(followUp ? { followUp } : {}),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Could not start the plan");
  }
}

export async function setFeaturePlanStatus(
  projectId: string,
  featureId: string,
  planId: string,
  status: "draft" | "pending_review" | "approved" | "rejected",
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/features/${featureId}/plan`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId, status }),
    },
  );
  if (!res.ok) throw new Error("Could not update the plan");
}

export type CreateFeatureInput = {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  /** null = inherit the project's sandbox policy; true/false pin this feature. */
  createPr?: boolean | null;
  devPhaseId?: string | null;
};

export type UpdateFeatureInput = Partial<CreateFeatureInput> & {
  order?: number;
  aiRefinement?: string;
};

export async function getFeatures(
  projectId: string
): Promise<FeatureWithCounts[]> {
  const res = await fetch(`/api/projects/${projectId}/features`);
  if (!res.ok) throw new Error("Failed to fetch features");
  return res.json();
}

export async function getFeature(
  projectId: string,
  featureId: string
): Promise<FeatureWithCounts> {
  const res = await fetch(`/api/projects/${projectId}/features/${featureId}`);
  if (!res.ok) throw new Error("Failed to fetch feature");
  return res.json();
}

export async function createFeature(
  projectId: string,
  data: CreateFeatureInput
): Promise<Feature> {
  const res = await fetch(`/api/projects/${projectId}/features`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(
      error.error?.fieldErrors?.title?.[0] || "Failed to create feature"
    );
  }
  return res.json();
}

export async function updateFeature(
  projectId: string,
  featureId: string,
  data: UpdateFeatureInput
): Promise<Feature> {
  const res = await fetch(`/api/projects/${projectId}/features/${featureId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update feature");
  return res.json();
}

export type FeatureAttachment = {
  name: string;
  mime: string;
  size: number;
};

export async function uploadFeatureAttachments(
  projectId: string,
  featureId: string,
  files: File[],
): Promise<FeatureAttachment[]> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch(
    `/api/projects/${projectId}/features/${featureId}/attachments`,
    { method: "POST", body: form },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : "Upload failed",
    );
  }
  return body.attachments;
}

export async function deleteFeatureAttachment(
  projectId: string,
  featureId: string,
  name: string,
): Promise<FeatureAttachment[]> {
  const res = await fetch(
    `/api/projects/${projectId}/features/${featureId}/attachments?name=${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : "Delete failed",
    );
  }
  return body.attachments;
}

export async function deleteFeature(
  projectId: string,
  featureId: string
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/features/${featureId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete feature");
}

/** One turn with the feature assistant (semantic-index-aware). */
export type FeatureAssistantReply = {
  message: string;
  feature: { title: string; description: string } | null;
  usedContext: boolean;
};

export async function askFeatureAssistant(
  projectId: string,
  message: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<FeatureAssistantReply> {
  const res = await fetch(`/api/projects/${projectId}/features/assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : "Assistant request failed",
    );
  }
  return body;
}

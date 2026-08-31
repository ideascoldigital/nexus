export type DevPhaseStatus = "planned" | "in_progress" | "done";

export type DevPhase = {
  id: string;
  projectId: string;
  name: string;
  goal: string | null;
  order: number;
  status: DevPhaseStatus;
  sourceSectionKeys: string[] | null;
  createdAt: string;
  updatedAt: string;
  _count: { features: number };
};

export type DevPhaseInput = {
  name: string;
  goal?: string;
  status?: DevPhaseStatus;
};

export async function getDevPhases(projectId: string): Promise<DevPhase[]> {
  const res = await fetch(`/api/projects/${projectId}/dev-phases`);
  if (!res.ok) throw new Error("Failed to fetch dev phases");
  return res.json();
}

export async function createDevPhase(
  projectId: string,
  data: DevPhaseInput
): Promise<DevPhase> {
  const res = await fetch(`/api/projects/${projectId}/dev-phases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to create dev phase");
  return res.json();
}

export async function updateDevPhase(
  projectId: string,
  devPhaseId: string,
  data: {
    name?: string;
    goal?: string | null;
    status?: DevPhaseStatus;
    order?: number;
  }
): Promise<DevPhase> {
  const res = await fetch(
    `/api/projects/${projectId}/dev-phases/${devPhaseId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }
  );
  if (!res.ok) throw new Error("Failed to update dev phase");
  return res.json();
}

export async function deleteDevPhase(
  projectId: string,
  devPhaseId: string
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/dev-phases/${devPhaseId}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error("Failed to delete dev phase");
}

export async function reorderDevPhases(
  projectId: string,
  orderedIds: string[]
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/dev-phases/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderedIds }),
  });
  if (!res.ok) throw new Error("Failed to reorder dev phases");
}

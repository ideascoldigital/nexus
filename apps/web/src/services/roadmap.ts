// Client mirror of the zod contract in roadmap-generator.ts.
export type ProposedFeature = {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
  acceptanceCriteria: string[];
  sourceSectionKeys: string[];
};

export type ProposedPhase = {
  name: string;
  goal: string;
  order: number;
  sourceSectionKeys: string[];
  features: ProposedFeature[];
};

export type RoadmapProposal = { phases: ProposedPhase[] };

export type GenerateRoadmapResult = {
  proposal: RoadmapProposal;
  sectionTitles: Record<string, string>;
};

export async function generateRoadmap(
  projectId: string
): Promise<GenerateRoadmapResult> {
  const res = await fetch(`/api/projects/${projectId}/roadmap/generate`, {
    method: "POST",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      typeof body?.error === "string" ? body.error : "Failed to generate roadmap"
    );
  }
  return body;
}

export async function applyRoadmap(
  projectId: string,
  proposal: RoadmapProposal,
  sectionTitles: Record<string, string>
): Promise<{ featureCount: number }> {
  const res = await fetch(`/api/projects/${projectId}/roadmap/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proposal, sectionTitles }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      typeof body?.error === "string" ? body.error : "Failed to apply roadmap"
    );
  }
  return body;
}

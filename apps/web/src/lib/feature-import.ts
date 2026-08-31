import { prisma } from "@nexux/db";

// Shared write path for external-tracker imports (ClickUp, GitHub, GitLab).
// One transaction: optional new DevPhase per group + its features, mirroring
// /roadmap/apply — except imported features keep their mapped status, so
// ordering is computed per kanban column. `linkTo` names the provenance
// join to create when a feature carries an external id.
export interface ImportFeature {
  title: string;
  description: string;
  priority: string;
  status: string;
  externalId: string | null;
}

export interface ImportPhase {
  name: string;
  goal: string;
  createPhase: boolean;
  features: ImportFeature[];
}

export async function importFeatures(
  projectId: string,
  phases: ImportPhase[],
  linkTo: "clickup" | "github" | "gitlab"
) {
  return prisma.$transaction(async (tx) => {
    const lastPhase = await tx.devPhase.findFirst({
      where: { projectId },
      orderBy: { order: "desc" },
      select: { order: true },
    });
    let phaseOrder = (lastPhase?.order ?? -1) + 1;

    const orderByStatus = new Map<string, number>();
    const nextOrder = async (status: string) => {
      if (!orderByStatus.has(status)) {
        const last = await tx.feature.findFirst({
          where: { projectId, status },
          orderBy: { order: "desc" },
          select: { order: true },
        });
        orderByStatus.set(status, (last?.order ?? -1) + 1);
      }
      const order = orderByStatus.get(status)!;
      orderByStatus.set(status, order + 1);
      return order;
    };

    let featureCount = 0;
    const createdPhases = [];

    for (const p of phases) {
      const phase = p.createPhase
        ? await tx.devPhase.create({
            data: {
              projectId,
              name: p.name,
              goal: p.goal.trim() || null,
              order: phaseOrder++,
            },
          })
        : null;

      for (const f of p.features) {
        const feature = await tx.feature.create({
          data: {
            projectId,
            devPhaseId: phase?.id ?? null,
            title: f.title,
            description: f.description.trim() || null,
            priority: f.priority,
            status: f.status,
            order: await nextOrder(f.status),
          },
        });
        if (f.externalId) {
          if (linkTo === "clickup") {
            await tx.featureClickUpTask.create({
              data: { featureId: feature.id, taskId: f.externalId },
            });
          } else if (linkTo === "gitlab") {
            await tx.featureGitLabIssue.create({
              data: { featureId: feature.id, issueId: f.externalId },
            });
          } else {
            await tx.featureIssue.create({
              data: { featureId: feature.id, issueId: f.externalId },
            });
          }
        }
        featureCount++;
      }
      if (phase) createdPhases.push(phase);
    }

    return { phases: createdPhases, featureCount };
  });
}

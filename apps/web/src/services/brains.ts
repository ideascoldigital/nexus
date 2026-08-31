import { prisma, Prisma } from "@nexux/db";
// import { ContextBuilder } from "@nexux/storage"; // TODO: Re-enable once ready

export async function getProjectBrain(projectId: string) {
  return prisma.projectBrain.findUnique({
    where: { projectId },
  });
}

export async function setProjectBrain(
  projectId: string,
  data: { provider: string; model: string; config?: Prisma.InputJsonValue }
) {
  const brain = await prisma.projectBrain.upsert({
    where: { projectId },
    update: data,
    create: { projectId, ...data },
  });

  // TODO: Re-enable once ContextBuilder is implemented
  // Get workspace path
  // const project = await prisma.project.findUnique({
  //   where: { id: projectId },
  //   select: { workspacePath: true },
  // });

  // if (project?.workspacePath) {
  //   const builder = new ContextBuilder(projectId, project.workspacePath);
  //   builder.buildInitialContext({
  //     provider: data.provider,
  //     model: data.model,
  //     config: data.config,
  //   });
  // }

  return brain;
}

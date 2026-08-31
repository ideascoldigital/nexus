import { prisma, Prisma } from "@nexux/db";

export async function getTools() {
  return prisma.tool.findMany();
}

export async function createTool(data: {
  name: string;
  provider: string;
  type: string;
  command?: string;
  endpoint?: string;
  description?: string;
  schema?: Prisma.InputJsonValue;
}) {
  return prisma.tool.create({ data });
}

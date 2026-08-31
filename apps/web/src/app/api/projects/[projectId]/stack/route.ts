import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { columnsOf, phasesOf } from "@/lib/stack/phases";

type Params = { params: Promise<{ projectId: string }> };

const portSchema = z.object({ host: z.number().int(), container: z.number().int() });
const envSchema = z.object({ key: z.string(), value: z.string() });
const volumeSchema = z.object({ host: z.string(), container: z.string() });

const phaseSchema = z.object({
  role: z.enum(["install", "build", "services", "run", "stop"]),
  exec: z.enum(["host", "compose", "compose-extern", "container"]),
  command: z.string().nullable(),
  image: z.string().nullable().optional(),
  composePath: z.string().nullable().optional(),
  provides: z.array(z.string()).optional(),
  detached: z.boolean().optional(),
  workdir: z.string().nullable().optional(),
});

const nodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["repo", "service"]),
  repositoryId: z.string().nullable().optional(),
  name: z.string().min(1),
  runMode: z.enum(["docker", "local"]).default("docker"),
  image: z.string().nullable().optional(),
  dockerfile: z.string().nullable().optional(),
  buildContext: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  installCommand: z.string().nullable().optional(),
  buildCommand: z.string().nullable().optional(),
  localCommand: z.string().nullable().optional(),
  stopCommand: z.string().nullable().optional(),
  managesServices: z.boolean().optional(),
  workdir: z.string().nullable().optional(),
  ports: z.array(portSchema).nullable().optional(),
  env: z.array(envSchema).nullable().optional(),
  volumes: z.array(volumeSchema).nullable().optional(),
  // Phases are the source of truth when sent. A client that does not send them
  // (or sends none) still saves through the command columns, which are derived
  // back into phases here.
  phases: z.array(phaseSchema).nullable().optional(),
  posX: z.number().default(0),
  posY: z.number().default(0),
});

const saveSchema = z.object({
  nodes: z.array(nodeSchema),
  edges: z.array(z.object({ sourceId: z.string(), targetId: z.string() })),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const [nodes, edges] = await Promise.all([
    prisma.stackNode.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.stackEdge.findMany({ where: { projectId } }),
  ]);

  return NextResponse.json({
    nodes,
    edges: edges.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
    })),
  });
}

const isTempId = (id: string) => id.startsWith("tmp-");

export async function PUT(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const body = await req.json();
  const parsed = saveSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { nodes, edges } = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    // Delete nodes no longer on the canvas (cascades their edges)
    const keepIds = nodes.filter((n) => !isTempId(n.id)).map((n) => n.id);
    await tx.stackNode.deleteMany({
      where: { projectId, id: { notIn: keepIds } },
    });

    // Deriving a phase reads the node's cached detection to see what a `make`
    // target's recipe does. The payload never carries detection (it is scanned
    // server-side and never round-trips), so read it off the stored rows or a
    // launcher would lose its composePath/provides on every save.
    const stored = await tx.stackNode.findMany({
      where: { projectId },
      select: { id: true, detection: true },
    });
    const detectionById = new Map(stored.map((n) => [n.id, n.detection]));

    // Upsert nodes; map temp ids to real cuids for edge resolution
    const idMap = new Map<string, string>();
    for (const n of nodes) {
      // Phases are the source of truth; the command columns are written from
      // them so a rollback, or a reader not yet migrated, still sees a coherent
      // node. A client that sends no phases gets them derived from its columns,
      // which makes this a no-op for the pre-cutover payload.
      const phases = n.phases?.length
        ? n.phases
        : phasesOf({ ...n, detection: detectionById.get(n.id) });
      const derived = columnsOf(phases);
      const data = {
        kind: n.kind,
        name: n.name,
        runMode: derived.runMode,
        image: n.image ?? null,
        dockerfile: n.dockerfile ?? null,
        buildContext: n.buildContext ?? null,
        command: n.command ?? null,
        installCommand: derived.installCommand,
        buildCommand: derived.buildCommand,
        localCommand: derived.localCommand,
        stopCommand: derived.stopCommand,
        managesServices: derived.managesServices,
        phases,
        workdir: n.workdir ?? null,
        ports: n.ports ?? undefined,
        env: n.env ?? undefined,
        volumes: n.volumes ?? undefined,
        posX: n.posX,
        posY: n.posY,
      };
      if (isTempId(n.id)) {
        const created = await tx.stackNode.create({
          data: { ...data, repositoryId: n.repositoryId ?? null, projectId },
        });
        idMap.set(n.id, created.id);
      } else {
        // repositoryId is @unique, so update only takes it as a relation.
        await tx.stackNode.update({
          where: { id: n.id },
          data: {
            ...data,
            repository: n.repositoryId
              ? { connect: { id: n.repositoryId } }
              : { disconnect: true },
          },
        });
        idMap.set(n.id, n.id);
      }
    }

    // Replace edges
    await tx.stackEdge.deleteMany({ where: { projectId } });
    const edgeData = edges
      .map((e) => ({
        projectId,
        sourceId: idMap.get(e.sourceId) ?? e.sourceId,
        targetId: idMap.get(e.targetId) ?? e.targetId,
      }))
      .filter((e) => e.sourceId !== e.targetId);
    if (edgeData.length > 0) {
      await tx.stackEdge.createMany({ data: edgeData });
    }

    const savedNodes = await tx.stackNode.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    const savedEdges = await tx.stackEdge.findMany({ where: { projectId } });
    return { savedNodes, savedEdges };
  });

  return NextResponse.json({
    ok: true,
    nodes: result.savedNodes,
    edges: result.savedEdges.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
    })),
  });
}

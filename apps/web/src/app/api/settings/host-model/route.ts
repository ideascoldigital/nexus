import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@nexux/db";
import { z } from "zod";

import {
  resolveHostModel,
  HOST_MODEL_PROVIDERS,
  HOST_MODEL_SETTING,
  HOST_MODEL_NAME_SETTING,
} from "@/lib/host-model";

/**
 * What the user explicitly chose, as opposed to what got resolved.
 *
 * The two differ whenever nothing was chosen (the resolver picks one anyway)
 * or a chosen credential stopped being usable (it falls through). A picker fed
 * only the resolved answer cannot tell "automatic, which happens to be this"
 * from "I chose this", and would reset itself to Automatic after every save.
 */
async function readChoice() {
  const [credential, model] = await Promise.all([
    prisma.settings.findFirst({
      where: { key: HOST_MODEL_SETTING, isActive: true },
    }),
    prisma.settings.findFirst({
      where: { key: HOST_MODEL_NAME_SETTING, isActive: true },
    }),
  ]);
  return {
    credentialId: credential?.value?.trim() || null,
    modelName: model?.value?.trim() || null,
  };
}

export const dynamic = "force-dynamic";

/**
 * Which model the host's own agents run on — the stack assistant, the repair
 * loop, the roadmap generator, the definer.
 *
 * GET answers with what is in use and what else could be, so the settings UI
 * can offer a choice rather than assuming one. A credential that holds no
 * usable key is listed as unusable rather than hidden: "I added that key" and
 * "that key is empty" are different problems, and hiding the row makes the
 * second look like the first.
 */
export async function GET() {
  const [current, chosen, credentials] = await Promise.all([
    resolveHostModel(),
    readChoice(),
    prisma.cloudCredential.findMany({
      where: { provider: { in: Object.keys(HOST_MODEL_PROVIDERS) } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, provider: true, data: true },
    }),
  ]);

  return NextResponse.json({
    chosen,
    current: current
      ? {
          provider: current.provider,
          modelName: current.modelName,
          credentialName: current.credentialName,
        }
      : null,
    options: credentials.map((c) => {
      const data = (c.data ?? {}) as { apiKey?: unknown; token?: unknown };
      const key = typeof data.apiKey === "string" ? data.apiKey : data.token;
      return {
        credentialId: c.id,
        name: c.name,
        provider: HOST_MODEL_PROVIDERS[c.provider],
        usable: typeof key === "string" && key.trim().length > 0,
      };
    }),
  });
}

const bodySchema = z.object({
  /** null clears the choice, falling back to "any usable credential". */
  credentialId: z.string().nullable().optional(),
  /** null clears the override, falling back to the provider's default. */
  modelName: z.string().nullable().optional(),
});

export async function PUT(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const write = async (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null || !value.trim()) {
      await prisma.settings.deleteMany({ where: { key } });
      return;
    }
    await prisma.settings.upsert({
      where: { key },
      create: { key, value: value.trim(), isActive: true },
      update: { value: value.trim(), isActive: true },
    });
  };

  await write(HOST_MODEL_SETTING, parsed.data.credentialId);
  await write(HOST_MODEL_NAME_SETTING, parsed.data.modelName);

  // Answer with what the choice actually resolved to, rather than echoing the
  // request: a credential that turns out to be unusable falls through, and the
  // user should see which model they really got.
  const [current, chosen] = await Promise.all([resolveHostModel(), readChoice()]);
  return NextResponse.json({
    chosen,
    current: current && {
      provider: current.provider,
      modelName: current.modelName,
      credentialName: current.credentialName,
    },
  });
}

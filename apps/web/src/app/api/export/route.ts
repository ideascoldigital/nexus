/**
 * Configuration export. Spec: `specs/18-config-export-import.md`.
 *
 * Two verbs on purpose:
 *
 * - `GET` — the common, secretless case, so the UI can be a plain download
 *   link. Refuses `includeSecrets`: a passphrase in a query string lands in
 *   server logs and browser history.
 * - `POST` — takes the passphrase in a body and returns the sealed envelope.
 *
 * Both return a file download; nothing is written to disk here.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { collectExport, exportFilename } from "@/lib/export/collect";
import { PassphraseError, seal } from "@/lib/export/envelope";
import { exportDocumentSchema } from "@/lib/export/schema";

const MIN_PASSPHRASE = 12;

const optionsSchema = z
  .object({
    scope: z.enum(["all", "project"]).default("all"),
    projectIds: z.array(z.string()).default([]),
    includeSecrets: z.boolean().default(false),
    includeConversations: z.boolean().default(false),
    template: z.boolean().default(false),
    pathRoot: z.string().optional(),
    passphrase: z.string().optional(),
  })
  .refine((o) => o.scope !== "project" || o.projectIds.length > 0, {
    message: "scope=project requires at least one projectId",
    path: ["projectIds"],
  })
  .refine((o) => !o.includeSecrets || (o.passphrase ?? "").length >= MIN_PASSPHRASE, {
    message: `includeSecrets requires a passphrase of at least ${MIN_PASSPHRASE} characters`,
    path: ["passphrase"],
  })
  // A template exists to be handed to someone else — the one file that must
  // never carry tokens, env values or conversation history.
  .refine((o) => !(o.template && o.includeSecrets), {
    message: "a template never carries secrets",
    path: ["template"],
  });

type Options = z.infer<typeof optionsSchema>;

async function build(options: Options) {
  const document = await collectExport({
    scope:
      options.scope === "project"
        ? { kind: "project", projectIds: options.projectIds }
        : { kind: "all" },
    includeSecrets: options.includeSecrets,
    includeConversations: options.includeConversations,
    template: options.template,
    pathRoot: options.pathRoot,
  });

  // Validate what we produced, not just what we receive. A collector that
  // drifts from the schema should fail here rather than write a file the
  // destination will reject after the user has moved it.
  const parsed = exportDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(
      `Export failed validation: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`,
    );
  }

  const body = options.includeSecrets
    ? await seal(parsed.data, options.passphrase!)
    : parsed.data;

  return NextResponse.json(body, {
    headers: {
      "Content-Disposition": `attachment; filename="${exportFilename(options.includeSecrets, new Date(), options.template)}"`,
      // An export is a snapshot of live state; a cached copy is a stale one.
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  if (params.get("includeSecrets") === "true") {
    return NextResponse.json(
      {
        error:
          "includeSecrets requires POST — a passphrase must not travel in a URL",
      },
      { status: 400 },
    );
  }

  const parsed = optionsSchema.safeParse({
    scope: params.get("scope") ?? "all",
    projectIds: params.getAll("projectId"),
    includeSecrets: false,
    includeConversations: params.get("includeConversations") === "true",
    template: params.get("template") === "true",
    pathRoot: params.get("pathRoot") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    return await build(parsed.data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Export failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    return await build(parsed.data);
  } catch (err) {
    if (err instanceof PassphraseError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Export failed" },
      { status: 500 },
    );
  }
}

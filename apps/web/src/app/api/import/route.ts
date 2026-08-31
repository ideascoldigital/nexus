/**
 * Configuration import. Spec: `specs/18-config-export-import.md`.
 *
 * `dryRun: true` runs every validation and lookup, writes nothing, and returns
 * the plan the UI renders before the user commits — the same pattern
 * `POST …/env-vars/bulk` already establishes. The dry run and the write are one
 * code path in `applyImport`, so the preview cannot drift from what runs.
 *
 * A file carrying secrets arrives as a sealed envelope and needs the passphrase
 * that sealed it; the plaintext is opened here and never echoed back.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getConfig } from "@nexux/config";

import { applyImport } from "@/lib/export/apply";
import { PassphraseError, isEncrypted, open } from "@/lib/export/envelope";
import { exportDocumentSchema } from "@/lib/export/schema";

const bodySchema = z.object({
  /** Defaults to a preview: writing must be asked for explicitly. */
  dryRun: z.boolean().default(true),
  mode: z.enum(["merge", "replace"]).default("merge"),
  /** Destination root for `{ root: "pathRoot" }` entries in the file. */
  pathRoot: z.string().optional(),
  /** Required when `data` is a sealed envelope. */
  passphrase: z.string().optional(),
  data: z.unknown(),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { dryRun, mode, pathRoot, passphrase, data } = parsed.data;

  // Unseal first — an encrypted file tells us nothing until it is opened.
  let payload: unknown = data;
  if (isEncrypted(data)) {
    if (!passphrase) {
      return NextResponse.json(
        { error: "This file is encrypted — a passphrase is required" },
        { status: 400 },
      );
    }
    try {
      payload = await open(data, passphrase);
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof PassphraseError ? err.message : "Could not open the file",
        },
        { status: 400 },
      );
    }
  }

  const document = exportDocumentSchema.safeParse(payload);
  if (!document.success) {
    return NextResponse.json(
      {
        error: "Not a valid Nexus export",
        issues: document.error.issues.slice(0, 10),
      },
      { status: 400 },
    );
  }

  // An import that names no root is rebased onto this machine's own workspace
  // rather than left unresolved. Taking the source machine's layout on trust is
  // how a host ends up with rows pointing at `/opt/workspace`: a path its
  // unprivileged container cannot create, so every clone fails with EACCES.
  const destinationRoot = pathRoot || getConfig().workspaceRoot;

  try {
    const plan = await applyImport(document.data, {
      mode,
      pathRoot: destinationRoot,
      dryRun,
    });
    // A plan with errors is a refusal, not a failure: the body is the same
    // shape the dry run returns, so the UI renders it the same way.
    return NextResponse.json(plan, { status: plan.ok ? 200 : 422 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Import failed" },
      { status: 500 },
    );
  }
}

/**
 * Configuration export — client service. Spec:
 * `specs/18-config-export-import.md`.
 *
 * The download is driven from the browser rather than through React Query: the
 * response is a file, not state to cache, and an export is a snapshot that
 * should never be served twice from a cache.
 */

export type ExportScope =
  | { kind: "all" }
  | { kind: "project"; projectIds: string[] };

export type ExportOptions = {
  scope: ExportScope;
  includeSecrets: boolean;
  includeConversations: boolean;
  /**
   * Structure only — repositories, stack, sandbox config, agents/skills, env
   * var keys — without features, phases, documents, schedules, conversations
   * or secrets. The file to hand a teammate.
   */
  template?: boolean;
  pathRoot?: string;
  /** Required when `includeSecrets` — at least 12 characters. */
  passphrase?: string;
};

/** Server-side minimum; mirrored here so the form can validate before posting. */
export const MIN_PASSPHRASE = 12;

function filenameFrom(res: Response, fallback: string): string {
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  return match?.[1] ?? fallback;
}

async function errorFrom(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
    if (body.error) return JSON.stringify(body.error);
  } catch {
    // fall through to the status text
  }
  return `Export failed (${res.status})`;
}

/**
 * Fetch the export and hand it to the browser as a download.
 *
 * Secretless exports go over `GET` so the URL is shareable/bookmarkable;
 * anything carrying secrets uses `POST`, because a passphrase in a query string
 * ends up in server logs and browser history. The server enforces the same
 * split — this is not the only guard.
 */
export async function downloadExport(options: ExportOptions): Promise<string> {
  const res = options.includeSecrets
    ? await fetch("/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: options.scope.kind,
          projectIds:
            options.scope.kind === "project" ? options.scope.projectIds : [],
          includeSecrets: true,
          includeConversations: options.includeConversations,
          pathRoot: options.pathRoot,
          passphrase: options.passphrase,
        }),
      })
    : await fetch(buildQuery(options));

  if (!res.ok) throw new Error(await errorFrom(res));

  const blob = await res.blob();
  const filename = filenameFrom(
    res,
    `nexux-export.json${options.includeSecrets ? ".enc" : ""}`,
  );

  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Revoking synchronously can cancel the download in some browsers; the
    // click has already been dispatched, so a tick of slack is enough.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return filename;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ImportMode = "merge" | "replace";

export type ImportOptions = {
  /** The parsed file: a raw export document, or a sealed envelope. */
  data: unknown;
  mode: ImportMode;
  /** Destination root for paths the file stored relative to its own root. */
  pathRoot?: string;
  /** Required when the file is encrypted. */
  passphrase?: string;
};

/** Mirrors `ImportPlan` in `@/lib/export/apply`. */
export type ImportPlan = {
  ok: boolean;
  dryRun: boolean;
  mode: ImportMode;
  schemaVersion: {
    file: string;
    destination: string;
    verdict: "equal" | "destination-newer" | "destination-older" | "unknown";
  };
  workspaces: Counts;
  credentials: Counts & { needsSecret: string[] };
  settings: Counts;
  catalogs: Record<string, Counts>;
  projects: Array<{
    id: string;
    name: string;
    action: "create" | "update";
    counts: Record<string, Counts>;
    paths: Array<{
      field: string;
      resolved: string | null;
      existsOnDisk: boolean;
      absolute?: boolean;
    }>;
  }>;
  envVars: { needsValue: number };
  schedules: { importedDisabled: number };
  warnings: string[];
  errors: string[];
};

export type Counts = { create: number; update: number; delete: number };

/** True when the parsed file needs a passphrase before it can be read. */
export function fileIsEncrypted(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { encrypted?: unknown }).encrypted === true
  );
}

async function postImport(
  options: ImportOptions,
  dryRun: boolean,
): Promise<ImportPlan> {
  const res = await fetch("/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dryRun,
      mode: options.mode,
      pathRoot: options.pathRoot,
      passphrase: options.passphrase,
      data: options.data,
    }),
  });

  // 422 carries a plan whose `errors` explain the refusal — same shape as a
  // dry run, so the caller renders it the same way. Anything else is a fault.
  if (!res.ok && res.status !== 422) throw new Error(await errorFrom(res));
  return (await res.json()) as ImportPlan;
}

/** Validate and plan without writing. Always call this before `commitImport`. */
export function previewImport(options: ImportOptions): Promise<ImportPlan> {
  return postImport(options, true);
}

/** Apply for real. `replace` deletes rows the file does not carry. */
export function commitImport(options: ImportOptions): Promise<ImportPlan> {
  return postImport(options, false);
}

/** The `GET /api/export` URL for a secretless export. Exported for tests. */
export function buildQuery(
  options: Pick<
    ExportOptions,
    "scope" | "includeConversations" | "template" | "pathRoot"
  >,
): string {
  const params = new URLSearchParams();
  if (options.scope.kind === "project") {
    params.set("scope", "project");
    for (const id of options.scope.projectIds) params.append("projectId", id);
  }
  if (options.includeConversations) params.set("includeConversations", "true");
  if (options.template) params.set("template", "true");
  if (options.pathRoot) params.set("pathRoot", options.pathRoot);
  const query = params.toString();
  return query ? `/api/export?${query}` : "/api/export";
}

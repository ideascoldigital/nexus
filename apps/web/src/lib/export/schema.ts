/**
 * The export document — one zod schema, used by both ends.
 *
 * Export validates what it produces and import validates what it receives
 * against this same definition, so the two cannot drift into disagreeing about
 * the format. Spec: `specs/18-config-export-import.md`.
 *
 * Two rules the shape encodes:
 *
 * - **Host paths never travel absolute.** `workspacePath` / `localPath` are
 *   `{ root: "pathRoot", rel }` so a Mac export lands on a Linux VM. Paths
 *   outside the common root keep `{ root: "absolute", abs }` — mangling them
 *   silently is worse than reporting them.
 * - **Secrets are nullable, not absent.** A secretless export still carries the
 *   env var's key and the credential's identity with `value`/`data` null, so
 *   the destination gets a checklist of what to fill rather than a project
 *   missing half its configuration.
 */

import { z } from "zod";

/** Bumped only when this document's structure changes. */
export const EXPORT_VERSION = 1;

/**
 * A path that came off the source host. Relative to the document's `pathRoot`
 * when it lived under it, absolute otherwise (rare, and surfaced in the import
 * preview rather than rewritten).
 */
export const portablePathSchema = z.union([
  z.object({ root: z.literal("pathRoot"), rel: z.string() }),
  z.object({ root: z.literal("absolute"), abs: z.string() }),
]);

export type PortablePath = z.infer<typeof portablePathSchema>;

/** Prisma `Json?` columns pass through verbatim — the canvas owns their shape. */
const json = z.unknown().nullable();

const isoDate = z.string();

export const metaSchema = z.object({
  nexuxExportVersion: z.number().int(),
  /** Last applied row of `_nexux_migrations` on the source. */
  schemaVersion: z.string(),
  exportedAt: isoDate,
  sourceMode: z.enum(["local", "server"]),
  /** Longest common prefix of every exported host path ("" when none). */
  pathRoot: z.string(),
  includesSecrets: z.boolean(),
  includesConversations: z.boolean(),
  /**
   * Structure-only export (no features, phases, documents, schedules or
   * conversations). Optional so files from before the field validate; an old
   * install importing a template just sees a smaller ordinary export.
   */
  template: z.boolean().optional(),
  scope: z.union([
    z.object({ kind: z.literal("all") }),
    z.object({ kind: z.literal("project"), projectIds: z.array(z.string()) }),
  ]),
});

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  logo: z.string().nullable(),
});

/**
 * Credential *shell*: identity always, secret only with `includeSecrets`.
 * Emitted even when secretless so `SandboxConfig`'s credential FKs stay intact
 * — those FKs are which token a project pinned (D-28), which is configuration,
 * not a secret.
 */
export const credentialSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  provider: z.string(),
  data: json,
});

export const settingSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string().nullable(),
  provider: z.string().nullable(),
  isActive: z.boolean(),
});

export const agentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  systemPrompt: z.string(),
  model: z.string(),
  color: z.string(),
  isBuiltIn: z.boolean(),
  filePath: z.string().nullable(),
});

export const skillSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  source: z.string(),
  scope: z.string().nullable(),
  path: z.string().nullable(),
  body: z.string().nullable(),
  isBuiltIn: z.boolean(),
});

export const toolSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  type: z.string(),
  command: z.string().nullable(),
  endpoint: z.string().nullable(),
  description: z.string().nullable(),
  schema: json,
});

export const repositorySetupSchema = z.object({
  id: z.string(),
  installCommand: z.string().nullable(),
  buildCommand: z.string().nullable(),
  runCommand: z.string().nullable(),
  branch: z.string().nullable(),
});

export const repositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  repoUrl: z.string().nullable(),
  localPath: portablePathSchema.nullable(),
  isMain: z.boolean(),
  /**
   * Which git credential clones this repo. Optional so files written before
   * repositories could carry one still validate.
   */
  gitCredentialId: z.string().nullable().optional(),
  setup: repositorySetupSchema.nullable(),
});

export const stackNodeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  repositoryId: z.string().nullable(),
  name: z.string(),
  runMode: z.string(),
  image: z.string().nullable(),
  dockerfile: z.string().nullable(),
  buildContext: z.string().nullable(),
  command: z.string().nullable(),
  installCommand: z.string().nullable(),
  buildCommand: z.string().nullable(),
  localCommand: z.string().nullable(),
  stopCommand: z.string().nullable(),
  workdir: z.string().nullable(),
  managesServices: z.boolean(),
  ports: json,
  env: json,
  volumes: json,
  detection: json,
  phases: json,
  posX: z.number(),
  posY: z.number(),
  /**
   * The seed attached to this service (spec 29) — what it was, never the
   * file. A dump can be gigabytes and hold real people's data; it does not
   * belong in a JSON document that gets emailed. The destination is told to
   * attach it again unless it already holds the same file.
   */
  seed: z
    .object({
      fileName: z.string(),
      format: z.string(),
      sizeBytes: z.number(),
      sha256: z.string(),
      sensitive: z.boolean(),
    })
    .nullable()
    .optional(),
});

export const stackEdgeSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
});

export const sandboxConfigSchema = z.object({
  id: z.string(),
  provider: z.string(),
  credentialId: z.string().nullable(),
  githubCredentialId: z.string().nullable(),
  claudeCredentialId: z.string().nullable(),
  llmCredentialIds: z.array(z.string()),
  region: z.string(),
  size: z.string(),
  diskImage: z.string(),
  branch: z.string().nullable(),
  sshPublicKey: z.string().nullable(),
  installDocker: z.boolean(),
  installNode: z.boolean(),
  installClaudeCode: z.boolean(),
  installAgentBrowser: z.boolean(),
  installCloudflared: z.boolean(),
  // Defaulted: exports written before the Tailscale option lack these keys.
  installTailscale: z.boolean().default(false),
  tailscaleCredentialId: z.string().nullable().default(null),
  includeStackServices: z.boolean(),
  telegramChatId: z.string().nullable(),
  setupScript: z.string().nullable(),
  mcpServers: json,
  brain: z.string(),
  agentInstructions: z.string().nullable(),
  claudeModel: z.string().nullable(),
  openCodeModel: z.string().nullable(),
  installOpenCode: z.boolean(),
  createPr: z.boolean(),
  runTests: z.boolean(),
  captureScreenshots: z.boolean(),
  livePreview: z.boolean(),
  previewPort: z.number().int().nullable(),
});

export const envVarSchema = z.object({
  id: z.string(),
  key: z.string(),
  repositoryId: z.string().nullable(),
  /** Null unless `includeSecrets` — the key alone is still worth carrying. */
  value: z.string().nullable(),
});

export const featureSchema = z.object({
  id: z.string(),
  devPhaseId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  aiRefinement: z.string().nullable(),
  sourceSectionKeys: json,
  attachments: json,
  order: z.number().int(),
});

export const devPhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string().nullable(),
  order: z.number().int(),
  status: z.string(),
  sourceSectionKeys: json,
});

export const phaseSchema = z.object({
  id: z.string(),
  key: z.string(),
  order: z.number().int(),
  status: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
});

export const documentSectionSchema = z.object({
  id: z.string(),
  phaseKey: z.string(),
  key: z.string(),
  title: z.string(),
  content: z.string(),
  ownerRole: z.string(),
  order: z.number().int(),
  status: z.string(),
});

export const documentSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.string(),
  sections: z.array(documentSectionSchema),
});

export const brainSchema = z.object({
  id: z.string(),
  provider: z.string(),
  model: z.string(),
  config: json,
});

export const scheduleSchema = z.object({
  id: z.string(),
  featureId: z.string().nullable(),
  prompt: z.string().nullable(),
  provider: z.string(),
  ephemeral: z.boolean(),
  cron: z.string().nullable(),
  runAt: isoDate.nullable(),
  /**
   * Carried as-is; import forces it false. A schedule that arrives live would
   * provision sandboxes and open PRs while the source instance still does the
   * same on its own timer.
   */
  enabled: z.boolean(),
});

export const messageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string(),
  messageType: z.string(),
  claudeMessageId: z.string().nullable(),
  costUsd: z.number().nullable(),
  agentRole: z.string().nullable(),
  createdAt: isoDate,
});

export const conversationSchema = z.object({
  id: z.string(),
  featureId: z.string().nullable(),
  sessionId: z.string(),
  name: z.string().nullable(),
  status: z.string(),
  agentId: z.string().nullable(),
  model: z.string(),
  permissionMode: z.string(),
  systemPrompt: z.string().nullable(),
  totalCostUsd: z.number(),
  messages: z.array(messageSchema),
});

export const projectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  workspacePath: portablePathSchema.nullable(),
  bootstrapType: z.string().nullable(),
  repositories: z.array(repositorySchema),
  stack: z.object({
    nodes: z.array(stackNodeSchema),
    edges: z.array(stackEdgeSchema),
  }),
  sandboxConfig: sandboxConfigSchema.nullable(),
  envVars: z.array(envVarSchema),
  brain: brainSchema.nullable(),
  phases: z.array(phaseSchema),
  devPhases: z.array(devPhaseSchema),
  features: z.array(featureSchema),
  document: documentSchema.nullable(),
  schedules: z.array(scheduleSchema),
  /** Join rows, by id — the catalogs themselves live at the top level. */
  skillIds: z.array(z.string()),
  agentIds: z.array(z.string()),
  agentSkills: z.array(
    z.object({ agentId: z.string(), skillId: z.string() }),
  ),
  conversations: z.array(conversationSchema),
});

export const exportDocumentSchema = z.object({
  meta: metaSchema,
  workspaces: z.array(workspaceSchema),
  credentials: z.array(credentialSchema),
  settings: z.array(settingSchema),
  catalogs: z.object({
    agents: z.array(agentSchema),
    skills: z.array(skillSchema),
    tools: z.array(toolSchema),
  }),
  projects: z.array(projectSchema),
});

export type ExportDocument = z.infer<typeof exportDocumentSchema>;
export type ExportMeta = z.infer<typeof metaSchema>;
export type ExportProject = z.infer<typeof projectSchema>;

/**
 * The encrypted form. `meta` is deliberately *not* mirrored outside the
 * envelope: version and scope are secrets-adjacent, and an importer has to
 * decrypt before it can decide anything anyway.
 */
export const encryptedEnvelopeSchema = z.object({
  nexuxExportVersion: z.number().int(),
  encrypted: z.literal(true),
  kdf: z.object({
    name: z.literal("scrypt"),
    N: z.number().int(),
    r: z.number().int(),
    p: z.number().int(),
    salt: z.string(),
  }),
  cipher: z.literal("aes-256-gcm"),
  iv: z.string(),
  tag: z.string(),
  payload: z.string(),
});

export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

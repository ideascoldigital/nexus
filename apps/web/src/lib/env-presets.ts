/**
 * Config-backed env var presets.
 *
 * The launcher already injects secrets from three places — allowlisted global
 * Settings, saved LLM/git/Claude credentials, and project env vars — but only
 * the last is visible and editable in the project's env editor. These helpers
 * expose the other two as *importable sources*, so a project can pin a specific
 * credential (e.g. the "claude-smart" token rather than whichever one resolves
 * by default) without the user having to paste the secret back in by hand.
 *
 * Copy semantics, matching from-stack (D-20): importing writes the value into
 * ProjectEnvVar. It does not create a live reference — rotating the credential
 * afterwards leaves the project's copy stale, and the copy outranks the
 * original at launch. Callers must say so in the UI.
 *
 * Plaintext never leaves the server on the listing path: `listEnvPresets`
 * returns masked values plus an opaque source id, and the import route resolves
 * the id back to a value here.
 */

import { prisma } from "@nexux/db";
import { GLOBAL_ENV_SETTINGS, LLM_CREDENTIAL_ENV } from "@nexux/sandbox";

import { GIT_TOKEN_ENV } from "@/lib/sandbox-manager";
import { getWorkspaceSetting } from "@/lib/workspace";

/** Which config surface a preset came from — drives grouping in the UI. */
export type EnvPresetGroup = "llm" | "settings" | "claude" | "git";

export type EnvPreset = {
  /** Opaque, stable id the client echoes back on import. */
  id: string;
  group: EnvPresetGroup;
  /** Env var this writes, e.g. ANTHROPIC_API_KEY. */
  key: string;
  /** Human label: the credential's name, or the Settings key it came from. */
  label: string;
  valueMasked: string;
};

/** Credential providers offered as presets, mapped to their env var. */
const CREDENTIAL_ENV: Record<string, string> = {
  ...LLM_CREDENTIAL_ENV,
  ...GIT_TOKEN_ENV,
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
};

function groupOf(provider: string): EnvPresetGroup {
  if (provider === "claude") return "claude";
  if (provider in GIT_TOKEN_ENV) return "git";
  return "llm";
}

/** CloudCredential.data is untyped Json; LLM keys and tokens live apart. */
function credentialSecret(provider: string, data: unknown): string | null {
  const d = (data ?? {}) as { token?: unknown; apiKey?: unknown };
  const raw = provider in LLM_CREDENTIAL_ENV ? d.apiKey : d.token;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function maskValue(value: string): string {
  return value.length > 4 ? "••••" + value.slice(-4) : "••••";
}

/**
 * Every credential/Settings row that could be copied into this project's env
 * vars, with values masked. Empty rows are dropped — an import that writes a
 * blank secret is worse than the key being absent.
 */
export async function listEnvPresets(
  workspaceId: string,
): Promise<EnvPreset[]> {
  const [credentials, settingRows] = await Promise.all([
    prisma.cloudCredential.findMany({
      where: { provider: { in: Object.keys(CREDENTIAL_ENV) } },
      select: { id: true, name: true, provider: true, data: true },
      orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
    }),
    // Workspace-scoped with default fallback, same resolution the launcher
    // uses — so the panel never offers a value a sandbox wouldn't receive.
    Promise.all(
      Object.keys(GLOBAL_ENV_SETTINGS).map(async (key) => {
        const row = await getWorkspaceSetting(workspaceId, key);
        return row?.value?.trim() ? { key, value: row.value } : null;
      }),
    ),
  ]);

  const presets: EnvPreset[] = [];

  for (const cred of credentials) {
    const key = CREDENTIAL_ENV[cred.provider];
    const secret = credentialSecret(cred.provider, cred.data);
    if (!key || !secret) continue;
    presets.push({
      id: `credential:${cred.id}`,
      group: groupOf(cred.provider),
      key,
      label: cred.name,
      valueMasked: maskValue(secret),
    });
  }

  for (const row of settingRows) {
    if (!row) continue;
    presets.push({
      id: `setting:${row.key}`,
      group: "settings",
      key: GLOBAL_ENV_SETTINGS[row.key],
      label: row.key,
      valueMasked: maskValue(row.value),
    });
  }

  return presets;
}

/**
 * Resolve preset ids back to the values to write. Unknown, deleted and
 * empty-valued ids are reported in `missing` rather than throwing, so one stale
 * id can't sink an otherwise valid import.
 *
 * Later ids win on a key collision: the client sends the list in display order,
 * and picking two presets for the same env var is a deliberate choice.
 */
export async function resolveEnvPresets(
  workspaceId: string,
  ids: string[],
): Promise<{
  entries: Array<{ key: string; value: string }>;
  missing: string[];
}> {
  const credentialIds = ids
    .filter((id) => id.startsWith("credential:"))
    .map((id) => id.slice("credential:".length));
  const settingKeys = ids
    .filter((id) => id.startsWith("setting:"))
    .map((id) => id.slice("setting:".length))
    .filter((key) => key in GLOBAL_ENV_SETTINGS);

  const [credentials, settings] = await Promise.all([
    credentialIds.length
      ? prisma.cloudCredential.findMany({
          where: { id: { in: credentialIds } },
          select: { id: true, provider: true, data: true },
        })
      : [],
    Promise.all(
      settingKeys.map(async (key) => {
        const row = await getWorkspaceSetting(workspaceId, key);
        return row?.value?.trim() ? ([key, row.value] as const) : null;
      }),
    ),
  ]);

  const credById = new Map(credentials.map((c) => [c.id, c]));
  const settingByKey = new Map(settings.filter((s) => s !== null));

  const byKey = new Map<string, string>();
  const missing: string[] = [];

  for (const id of ids) {
    if (id.startsWith("credential:")) {
      const cred = credById.get(id.slice("credential:".length));
      const envKey = cred ? CREDENTIAL_ENV[cred.provider] : null;
      const secret = cred ? credentialSecret(cred.provider, cred.data) : null;
      if (!envKey || !secret) {
        missing.push(id);
        continue;
      }
      byKey.set(envKey, secret);
    } else if (id.startsWith("setting:")) {
      const key = id.slice("setting:".length);
      const value = settingByKey.get(key);
      const envKey = GLOBAL_ENV_SETTINGS[key];
      if (!envKey || !value) {
        missing.push(id);
        continue;
      }
      byKey.set(envKey, value);
    } else {
      missing.push(id);
    }
  }

  return {
    entries: [...byKey].map(([key, value]) => ({ key, value })),
    missing,
  };
}

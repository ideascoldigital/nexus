// Client fetchers for /api/vault (spec 32). Secrets go in, never come back.

import type { PublicVaultItem, VaultCreateInput } from "@/lib/vault-items";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const listVault = () => call<PublicVaultItem[]>("/api/vault");

export const createVaultItem = (input: VaultCreateInput) =>
  call<PublicVaultItem>("/api/vault", { method: "POST", body: JSON.stringify(input) });

export type VaultUpdate = {
  name?: string;
  websites?: string[];
  username?: string | null;
  hint?: string | null;
  botIds?: string[] | null;
  /** Only non-empty fields replace the stored ones. */
  secret?: Record<string, string>;
};

export const updateVaultItem = (id: string, input: VaultUpdate) =>
  call<PublicVaultItem>(`/api/vault/${id}`, { method: "PATCH", body: JSON.stringify(input) });

export const deleteVaultItem = (id: string) => call<{ ok: true }>(`/api/vault/${id}`, { method: "DELETE" });

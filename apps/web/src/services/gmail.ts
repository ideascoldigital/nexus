// Client fetchers for the Gmail connector (spec 34). Tokens never reach the browser.

import type { GoogleAccount } from "@/services/google";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export type GoogleApp = { configured: boolean; clientId: string | null };

export const getGoogleApp = () => call<GoogleApp>("/api/google/app");

export const saveGoogleApp = (clientId: string, clientSecret: string) =>
  call<GoogleApp>("/api/google/app", { method: "PUT", body: JSON.stringify({ clientId, clientSecret }) });

export const startGoogleConnect = (loginHint?: string) =>
  call<{ url: string }>("/api/google/oauth/start", { method: "POST", body: JSON.stringify({ loginHint }) });

export const listGoogleAccounts = () => call<GoogleAccount[]>("/api/google/accounts");

export const setGoogleAccountBots = (id: string, botIds: string[] | null) =>
  call<GoogleAccount>(`/api/google/accounts/${id}`, { method: "PATCH", body: JSON.stringify({ botIds }) });

export const disconnectGoogleAccount = (id: string) => call<{ ok: true }>(`/api/google/accounts/${id}`, { method: "DELETE" });
